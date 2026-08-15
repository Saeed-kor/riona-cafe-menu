import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminProductImagesService } from '../src/services/adminProductImages.service.js';

const maximumId = '18446744073709551615';
const newImagePath = `/uploads/products/${'ab'.repeat(16)}.png`;
const oldImagePath = `/uploads/products/${'cd'.repeat(16)}.jpg`;

function productRow(overrides = {}) {
  return {
    id: maximumId,
    categoryId: '2',
    categoryName: 'Coffee',
    name: 'Espresso',
    description: null,
    price: '125000',
    imagePath: null,
    sortOrder: 3,
    isAvailable: 1,
    isVisible: 1,
    ...overrides,
  };
}

function createHarness({
  lockedRows = [productRow()],
  reloadRows = [productRow({ imagePath: newImagePath })],
  verificationRows = lockedRows,
  failures = {},
  removeFailures = new Map(),
} = {}) {
  const events = [];
  const queries = [];
  const logs = [];
  let releaseCount = 0;
  let useVerificationConnection = false;
  const connection = {
    async beginTransaction() {
      events.push('beginTransaction');

      if (failures.begin) {
        throw failures.begin;
      }
    },
    async execute(sql, parameters) {
      queries.push({ sql, parameters });

      if (sql.includes('FROM menu_items AS menuItems') && sql.includes('FOR UPDATE')) {
        events.push('lockProduct');

        if (failures.select) {
          throw failures.select;
        }

        return [lockedRows, []];
      }

      if (sql.startsWith('UPDATE menu_items')) {
        events.push('updateProduct');

        if (failures.update) {
          throw failures.update;
        }

        return [{ affectedRows: 1, changedRows: 1 }, []];
      }

      if (sql.includes('FROM menu_items AS menuItems')) {
        events.push('reloadProduct');

        if (failures.reload) {
          throw failures.reload;
        }

        return [reloadRows, []];
      }

      throw new Error(`Unexpected product image SQL: ${sql}`);
    },
    async commit() {
      events.push('commit');

      if (failures.commit) {
        failures.commitApplied?.();
        throw failures.commit;
      }
    },
    async rollback() {
      events.push('rollback');

      if (failures.rollback) {
        throw failures.rollback;
      }
    },
    destroy() {
      events.push('destroy');
      useVerificationConnection = true;
    },
    release() {
      releaseCount += 1;
      events.push('release');

      if (failures.release) {
        throw failures.release;
      }
    },
  };
  const verificationConnection = {
    async execute(sql, parameters) {
      queries.push({ sql, parameters });
      events.push('verifyProduct');

      if (failures.verification) {
        throw failures.verification;
      }

      return [verificationRows, []];
    },
    release() {
      releaseCount += 1;
      events.push('releaseVerification');
    },
  };
  const executor = {
    async getConnection() {
      if (useVerificationConnection) {
        useVerificationConnection = false;
        events.push('getVerificationConnection');
        return verificationConnection;
      }

      events.push('getConnection');

      if (failures.getConnection) {
        throw failures.getConnection;
      }

      return connection;
    },
    async execute() {
      throw new Error('Product image transactions must not query through the pool.');
    },
  };
  const storage = {
    async store() {
      events.push('storeNewImage');

      if (failures.store) {
        throw failures.store;
      }

      return { publicPath: newImagePath };
    },
    async remove(publicPath) {
      events.push(`remove:${publicPath}`);
      const failure = removeFailures.get(publicPath);

      if (failure) {
        throw failure;
      }

      return true;
    },
  };
  const logger = {
    error(message, metadata) {
      logs.push({ message, metadata });

      if (failures.logger) {
        throw failures.logger;
      }
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
  return createAdminProductImagesService({
    executor: harness.executor,
    storage: harness.storage,
    logger: harness.logger,
  });
}

test('uploads an image atomically and preserves an unsigned BIGINT id as a string', async () => {
  const harness = createHarness();
  const service = createService(harness);
  const image = { buffer: Buffer.from('image'), extension: '.png' };
  const product = await service.replace(maximumId, image);
  const lock = harness.queries[0];
  const update = harness.queries[1];
  const reload = harness.queries[2];

  assert.deepEqual(harness.events, [
    'storeNewImage',
    'getConnection',
    'beginTransaction',
    'lockProduct',
    'updateProduct',
    'reloadProduct',
    'commit',
    'release',
  ]);
  assert.match(lock.sql, /WHERE menuItems\.id = \?/);
  assert.match(lock.sql, /FOR UPDATE$/);
  assert.deepEqual(lock.parameters, [maximumId]);
  assert.equal(update.sql, 'UPDATE menu_items SET image_path = ? WHERE id = ?');
  assert.deepEqual(update.parameters, [newImagePath, maximumId]);
  assert.deepEqual(reload.parameters, [maximumId]);
  assert.equal(reload.sql.includes('FOR UPDATE'), false);
  assert.equal(product.id, maximumId);
  assert.equal(product.imagePath, newImagePath);
  assert.deepEqual(product, {
    id: maximumId,
    categoryId: '2',
    categoryName: 'Coffee',
    name: 'Espresso',
    description: null,
    price: '125000',
    imagePath: newImagePath,
    sortOrder: 3,
    isAvailable: true,
    isVisible: true,
  });
  assert.equal(harness.releaseCount, 1);
});

test('replaces the previous image only after commit and release', async () => {
  const harness = createHarness({
    lockedRows: [productRow({ imagePath: oldImagePath })],
  });
  const product = await createService(harness).replace(maximumId, {
    buffer: Buffer.from('image'),
    extension: '.png',
  });

  assert.equal(product.imagePath, newImagePath);
  assert.deepEqual(harness.events.slice(-3), [
    'commit',
    'release',
    `remove:${oldImagePath}`,
  ]);
  assert.equal(harness.events.includes(`remove:${newImagePath}`), false);
});

test('rejects storage and every pre-commit database failure while cleaning the new file', async (context) => {
  const cases = [
    ['getConnection', 'getConnection', ['storeNewImage', 'getConnection', `remove:${newImagePath}`]],
    ['begin', 'beginTransaction', ['storeNewImage', 'getConnection', 'beginTransaction', 'release', `remove:${newImagePath}`]],
    ['select', 'lockProduct', ['storeNewImage', 'getConnection', 'beginTransaction', 'lockProduct', 'rollback', 'release', `remove:${newImagePath}`]],
    ['update', 'updateProduct', ['storeNewImage', 'getConnection', 'beginTransaction', 'lockProduct', 'updateProduct', 'rollback', 'release', `remove:${newImagePath}`]],
    ['reload', 'reloadProduct', ['storeNewImage', 'getConnection', 'beginTransaction', 'lockProduct', 'updateProduct', 'reloadProduct', 'rollback', 'release', `remove:${newImagePath}`]],
    ['commit', 'commit', ['storeNewImage', 'getConnection', 'beginTransaction', 'lockProduct', 'updateProduct', 'reloadProduct', 'commit', 'destroy', 'getVerificationConnection', 'verifyProduct', 'releaseVerification', `remove:${newImagePath}`]],
  ];

  for (const [failureName, label, expectedEvents] of cases) {
    await context.test(label, async () => {
      const primaryError = new Error(`${label} failed`);
      const harness = createHarness({ failures: { [failureName]: primaryError } });

      await assert.rejects(
        createService(harness).replace(maximumId, {
          buffer: Buffer.from('image'),
          extension: '.png',
        }),
        (error) => error === primaryError,
      );
      assert.deepEqual(harness.events, expectedEvents);
      assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
      assert.equal(harness.releaseCount, failureName === 'getConnection' ? 0 : 1);
    });
  }

  await context.test('file storage failure does not acquire a connection', async () => {
    const primaryError = new Error('storage failed');
    const harness = createHarness({ failures: { store: primaryError } });

    await assert.rejects(
      createService(harness).replace(maximumId, {
        buffer: Buffer.from('image'),
        extension: '.png',
      }),
      (error) => error === primaryError,
    );
    assert.deepEqual(harness.events, ['storeNewImage']);
  });
});

test('rolls back and removes the new image when the product is missing or reload is empty', async (context) => {
  await context.test('missing product', async () => {
    const harness = createHarness({ lockedRows: [] });

    await assert.rejects(
      createService(harness).replace(maximumId, {
        buffer: Buffer.from('image'),
        extension: '.png',
      }),
      (error) => error.status === 404 && error.code === 'PRODUCT_NOT_FOUND',
    );
    assert.deepEqual(harness.events.slice(-3), [
      'rollback',
      'release',
      `remove:${newImagePath}`,
    ]);
  });

  await context.test('empty reload', async () => {
    const harness = createHarness({ reloadRows: [] });

    await assert.rejects(
      createService(harness).replace(maximumId, {
        buffer: Buffer.from('image'),
        extension: '.png',
      }),
      /Updated product image could not be loaded/,
    );
    assert.equal(harness.events.includes('commit'), false);
    assert.deepEqual(harness.events.slice(-3), [
      'rollback',
      'release',
      `remove:${newImagePath}`,
    ]);
  });
});

test('retains the primary failure when rollback, release, and new-file cleanup all fail', async () => {
  const primaryError = new Error('update failed');
  const rollbackError = new Error('rollback failed');
  const releaseError = new Error('release failed');
  const cleanupError = new Error('new image cleanup failed');
  const harness = createHarness({
    failures: {
      update: primaryError,
      rollback: rollbackError,
      release: releaseError,
    },
    removeFailures: new Map([[newImagePath, cleanupError]]),
  });

  await assert.rejects(
    createService(harness).replace(maximumId, {
      buffer: Buffer.from('image'),
      extension: '.png',
    }),
    (error) =>
      error instanceof AggregateError &&
      error.cause === primaryError &&
      error.errors[0] === primaryError &&
      error.errors[1] === rollbackError &&
      error.errors[2] === releaseError &&
      error.errors[3] === cleanupError,
  );
  assert.equal(harness.releaseCount, 1);
});

test('retains the primary failure when each pre-commit cleanup step fails alone', async (context) => {
  const cases = [
    ['rollback', { failures: { rollback: new Error('rollback failed') } }],
    ['release', { failures: { release: new Error('release failed') } }],
    [
      'new-file cleanup',
      {
        removeFailures: new Map([
          [newImagePath, new Error('new image cleanup failed')],
        ]),
      },
    ],
  ];

  for (const [label, failureOptions] of cases) {
    await context.test(label, async () => {
      const primaryError = new Error('update failed');
      const harness = createHarness({
        ...failureOptions,
        failures: {
          update: primaryError,
          ...failureOptions.failures,
        },
      });

      await assert.rejects(
        createService(harness).replace(maximumId, {
          buffer: Buffer.from('image'),
          extension: '.png',
        }),
        (error) =>
          error instanceof AggregateError &&
          error.cause === primaryError &&
          error.errors[0] === primaryError &&
          error.errors[1] ===
            (failureOptions.failures?.[label] ??
              failureOptions.removeFailures?.get(newImagePath)),
      );
      assert.equal(harness.releaseCount, 1);
      assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
    });
  }
});

test('resolves a durable replace despite release and previous-file cleanup failures', async () => {
  const releaseError = Object.assign(new Error('sensitive release detail'), {
    code: 'RELEASE_LISTENER_FAILED',
  });
  const removeError = Object.assign(new Error('C:\\secret\\old.jpg'), {
    code: 'EACCES',
  });
  const harness = createHarness({
    lockedRows: [productRow({ imagePath: oldImagePath })],
    failures: {
      release: releaseError,
      logger: new Error('logger failed'),
    },
    removeFailures: new Map([[oldImagePath, removeError]]),
  });
  const product = await createService(harness).replace(maximumId, {
    buffer: Buffer.from('image'),
    extension: '.png',
  });

  assert.equal(product.id, maximumId);
  assert.equal(product.imagePath, newImagePath);
  assert.equal(harness.events.filter((event) => event === 'rollback').length, 0);
  assert.equal(harness.events.filter((event) => event === 'release').length, 1);
  assert.equal(harness.releaseCount, 1);
  assert.equal(harness.events.at(-1), `remove:${oldImagePath}`);
  assert.equal(harness.logs.length, 2);
  assert.equal(JSON.stringify(harness.logs).includes('C:\\secret'), false);
  assert.equal(JSON.stringify(harness.logs).includes('sensitive release'), false);
});

test('resolves a durable replace when each post-commit cleanup step fails alone', async (context) => {
  await context.test('synchronous release failure', async () => {
    const harness = createHarness({
      lockedRows: [productRow({ imagePath: oldImagePath })],
      failures: { release: new Error('release listener failed') },
    });
    const product = await createService(harness).replace(maximumId, {
      buffer: Buffer.from('image'),
      extension: '.png',
    });

    assert.equal(product.imagePath, newImagePath);
    assert.equal(harness.releaseCount, 1);
    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.events.at(-1), `remove:${oldImagePath}`);
    assert.equal(harness.logs.length, 1);
  });

  await context.test('previous-file cleanup failure', async () => {
    const harness = createHarness({
      lockedRows: [productRow({ imagePath: oldImagePath })],
      removeFailures: new Map([[oldImagePath, new Error('old image cleanup failed')]]),
    });
    const product = await createService(harness).replace(maximumId, {
      buffer: Buffer.from('image'),
      extension: '.png',
    });

    assert.equal(product.imagePath, newImagePath);
    assert.equal(harness.releaseCount, 1);
    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.events.at(-1), `remove:${oldImagePath}`);
    assert.equal(harness.logs.length, 1);
  });

  await context.test('unmanaged previous path is refused and logged safely', async () => {
    const unmanagedPath = 'C:\\private\\legacy.jpg';
    const harness = createHarness({
      lockedRows: [productRow({ imagePath: unmanagedPath })],
    });
    harness.storage.remove = async (publicPath) => {
      harness.events.push(`remove:${publicPath}`);
      return false;
    };
    const product = await createService(harness).replace(maximumId, {
      buffer: Buffer.from('image'),
      extension: '.png',
    });

    assert.equal(product.imagePath, newImagePath);
    assert.equal(harness.releaseCount, 1);
    assert.equal(harness.events.at(-1), `remove:${unmanagedPath}`);
    assert.equal(harness.logs.length, 1);
    assert.equal(JSON.stringify(harness.logs).includes('C:\\private'), false);
    assert.equal(
      harness.logs[0].metadata.code,
      'PRODUCT_IMAGE_CLEANUP_REFUSED',
    );
  });
});

