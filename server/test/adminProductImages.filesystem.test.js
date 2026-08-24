import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminProductImagesService } from '../src/services/adminProductImages.service.js';
import { createProductImageStorage } from '../src/storage/productImages.storage.js';

const productId = '18446744073709551615';

function createExecutor(initialImagePath = null) {
  const state = { imagePath: initialImagePath };
  const failures = {
    commit: null,
    commitAppliedBeforeError: false,
    verification: null,
  };
  let pendingImagePath = initialImagePath;
  let useVerificationConnection = false;

  function row(imagePath) {
    return {
      id: productId,
      categoryId: '2',
      categoryName: 'Coffee',
      name: 'Espresso',
      description: null,
      price: '125000',
      imagePath,
      sortOrder: 0,
      isAvailable: 1,
      isVisible: 1,
    };
  }

  const connection = {
    async beginTransaction() {
      pendingImagePath = state.imagePath;
    },
    async execute(sql, parameters) {
      if (sql.includes('FROM menu_items AS menuItems')) {
        return [[row(pendingImagePath)], []];
      }

      if (sql === 'UPDATE menu_items SET image_path = ? WHERE id = ?') {
        assert.equal(parameters[1], productId);
        pendingImagePath = parameters[0];
        return [{ affectedRows: 1, changedRows: 1 }, []];
      }

      throw new Error(`Unexpected filesystem integration SQL: ${sql}`);
    },
    async commit() {
      if (failures.commit) {
        if (failures.commitAppliedBeforeError) {
          state.imagePath = pendingImagePath;
        }

        throw failures.commit;
      }

      state.imagePath = pendingImagePath;
    },
    async rollback() {
      pendingImagePath = state.imagePath;
    },
    destroy() {
      useVerificationConnection = true;
    },
    release() {},
  };
  const verificationConnection = {
    async execute(sql) {
      if (!sql.includes('FROM menu_items AS menuItems')) {
        throw new Error(`Unexpected verification SQL: ${sql}`);
      }

      if (failures.verification) {
        throw failures.verification;
      }

      return [[row(state.imagePath)], []];
    },
    release() {},
  };

  return {
    executor: {
      async getConnection() {
        if (useVerificationConnection) {
          useVerificationConnection = false;
          return verificationConnection;
        }

        return connection;
      },
    },
    failures,
    state,
  };
}

async function createTemporaryStorage(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-image-lifecycle-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const storage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes() {
      sequence += 1;
      return Buffer.alloc(16, sequence);
    },
  });

  return { root, storage };
}

function absolutePath(storage, publicPath) {
  const resolved = storage.resolveManagedPublicPath(publicPath);
  assert.ok(resolved);
  return resolved;
}

test('creates and replaces real files while refusing independent image deletion', async (context) => {
  const { root, storage } = await createTemporaryStorage(context);
  const database = createExecutor();
  const service = createAdminProductImagesService({
    executor: database.executor,
    storage,
    logger: { error() {} },
  });

  const uploaded = await service.replace(productId, {
    buffer: Buffer.from('first image'),
    extension: '.png',
  });
  const firstPath = uploaded.imagePath;
  await access(absolutePath(storage, firstPath));
  assert.equal(database.state.imagePath, firstPath);

  const replaced = await service.replace(productId, {
    buffer: Buffer.from('second image'),
    extension: '.webp',
  });
  const secondPath = replaced.imagePath;
  assert.notEqual(secondPath, firstPath);
  await assert.rejects(access(absolutePath(storage, firstPath)), (error) => error.code === 'ENOENT');
  await access(absolutePath(storage, secondPath));
  assert.equal(database.state.imagePath, secondPath);

  await assert.rejects(
    service.remove(productId),
    (error) =>
      error.code === 'PRODUCT_IMAGE_REQUIRED' &&
      error.status === 409 &&
      error.isSafeToDisplay === true &&
      error.message === 'Product image is required; replace the image instead',
  );
  assert.equal(database.state.imagePath, secondPath);
  await access(absolutePath(storage, secondPath));
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  assert.deepEqual((await readdir(root)).sort(), [
    '.tmp',
    path.basename(absolutePath(storage, secondPath)),
  ].sort());
});

