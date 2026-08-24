import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminProductsService } from '../src/services/adminProducts.service.js';
import { createProductImageStorage } from '../src/storage/productImages.storage.js';

const maximumId = '18446744073709551615';
const managedImagePath = `/uploads/products/${'ab'.repeat(16)}.png`;

function productRow(overrides = {}) {
  return {
    id: maximumId,
    categoryId: '2',
    categoryName: 'Coffee',
    name: 'Espresso',
    description: null,
    price: '125000',
    imagePath: managedImagePath,
    sortOrder: 0,
    isAvailable: 1,
    isVisible: 1,
    ...overrides,
  };
}

function createDeleteHarness({
  lockedRows = [productRow()],
  failures = {},
  removeResult = true,
} = {}) {
  const events = [];
  const queries = [];
  const logs = [];
  const state = { productExists: true };
  let pendingDelete = false;
  let releaseCount = 0;
  let connectionCount = 0;
  const connection = {
    async beginTransaction() {
      events.push('beginTransaction');
      pendingDelete = false;
      if (failures.begin) throw failures.begin;
    },
    async execute(sql, parameters) {
      queries.push({ sql, parameters });

      if (sql.includes('FROM menu_items AS menuItems')) {
        events.push('lockProduct');
        if (failures.select) throw failures.select;
        return [lockedRows, []];
      }

      if (sql === 'DELETE FROM menu_items WHERE id = ?') {
        events.push('deleteProduct');
        if (failures.delete) throw failures.delete;
        pendingDelete = !failures.missingDelete;
        return [{ affectedRows: failures.missingDelete ? 0 : 1 }, []];
      }

      throw new Error(`Unexpected product deletion SQL: ${sql}`);
    },
    async commit() {
      events.push('commit');
      if (failures.commit) {
        if (failures.commitAppliedBeforeError && pendingDelete) {
          state.productExists = false;
        }

        throw failures.commit;
      }

      if (pendingDelete) {
        state.productExists = false;
      }
    },
    async rollback() {
      events.push('rollback');
      if (failures.rollback) throw failures.rollback;
    },
    destroy() {
      events.push('destroy');
    },
    release() {
      releaseCount += 1;
      events.push('release');
      if (failures.release) throw failures.release;
    },
  };
  const verificationConnection = {
    async execute(sql, parameters) {
      events.push('verifyProduct');
      queries.push({ sql, parameters });
      if (failures.verification) throw failures.verification;
      return [state.productExists ? lockedRows : [], []];
    },
    release() {
      events.push('releaseVerification');
    },
  };
  const executor = {
    async getConnection() {
      events.push('getConnection');
      if (failures.getConnection) throw failures.getConnection;
      connectionCount += 1;
      return connectionCount === 1 ? connection : verificationConnection;
    },
    async execute() {
      throw new Error('Product deletion must not query through the pool.');
    },
  };
  const storage = {
    async remove(publicPath) {
      events.push(`remove:${publicPath}`);
      if (failures.remove) throw failures.remove;
      return removeResult;
    },
  };
  const logger = {
    error(message, metadata) {
      logs.push({ message, metadata });
      if (failures.logger) throw failures.logger;
    },
  };

  return {
    events,
    executor,
    logger,
    logs,
    queries,
    state,
    storage,
    get releaseCount() {
      return releaseCount;
    },
  };
}

function createService(harness) {
  return createAdminProductsService({
    executor: harness.executor,
    productImageStorage: harness.storage,
    logger: harness.logger,
  });
}

test('deletes a product and its managed image in commit-safe order', async () => {
  const harness = createDeleteHarness();

  await createService(harness).remove(maximumId);

  assert.deepEqual(harness.events, [
    'getConnection',
    'beginTransaction',
    'lockProduct',
    'deleteProduct',
    'commit',
    'release',
    `remove:${managedImagePath}`,
  ]);
  assert.match(harness.queries[0].sql, /FOR UPDATE$/);
  assert.deepEqual(harness.queries[0].parameters, [maximumId]);
  assert.deepEqual(harness.queries[1], {
    sql: 'DELETE FROM menu_items WHERE id = ?',
    parameters: [maximumId],
  });
  assert.equal(harness.releaseCount, 1);
  assert.equal(harness.events.includes('rollback'), false);
});

test('preserves the image and primary error on every pre-commit failure', async (context) => {
  for (const failureName of [
    'getConnection',
    'begin',
    'select',
    'delete',
  ]) {
    await context.test(failureName, async () => {
      const primaryError = new Error(`${failureName} failed`);
      const harness = createDeleteHarness({
        failures: { [failureName]: primaryError },
      });

      await assert.rejects(
        createService(harness).remove(maximumId),
        (error) => error === primaryError,
      );
      assert.equal(
        harness.events.some((event) => event.startsWith('remove:')),
        false,
      );
      assert.equal(
        harness.events.includes('rollback'),
        !['getConnection', 'begin'].includes(failureName),
      );
      assert.equal(harness.releaseCount, failureName === 'getConnection' ? 0 : 1);
    });
  }
});

test('resolves a durable delete after commit acknowledgement loss', async () => {
  const commitError = Object.assign(new Error('commit acknowledgement lost'), {
    code: 'ECONNRESET',
  });
  const harness = createDeleteHarness({
    failures: {
      commit: commitError,
      commitAppliedBeforeError: true,
    },
  });

  await createService(harness).remove(maximumId);

  assert.equal(harness.state.productExists, false);
  assert.equal(harness.events.includes('rollback'), false);
  assert.equal(harness.events.includes('destroy'), true);
  assert.equal(
    harness.events.some((event) => event.startsWith('remove:')),
    true,
  );
});