test('deletes an image transactionally and removes the old file only after commit', async () => {
  const harness = createHarness({
    lockedRows: [productRow({ imagePath: oldImagePath })],
    reloadRows: [productRow({ imagePath: null })],
  });
  const product = await createService(harness).remove(maximumId);
  const update = harness.queries.find((query) => query.sql.startsWith('UPDATE menu_items'));

  assert.equal(product.id, maximumId);
  assert.equal(product.imagePath, null);
  assert.equal(update.sql, 'UPDATE menu_items SET image_path = NULL WHERE id = ?');
  assert.deepEqual(update.parameters, [maximumId]);
  assert.deepEqual(harness.events, [
    'getConnection',
    'beginTransaction',
    'lockProduct',
    'updateProduct',
    'reloadProduct',
    'commit',
    'release',
    `remove:${oldImagePath}`,
  ]);
  assert.equal(harness.releaseCount, 1);
});

test('treats deleting an absent image as an idempotent success', async () => {
  const harness = createHarness({ lockedRows: [productRow({ imagePath: null })] });
  const product = await createService(harness).remove(maximumId);

  assert.equal(product.id, maximumId);
  assert.equal(product.imagePath, null);
  assert.deepEqual(harness.events, [
    'getConnection',
    'beginTransaction',
    'lockProduct',
    'commit',
    'release',
  ]);
});

