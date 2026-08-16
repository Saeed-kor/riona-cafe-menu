import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminCategoryImagesService } from '../src/services/adminCategoryImages.service.js';

const categoryId = '18446744073709551615';
const newImagePath = `/uploads/categories/${'ab'.repeat(16)}.png`;
const oldImagePath = `/uploads/categories/${'cd'.repeat(16)}.jpg`;

function categoryRow(overrides = {}) {
  return {
    id: categoryId,
    name: 'Coffee',
    imagePath: null,
    sortOrder: 2,
    isVisible: 1,
    createdAt: new Date('2026-08-15T10:00:00.000Z'),
    updatedAt: new Date('2026-08-15T10:00:00.000Z'),
    ...overrides,
  };
}

function createHarness({
  lockedRows = [categoryRow()],
  reloadRows = [categoryRow({ imagePath: newImagePath })],
  verificationRows = lockedRows,
  failures = {},
  removeFailures = new Map(),
} = {}) {
  const events = [];
  const queries = [];
  const logs = [];
  let verificationNext = false;
  let releaseCount = 0;

  const connection = {
    async beginTransaction() {
      events.push('begin');
      if (failures.begin) throw failures.begin;
    },
    async execute(sql, parameters) {
      queries.push({ sql, parameters });

      if (sql.includes('FROM categories') && sql.includes('FOR UPDATE')) {
        events.push('lock');
        if (failures.select) throw failures.select;
        return [lockedRows, []];
      }

      if (sql.startsWith('UPDATE categories')) {
        events.push('update');
        if (failures.update) throw failures.update;
        return [{ affectedRows: 1 }, []];
      }

      if (sql.includes('FROM categories')) {
        events.push('reload');
        if (failures.reload) throw failures.reload;
        return [reloadRows, []];
      }

      throw new Error(`Unexpected category image SQL: ${sql}`);
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
      releaseCount += 1;
      events.push('release');
      if (failures.release) throw failures.release;
    },
  };

  const verificationConnection = {
    async execute(sql, parameters) {
      queries.push({ sql, parameters });
      events.push('verify');
      if (failures.verification) throw failures.verification;
      return [verificationRows, []];
    },
    release() {
      releaseCount += 1;
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
      if (failures.getConnection) throw failures.getConnection;
      return connection;
    },
    async execute() {
      throw new Error('Category image transactions must not query through the pool.');
    },
  };

  const storage = {
    async store() {
      events.push('storeNew');
      if (failures.store) throw failures.store;
      return { publicPath: newImagePath };
    },
    async remove(publicPath) {
      events.push(`remove:${publicPath}`);
      const failure = removeFailures.get(publicPath);
      if (failure) throw failure;
      return true;
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
    storage,
    get releaseCount() {
      return releaseCount;
    },
  };
}

function createService(harness) {
  return createAdminCategoryImagesService({
    executor: harness.executor,
    storage: harness.storage,
    logger: harness.logger,
  });
}

test('checks category existence with a parameterized production query', async () => {
  const calls = [];
  const executor = {
    async execute(sql, parameters) {
      calls.push({ sql, parameters });
      return [[categoryRow()], []];
    },
  };
  const service = createAdminCategoryImagesService({ executor });
  const result = await service.assertExists(categoryId);

  assert.equal(result.id, categoryId);
  assert.deepEqual(calls[0].parameters, [categoryId]);
  assert.match(calls[0].sql, /WHERE id = \?/u);

  const missingService = createAdminCategoryImagesService({
    executor: { async execute() { return [[], []]; } },
  });
  await assert.rejects(
    missingService.assertExists(categoryId),
    (error) => error.status === 404 && error.code === 'CATEGORY_NOT_FOUND',
  );
});

test('uploads and replaces a category image with row locking and one connection', async () => {
  const harness = createHarness({
    lockedRows: [categoryRow({ imagePath: oldImagePath })],
  });
  const result = await createService(harness).replace(categoryId, {
    buffer: Buffer.from('canonical'),
    extension: '.png',
  });

  assert.equal(result.id, categoryId);
  assert.equal(result.imagePath, newImagePath);
  assert.deepEqual(harness.events, [
    'storeNew',
    'getConnection',
    'begin',
    'lock',
    'update',
    'reload',
    'commit',
    'release',
    `remove:${oldImagePath}`,
  ]);
  assert.match(harness.queries[0].sql, /FOR UPDATE$/u);
  assert.deepEqual(harness.queries[1].parameters, [newImagePath, categoryId]);
});

test('uploads an initial category image without attempting previous-file cleanup', async () => {
  const harness = createHarness();
  const result = await createService(harness).replace(categoryId, {
    buffer: Buffer.from('canonical'),
    extension: '.png',
  });

  assert.equal(result.imagePath, newImagePath);
  assert.equal(
    harness.events.some((event) => event.startsWith('remove:')),
    false,
  );
});

test('rolls back every pre-commit category image failure and removes only the staged file', async (context) => {
  for (const failureName of ['begin', 'select', 'update', 'reload']) {
    await context.test(failureName, async () => {
      const primaryError = new Error(`${failureName} failed`);
      const harness = createHarness({ failures: { [failureName]: primaryError } });

      await assert.rejects(
        createService(harness).replace(categoryId, {
          buffer: Buffer.from('canonical'),
          extension: '.png',
        }),
        (error) => error === primaryError,
      );
      assert.equal(harness.events.includes(`remove:${newImagePath}`), true);
      assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
      assert.equal(harness.events.includes('commit'), false);
    });
  }

  const missing = createHarness({ lockedRows: [] });
  await assert.rejects(
    createService(missing).replace(categoryId, {
      buffer: Buffer.from('canonical'),
      extension: '.png',
    }),
    (error) => error.status === 404 && error.code === 'CATEGORY_NOT_FOUND',
  );
  assert.equal(missing.events.includes('rollback'), true);
  assert.equal(missing.events.includes(`remove:${newImagePath}`), true);
});

test('distinguishes committed, not-committed, and unknown replace outcomes', async (context) => {
  const commitError = Object.assign(new Error('commit acknowledgement lost'), {
    code: 'ECONNRESET',
  });

  await context.test('committed', async () => {
    const harness = createHarness({
      lockedRows: [categoryRow({ imagePath: oldImagePath })],
      verificationRows: [categoryRow({ imagePath: newImagePath })],
      failures: { commit: commitError },
    });
    const result = await createService(harness).replace(categoryId, {
      buffer: Buffer.from('canonical'),
      extension: '.png',
    });

    assert.equal(result.imagePath, newImagePath);
    assert.equal(harness.events.includes('getVerificationConnection'), true);
    assert.equal(harness.events.includes(`remove:${oldImagePath}`), true);
    assert.equal(harness.events.includes(`remove:${newImagePath}`), false);
  });

  await context.test('not committed', async () => {
    const harness = createHarness({
      lockedRows: [categoryRow({ imagePath: oldImagePath })],
      verificationRows: [categoryRow({ imagePath: oldImagePath })],
      failures: { commit: commitError },
    });

    await assert.rejects(
      createService(harness).replace(categoryId, {
        buffer: Buffer.from('canonical'),
        extension: '.png',
      }),
      (error) => error === commitError,
    );
    assert.equal(harness.events.includes(`remove:${newImagePath}`), true);
    assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
  });

  await context.test('unknown', async () => {
    const verificationError = new Error('verification unavailable');
    const harness = createHarness({
      lockedRows: [categoryRow({ imagePath: oldImagePath })],
      failures: { commit: commitError, verification: verificationError },
    });

    await assert.rejects(
      createService(harness).replace(categoryId, {
        buffer: Buffer.from('canonical'),
        extension: '.png',
      }),
      (error) =>
        error instanceof AggregateError &&
        error.code === 'CATEGORY_IMAGE_COMMIT_OUTCOME_UNKNOWN' &&
        error.cause === commitError,
    );
    assert.equal(harness.events.some((event) => event.startsWith('remove:')), false);
  });
});

test('deletes category images idempotently and verifies an ambiguous commit independently', async (context) => {
  await context.test('normal and idempotent delete', async () => {
    const harness = createHarness({
      lockedRows: [categoryRow({ imagePath: oldImagePath })],
      reloadRows: [categoryRow({ imagePath: null })],
    });
    const result = await createService(harness).remove(categoryId);

    assert.equal(result.imagePath, null);
    assert.equal(harness.events.includes(`remove:${oldImagePath}`), true);
    assert.equal(harness.events.indexOf('commit') < harness.events.indexOf(`remove:${oldImagePath}`), true);
  });

  await context.test('verified committed', async () => {
    const commitError = new Error('commit acknowledgement lost');
    const harness = createHarness({
      lockedRows: [categoryRow({ imagePath: oldImagePath })],
      reloadRows: [categoryRow({ imagePath: null })],
      verificationRows: [categoryRow({ imagePath: null })],
      failures: { commit: commitError },
    });
    const result = await createService(harness).remove(categoryId);

    assert.equal(result.imagePath, null);
    assert.equal(harness.events.includes('getVerificationConnection'), true);
    assert.equal(harness.events.includes(`remove:${oldImagePath}`), true);
  });

  await context.test('missing category', async () => {
    const harness = createHarness({ lockedRows: [] });

    await assert.rejects(
      createService(harness).remove(categoryId),
      (error) => error.status === 404 && error.code === 'CATEGORY_NOT_FOUND',
    );
    assert.equal(harness.events.includes('rollback'), true);
    assert.equal(
      harness.events.some((event) => event.startsWith('remove:')),
      false,
    );
  });

  await context.test('not committed and unknown preserve the old file', async () => {
    const commitError = new Error('commit acknowledgement lost');

    for (const [verificationRows, failures, expectedCode] of [
      [[categoryRow({ imagePath: oldImagePath })], { commit: commitError }, null],
      [[], { commit: commitError }, 'CATEGORY_IMAGE_COMMIT_OUTCOME_UNKNOWN'],
    ]) {
      const harness = createHarness({
        lockedRows: [categoryRow({ imagePath: oldImagePath })],
        reloadRows: [categoryRow({ imagePath: null })],
        verificationRows,
        failures,
      });

      await assert.rejects(
        createService(harness).remove(categoryId),
        (error) => expectedCode === null
          ? error === commitError
          : error.code === expectedCode,
      );
      assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
    }
  });
});

test('preserves primary errors and disposes connections after rollback failure', async (context) => {
  await context.test('rollback and staged-file cleanup failures', async () => {
    const primaryError = new Error('update failed');
    const rollbackError = new Error('rollback failed');
    const cleanupError = new Error('cleanup failed');
    const harness = createHarness({
      failures: { update: primaryError, rollback: rollbackError },
      removeFailures: new Map([[newImagePath, cleanupError]]),
    });

    await assert.rejects(
      createService(harness).replace(categoryId, {
        buffer: Buffer.from('canonical'),
        extension: '.png',
      }),
      (error) =>
        error instanceof AggregateError &&
        error.cause === primaryError &&
        error.errors[0] === primaryError &&
        error.errors.includes(rollbackError) &&
        error.errors.includes(cleanupError),
    );
    assert.equal(harness.events.includes('destroy'), true);
    assert.equal(harness.events.includes('release'), false);
  });

  await context.test('release and staged-file cleanup failures', async () => {
    const primaryError = new Error('update failed');
    const releaseError = new Error('release failed');
    const cleanupError = new Error('cleanup failed');
    const harness = createHarness({
      failures: { update: primaryError, release: releaseError },
      removeFailures: new Map([[newImagePath, cleanupError]]),
    });

    await assert.rejects(
      createService(harness).replace(categoryId, {
        buffer: Buffer.from('canonical'),
        extension: '.png',
      }),
      (error) =>
        error instanceof AggregateError &&
        error.cause === primaryError &&
        error.errors.includes(releaseError) &&
        error.errors.includes(cleanupError),
    );
    assert.equal(harness.events.includes('release'), true);
    assert.equal(harness.events.includes('destroy'), false);
  });
});