test('preserves the product image when delete reconciliation is unknown', async () => {
  const commitError = new Error('commit acknowledgement lost');
  const harness = createDeleteHarness({
    failures: {
      commit: commitError,
      verification: new Error('verification unavailable'),
    },
  });

  await assert.rejects(
    createService(harness).remove(maximumId),
    (error) =>
      error instanceof AggregateError &&
      error.code === 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN' &&
      error.cause === commitError,
  );
  assert.equal(
    harness.events.some((event) => event.startsWith('remove:')),
    false,
  );
});

test('destroys a connection after rollback failure and retains the primary delete error', async () => {
  const primaryError = new Error('delete failed');
  const rollbackError = new Error('rollback failed');
  const harness = createDeleteHarness({
    failures: {
      delete: primaryError,
      rollback: rollbackError,
    },
  });

  await assert.rejects(
    createService(harness).remove(maximumId),
    (error) =>
      error instanceof AggregateError &&
      error.cause === primaryError &&
      error.errors[0] === primaryError &&
      error.errors[1] === rollbackError &&
      error.errors.length === 2,
  );
  assert.equal(harness.releaseCount, 0);
  assert.equal(harness.events.includes('destroy'), true);
  assert.equal(
    harness.events.some((event) => event.startsWith('remove:')),
    false,
  );
});

test('returns not found without deleting an image', async (context) => {
  for (const options of [
    { lockedRows: [] },
    { failures: { missingDelete: true } },
  ]) {
    await context.test(
      options.lockedRows ? 'missing locked row' : 'missing delete result',
      async () => {
        const harness = createDeleteHarness(options);

        await assert.rejects(
          createService(harness).remove(maximumId),
          (error) => error.status === 404 && error.code === 'PRODUCT_NOT_FOUND',
        );
        assert.equal(harness.events.includes('rollback'), true);
        assert.equal(harness.releaseCount, 1);
        assert.equal(
          harness.events.some((event) => event.startsWith('remove:')),
          false,
        );
      },
    );
  }
});

test('keeps a durable delete successful when release and file cleanup fail', async () => {
  const harness = createDeleteHarness({
    failures: {
      release: Object.assign(new Error('private release detail'), {
        code: 'RELEASE_FAILED',
      }),
      remove: Object.assign(new Error('C:\\private\\product.png'), {
        code: 'EACCES',
      }),
      logger: new Error('logger unavailable'),
    },
  });

  await createService(harness).remove(maximumId);

  assert.equal(harness.events.includes('rollback'), false);
  assert.equal(harness.releaseCount, 1);
  assert.equal(harness.logs.length, 2);
  assert.equal(JSON.stringify(harness.logs).includes('private'), false);
});

test('removes a real managed file after durable product deletion', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-product-delete-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => Buffer.alloc(16, 0xab),
  });
  const stored = await storage.store({
    buffer: Buffer.from('managed product image'),
    extension: '.png',
  });
  const harness = createDeleteHarness({
    lockedRows: [productRow({ imagePath: stored.publicPath })],
  });
  const service = createAdminProductsService({
    executor: harness.executor,
    productImageStorage: storage,
    logger: harness.logger,
  });
  const absolutePath = storage.resolveManagedPublicPath(stored.publicPath);

  await access(absolutePath);
  await service.remove(maximumId);
  await assert.rejects(access(absolutePath), (error) => error.code === 'ENOENT');
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  assert.deepEqual(await readdir(root), ['.tmp']);
});

test('keeps a real managed file when product deletion commit is not acknowledged', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-product-delete-failure-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => Buffer.alloc(16, 0xcd),
  });
  const stored = await storage.store({
    buffer: Buffer.from('active product image'),
    extension: '.jpg',
  });
  const commitError = new Error('commit failed');
  const harness = createDeleteHarness({
    lockedRows: [productRow({ imagePath: stored.publicPath })],
    failures: { commit: commitError },
  });
  const service = createAdminProductsService({
    executor: harness.executor,
    productImageStorage: storage,
    logger: harness.logger,
  });
  const absolutePath = storage.resolveManagedPublicPath(stored.publicPath);

  await assert.rejects(
    service.remove(maximumId),
    (error) => error === commitError,
  );
  await access(absolutePath);
  assert.equal(harness.events.includes('rollback'), false);
  assert.equal(harness.events.includes('destroy'), true);
});

test('never deletes an unmanaged path after product deletion', async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'riona-product-delete-unmanaged-'));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'products');
  const outside = path.join(parent, 'outside.png');
  await writeFile(outside, 'keep outside');
  const storage = createProductImageStorage({ rootDirectory: root });
  const harness = createDeleteHarness({
    lockedRows: [productRow({ imagePath: outside })],
  });
  const service = createAdminProductsService({
    executor: harness.executor,
    productImageStorage: storage,
    logger: harness.logger,
  });

  await service.remove(maximumId);

  assert.equal(await readFile(outside, 'utf8'), 'keep outside');
  assert.equal(harness.logs.length, 1);
  assert.equal(
    harness.logs[0].metadata.code,
    'PRODUCT_IMAGE_CLEANUP_REFUSED',
  );
  assert.equal(JSON.stringify(harness.logs).includes(outside), false);
});
