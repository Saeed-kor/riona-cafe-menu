import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createValidJpeg, createValidPng } from '../test-support/productImageFixtures.js';
import { createAdminCategoriesService } from '../src/services/adminCategories.service.js';
import { createAdminCategoryImagesService } from '../src/services/adminCategoryImages.service.js';
import { createCategoryImageStorage } from '../src/storage/categoryImages.storage.js';

const categoryId = '1';

function categoryRow(imagePath) {
  return {
    id: categoryId,
    name: 'Coffee',
    imagePath,
    sortOrder: 0,
    isVisible: 1,
    createdAt: new Date('2026-08-15T10:00:00.000Z'),
    updatedAt: new Date('2026-08-15T10:00:00.000Z'),
  };
}

function createExecutor() {
  const state = { imagePath: null };

  function selectRows() {
    return [[categoryRow(state.imagePath)], []];
  }

  return {
    state,
    executor: {
      async getConnection() {
        let snapshot = state.imagePath;

        return {
          async beginTransaction() {
            snapshot = state.imagePath;
          },
          async execute(sql, parameters) {
            if (sql.startsWith('UPDATE categories SET image_path = NULL')) {
              state.imagePath = null;
              return [{ affectedRows: 1 }, []];
            }

            if (sql.startsWith('UPDATE categories SET image_path = ?')) {
              state.imagePath = parameters[0];
              return [{ affectedRows: 1 }, []];
            }

            if (sql.includes('FROM categories')) {
              return selectRows();
            }

            throw new Error(`Unexpected filesystem test SQL: ${sql}`);
          },
          async commit() {},
          async rollback() {
            state.imagePath = snapshot;
          },
          destroy() {},
          release() {},
        };
      },
      async execute(sql) {
        if (sql.includes('FROM categories')) {
          return selectRows();
        }

        throw new Error(`Unexpected pool SQL: ${sql}`);
      },
    },
  };
}

test('persists, replaces, reloads, and removes real category image files', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-category-lifecycle-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const names = [Buffer.alloc(16, 0xab), Buffer.alloc(16, 0xcd)];
  const storage = createCategoryImageStorage({
    rootDirectory: root,
    createRandomBytes: () => names.shift(),
  });
  const database = createExecutor();
  const imageService = createAdminCategoryImagesService({
    executor: database.executor,
    storage,
    logger: { error() {} },
  });
  const first = await imageService.replace(categoryId, {
    buffer: await createValidPng(),
    extension: '.png',
  });
  const firstAbsolutePath = storage.resolveManagedPublicPath(first.imagePath);

  await access(firstAbsolutePath);
  const second = await imageService.replace(categoryId, {
    buffer: await createValidJpeg(),
    extension: '.jpg',
  });
  const secondAbsolutePath = storage.resolveManagedPublicPath(second.imagePath);

  await assert.rejects(access(firstAbsolutePath), (error) => error.code === 'ENOENT');
  await access(secondAbsolutePath);

  const restartedCategoriesService = createAdminCategoriesService({
    executor: database.executor,
  });
  const [reloaded] = await restartedCategoriesService.list();
  assert.equal(reloaded.imagePath, second.imagePath);

  const removed = await imageService.remove(categoryId);
  assert.equal(removed.imagePath, null);
  assert.equal(database.state.imagePath, null);
  await assert.rejects(access(secondAbsolutePath), (error) => error.code === 'ENOENT');
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});

test('serializes concurrent replace and category deletion without deleting the wrong image', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-category-concurrency-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const names = [Buffer.alloc(16, 0xab), Buffer.alloc(16, 0xcd)];
  const storage = createCategoryImageStorage({
    rootDirectory: root,
    createRandomBytes: () => names.shift(),
  });
  const original = await storage.store({
    buffer: await createValidPng(),
    extension: '.png',
  });
  const state = { exists: true, imagePath: original.publicPath };
  let lockOwner = null;
  const lockWaiters = [];
  let signalFirstLock;
  let releaseFirstLock;
  let signalSecondWaiter;
  const firstLockAcquired = new Promise((resolve) => { signalFirstLock = resolve; });
  const firstLockGate = new Promise((resolve) => { releaseFirstLock = resolve; });
  const secondLockWaiting = new Promise((resolve) => { signalSecondWaiter = resolve; });
  let lockAttempts = 0;

  async function acquireLock(connection) {
    lockAttempts += 1;

    if (lockOwner === null) {
      lockOwner = connection;
      signalFirstLock();
      await firstLockGate;
      return;
    }

    signalSecondWaiter();
    await new Promise((resolve) => lockWaiters.push({ connection, resolve }));
  }

  function releaseLock(connection) {
    if (lockOwner !== connection) return;
    const waiter = lockWaiters.shift();

    if (waiter) {
      lockOwner = waiter.connection;
      waiter.resolve();
    } else {
      lockOwner = null;
    }
  }

  const executor = {
    async getConnection() {
      const connection = {
        local: null,
        ownsLock: false,
        async beginTransaction() {},
        async execute(sql, parameters) {
          if (sql.includes('FROM categories') && sql.includes('FOR UPDATE')) {
            await acquireLock(connection);
            connection.ownsLock = true;
            connection.local = { ...state };
            return [
              connection.local.exists
                ? [categoryRow(connection.local.imagePath)]
                : [],
              [],
            ];
          }

          if (sql.startsWith('UPDATE categories SET image_path = ?')) {
            connection.local.imagePath = parameters[0];
            return [{ affectedRows: 1 }, []];
          }

          if (sql === 'DELETE FROM categories WHERE id = ?') {
            connection.local.exists = false;
            return [{ affectedRows: 1 }, []];
          }

          if (sql.includes('FROM categories')) {
            return [
              connection.local.exists
                ? [categoryRow(connection.local.imagePath)]
                : [],
              [],
            ];
          }

          throw new Error(`Unexpected concurrency test SQL: ${sql}`);
        },
        async commit() {
          Object.assign(state, connection.local);
          releaseLock(connection);
          connection.ownsLock = false;
        },
        async rollback() {
          releaseLock(connection);
          connection.ownsLock = false;
        },
        destroy() {
          releaseLock(connection);
          connection.ownsLock = false;
        },
        release() {
          releaseLock(connection);
          connection.ownsLock = false;
        },
      };

      return connection;
    },
  };
  const imageService = createAdminCategoryImagesService({
    executor,
    storage,
    logger: { error() {} },
  });
  const categoriesService = createAdminCategoriesService({
    executor,
    categoryImageStorage: storage,
    logger: { error() {} },
  });
  const replacementPromise = imageService.replace(categoryId, {
    buffer: await createValidJpeg(),
    extension: '.jpg',
  });

  await firstLockAcquired;
  const deletionPromise = categoriesService.remove(categoryId);
  await secondLockWaiting;
  assert.equal(lockAttempts, 2);
  assert.equal(state.imagePath, original.publicPath);
  releaseFirstLock();

  const replacement = await replacementPromise;
  await deletionPromise;

  assert.equal(state.exists, false);
  assert.notEqual(replacement.imagePath, original.publicPath);
  await assert.rejects(
    access(storage.resolveManagedPublicPath(original.publicPath)),
    (error) => error.code === 'ENOENT',
  );
  await assert.rejects(
    access(storage.resolveManagedPublicPath(replacement.imagePath)),
    (error) => error.code === 'ENOENT',
  );
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});