test('keeps the active file and removes the staged replacement after commit failure', async (context) => {
  const { root, storage } = await createTemporaryStorage(context);
  const database = createExecutor();
  const service = createAdminProductImagesService({
    executor: database.executor,
    storage,
    logger: { error() {} },
  });
  const uploaded = await service.replace(productId, {
    buffer: Buffer.from('active image'),
    extension: '.jpg',
  });
  const activePath = uploaded.imagePath;
  database.failures.commit = new Error('commit failed');

  await assert.rejects(
    service.replace(productId, {
      buffer: Buffer.from('staged replacement'),
      extension: '.png',
    }),
    /commit failed/,
  );

  assert.equal(database.state.imagePath, activePath);
  await access(absolutePath(storage, activePath));
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  assert.deepEqual(await readdir(root), [
    '.tmp',
    path.basename(absolutePath(storage, activePath)),
  ]);
});

test('keeps the newly referenced file when COMMIT is durable but its promise rejects', async (context) => {
  const { root, storage } = await createTemporaryStorage(context);
  const database = createExecutor();
  const service = createAdminProductImagesService({
    executor: database.executor,
    storage,
    logger: { error() {} },
  });
  const uploaded = await service.replace(productId, {
    buffer: Buffer.from('active image'),
    extension: '.jpg',
  });
  const activePath = uploaded.imagePath;
  const commitError = Object.assign(
    new Error('connection lost after COMMIT reached MariaDB'),
    { code: 'ECONNRESET' },
  );
  database.failures.commit = commitError;
  database.failures.commitAppliedBeforeError = true;

  const verified = await service.replace(productId, {
    buffer: Buffer.from('durably referenced replacement'),
    extension: '.png',
  });

  const committedPath = `/uploads/products/${'02'.repeat(16)}.png`;
  assert.equal(verified.imagePath, committedPath);
  assert.equal(database.state.imagePath, committedPath);
  await access(absolutePath(storage, committedPath));
  await assert.rejects(
    access(absolutePath(storage, activePath)),
    (error) => error.code === 'ENOENT',
  );
  assert.deepEqual((await readdir(root)).sort(), [
    '.tmp',
    path.basename(absolutePath(storage, committedPath)),
  ].sort());
});

test('preserves both possible files when independent commit verification fails', async (context) => {
  const { root, storage } = await createTemporaryStorage(context);
  const database = createExecutor();
  const service = createAdminProductImagesService({
    executor: database.executor,
    storage,
    logger: { error() {} },
  });
  const uploaded = await service.replace(productId, {
    buffer: Buffer.from('active image'),
    extension: '.jpg',
  });
  const activePath = uploaded.imagePath;
  const commitError = Object.assign(new Error('commit acknowledgement lost'), {
    code: 'ECONNRESET',
  });
  const verificationError = Object.assign(new Error('fresh connection unavailable'), {
    code: 'ETIMEDOUT',
  });
  database.failures.commit = commitError;
  database.failures.verification = verificationError;

  await assert.rejects(
    service.replace(productId, {
      buffer: Buffer.from('possibly referenced replacement'),
      extension: '.png',
    }),
    (error) =>
      error instanceof AggregateError &&
      error.code === 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN' &&
      error.cause === commitError &&
      error.errors[0] === commitError &&
      error.errors[1] === verificationError,
  );

  const stagedPath = `/uploads/products/${'02'.repeat(16)}.png`;
  assert.equal(database.state.imagePath, activePath);
  await access(absolutePath(storage, activePath));
  await access(absolutePath(storage, stagedPath));
  assert.deepEqual((await readdir(root)).sort(), [
    '.tmp',
    path.basename(absolutePath(storage, activePath)),
    path.basename(absolutePath(storage, stagedPath)),
  ].sort());
});
