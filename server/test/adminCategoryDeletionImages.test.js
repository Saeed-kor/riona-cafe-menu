import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminCategoriesService } from '../src/services/adminCategories.service.js';

const categoryId = '18446744073709551615';
const imagePath = `/uploads/categories/${'ab'.repeat(16)}.png`;

function categoryRow(overrides = {}) {
  return {
    id: categoryId,
    name: 'Coffee',
    imagePath,
    sortOrder: 0,
    isVisible: 1,
    createdAt: new Date('2026-08-15T10:00:00.000Z'),
    updatedAt: new Date('2026-08-15T10:00:00.000Z'),
    ...overrides,
  };
}

function createHarness({
  lockedRows = [categoryRow()],
  verificationRows = lockedRows,
  affectedRows = 1,
  failures = {},
} = {}) {
  const events = [];
  const queries = [];
  const logs = [];
  let verificationNext = false;

  const connection = {
    async beginTransaction() {
      events.push('begin');
      if (failures.begin) throw failures.begin;
    },
    async execute(sql, parameters) {
      queries.push({ sql, parameters });

      if (sql.includes('FROM categories') && sql.includes('FOR UPDATE')) {
        events.push('lockCategory');
        if (failures.select) throw failures.select;
        return [lockedRows, []];
      }

      if (sql === 'DELETE FROM categories WHERE id = ?') {
        events.push('deleteCategory');
        if (failures.delete) throw failures.delete;
        return [{ affectedRows }, []];
      }

      throw new Error(`Unexpected category deletion SQL: ${sql}`);
    },
    async commit() {
      events.push('commit');
      failures.commitApplied?.();
      if (failures.commit) throw failures.commit;
    },
    async rollback() {
      events.push('rollback');
      if (failures.rollback) throw failures.rollback;
    },
    destroy() {
      events.push('destroy');
      verificationNext = true;
    },
    release() {
      events.push('release');
      if (failures.release) throw failures.release;
    },
  };

  const verificationConnection = {
    async execute(sql, parameters) {
      queries.push({ sql, parameters });
      events.push('verifyCategory');
      if (failures.verification) throw failures.verification;
      return [verificationRows, []];
    },
    release() {
      events.push('releaseVerification');
      if (failures.verificationRelease) throw failures.verificationRelease;
    },
  };

  const executor = {
    async getConnection() {
      if (verificationNext) {
        verificationNext = false;
        events.push('getVerificationConnection');
        return verificationConnection;
      }

      events.push('getConnection');
      return connection;
    },
    async execute() {
      throw new Error('Category deletion must not use pool queries.');
    },
  };

  const storage = {
    async remove(publicPath) {
      events.push(`remove:${publicPath}`);
      if (failures.cleanup) throw failures.cleanup;
      return failures.cleanupRefused ? false : true;
    },
  };
  const logger = {
    error(message, metadata) {
      logs.push({ message, metadata });
      if (failures.logger) throw failures.logger;
    },
  };

  return { events, executor, logger, logs, queries, storage };
}

function service(harness) {
  return createAdminCategoriesService({
    executor: harness.executor,
    categoryImageStorage: harness.storage,
    logger: harness.logger,
  });
}

test('deletes a category under a row lock and cleans its image only after commit', async () => {
  const harness = createHarness();
  await service(harness).remove(categoryId);

  assert.deepEqual(harness.events, [
    'getConnection',
    'begin',
    'lockCategory',
    'deleteCategory',
    'commit',
    'release',
    `remove:${imagePath}`,
  ]);
  assert.match(harness.queries[0].sql, /FOR UPDATE$/u);
  assert.deepEqual(harness.queries[1].parameters, [categoryId]);
});

test('deletes a category without an image without invoking storage cleanup', async () => {
  const harness = createHarness({ lockedRows: [categoryRow({ imagePath: null })] });
  await service(harness).remove(categoryId);
  assert.equal(harness.events.some((event) => event.startsWith('remove:')), false);
});