test('rolls back failed deletes without removing the old file', async (context) => {
  for (const failureName of ['update', 'reload']) {
    await context.test(failureName, async () => {
      const primaryError = new Error(`${failureName} failed`);
      const harness = createHarness({
        lockedRows: [productRow({ imagePath: oldImagePath })],
        reloadRows: [productRow({ imagePath: null })],
        failures: { [failureName]: primaryError },
      });

      await assert.rejects(
        createService(harness).remove(maximumId),
        (error) => error === primaryError,
      );
      assert.equal(harness.events.includes('rollback'), true);
      assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
      assert.equal(harness.releaseCount, 1);
    });
  }

  await context.test('ambiguous commit', async () => {
    const commitError = Object.assign(new Error('commit acknowledgement lost'), {
      code: 'ECONNRESET',
    });
    let durableImagePath = oldImagePath;
    const harness = createHarness({
      lockedRows: [productRow({ imagePath: oldImagePath })],
      reloadRows: [productRow({ imagePath: null })],
      failures: {
        commit: commitError,
        commitApplied() {
          durableImagePath = null;
        },
      },
    });

    await assert.rejects(
      createService(harness).remove(maximumId),
      (error) =>
        error instanceof AggregateError &&
        error.code === 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN' &&
        error.cause === commitError,
    );
    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.events.includes('destroy'), true);
    assert.equal(durableImagePath, null);
    assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
  });

  await context.test('empty reload', async () => {
    const harness = createHarness({
      lockedRows: [productRow({ imagePath: oldImagePath })],
      reloadRows: [],
    });

    await assert.rejects(
      createService(harness).remove(maximumId),
      /Product without image could not be loaded/,
    );
    assert.equal(harness.events.includes('commit'), false);
    assert.equal(harness.events.includes(`remove:${oldImagePath}`), false);
  });
});

test('returns 404 for a missing product and survives post-commit delete cleanup failure', async (context) => {
  await context.test('missing product', async () => {
    const harness = createHarness({ lockedRows: [] });

    await assert.rejects(
      createService(harness).remove(maximumId),
      (error) => error.status === 404 && error.code === 'PRODUCT_NOT_FOUND',
    );
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'lockProduct',
      'rollback',
      'release',
    ]);
  });

  await context.test('post-commit cleanup failure', async () => {
    const cleanupError = Object.assign(new Error('private path'), { code: 'EACCES' });
    const harness = createHarness({
      lockedRows: [productRow({ imagePath: oldImagePath })],
      reloadRows: [productRow({ imagePath: null })],
      removeFailures: new Map([[oldImagePath, cleanupError]]),
    });
    const product = await createService(harness).remove(maximumId);

    assert.equal(product.imagePath, null);
    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.releaseCount, 1);
    assert.equal(harness.logs.length, 1);
    assert.equal(JSON.stringify(harness.logs).includes('private path'), false);
  });
});