test('preserves the image when a product constraint or another pre-commit step rejects deletion', async (context) => {
  const foreignKeyError = Object.assign(new Error('sensitive constraint detail'), {
    code: 'ER_ROW_IS_REFERENCED_2',
    errno: 1451,
  });
  const conflict = createHarness({ failures: { delete: foreignKeyError } });

  await assert.rejects(
    service(conflict).remove(categoryId),
    (error) =>
      error.status === 409 &&
      error.code === 'CATEGORY_HAS_MENU_ITEMS' &&
      error.message.includes('sensitive') === false,
  );
  assert.equal(conflict.events.includes('rollback'), true);
  assert.equal(conflict.events.some((event) => event.startsWith('remove:')), false);

  for (const [name, options] of [
    ['missing row', { lockedRows: [] }],
    ['zero affected rows', { affectedRows: 0 }],
    ['select failure', { failures: { select: new Error('select failed') } }],
  ]) {
    await context.test(name, async () => {
      const harness = createHarness(options);
      await assert.rejects(service(harness).remove(categoryId));
      assert.equal(harness.events.includes('rollback'), true);
      assert.equal(harness.events.some((event) => event.startsWith('remove:')), false);
    });
  }
});

test('verifies ambiguous category deletion commits with an independent connection', async (context) => {
  const commitError = Object.assign(new Error('commit acknowledgement lost'), {
    code: 'ECONNRESET',
  });

  await context.test('committed', async () => {
    const harness = createHarness({
      verificationRows: [],
      failures: { commit: commitError },
    });
    await service(harness).remove(categoryId);

    assert.equal(harness.events.includes('destroy'), true);
    assert.equal(harness.events.includes('getVerificationConnection'), true);
    assert.equal(harness.events.includes(`remove:${imagePath}`), true);
    assert.equal(harness.logs.some((entry) => entry.metadata.operation === 'commit-acknowledgement'), true);
  });

  await context.test('not committed', async () => {
    const harness = createHarness({ failures: { commit: commitError } });
    await assert.rejects(
      service(harness).remove(categoryId),
      (error) => error === commitError,
    );
    assert.equal(harness.events.includes(`remove:${imagePath}`), false);
  });

  await context.test('unknown', async () => {
    const verificationError = new Error('verification unavailable');
    const harness = createHarness({
      failures: { commit: commitError, verification: verificationError },
    });
    await assert.rejects(
      service(harness).remove(categoryId),
      (error) =>
        error instanceof AggregateError &&
        error.code === 'CATEGORY_DELETE_COMMIT_OUTCOME_UNKNOWN' &&
        error.cause === commitError,
    );
    assert.equal(harness.events.includes(`remove:${imagePath}`), false);
  });
});

test('does not let rollback, release, or cleanup failures hide the primary outcome', async (context) => {
  await context.test('pre-commit failures remain aggregated under the primary error', async () => {
    const primaryError = new Error('delete failed');
    const rollbackError = new Error('rollback failed');
    const harness = createHarness({
      failures: {
        delete: primaryError,
        rollback: rollbackError,
      },
    });

    await assert.rejects(
      service(harness).remove(categoryId),
      (error) =>
        error instanceof AggregateError &&
        error.cause === primaryError &&
        error.errors.includes(rollbackError),
    );
    assert.equal(harness.events.includes('destroy'), true);
    assert.equal(harness.events.includes('release'), false);
    assert.equal(harness.events.includes(`remove:${imagePath}`), false);
  });

  await context.test('release failure remains aggregated after a successful rollback', async () => {
    const primaryError = new Error('delete failed');
    const releaseError = new Error('release failed');
    const harness = createHarness({
      failures: { delete: primaryError, release: releaseError },
    });

    await assert.rejects(
      service(harness).remove(categoryId),
      (error) =>
        error instanceof AggregateError &&
        error.cause === primaryError &&
        error.errors.includes(releaseError),
    );
    assert.equal(harness.events.includes('release'), true);
    assert.equal(harness.events.includes('destroy'), false);
    assert.equal(harness.events.includes(`remove:${imagePath}`), false);
  });

  await context.test('durable delete survives cleanup and release failures', async () => {
    const harness = createHarness({
      failures: {
        release: new Error('release failed'),
        cleanup: new Error('cleanup failed'),
      },
    });
    await service(harness).remove(categoryId);

    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.logs.length, 2);
    assert.equal(
      harness.logs.some((entry) => Object.hasOwn(entry.metadata, 'message')),
      false,
    );
  });
});

test('delegates cleanup to category storage, which refuses a product image path', async () => {
  const productPath = `/uploads/products/${'ef'.repeat(16)}.jpg`;
  const harness = createHarness({
    lockedRows: [categoryRow({ imagePath: productPath })],
    failures: { cleanupRefused: true },
  });
  await service(harness).remove(categoryId);

  assert.deepEqual(
    harness.events.filter((event) => event.startsWith('remove:')),
    [`remove:${productPath}`],
  );
  assert.equal(harness.logs[0].metadata.code, 'CATEGORY_IMAGE_CLEANUP_REFUSED');
});
