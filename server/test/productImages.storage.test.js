import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductImageStorage } from '../src/storage/productImages.storage.js';

async function createTemporaryRoot(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-product-images-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('stores, serves a canonical public path, and removes a real staged file', async (context) => {
  const root = await createTemporaryRoot(context);
  const storage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => Buffer.alloc(16, 0xab),
  });
  const image = { buffer: Buffer.from('image bytes'), extension: '.png' };
  const stored = await storage.store(image);
  const expectedName = `${'ab'.repeat(16)}.png`;
  const expectedPath = path.join(root, expectedName);

  assert.equal(stored.publicPath, `/uploads/products/${expectedName}`);
  assert.deepEqual(await readFile(expectedPath), image.buffer);
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  assert.equal(storage.resolveManagedPublicPath(stored.publicPath), expectedPath);
  assert.equal(await storage.remove(stored.publicPath), true);
  await assert.rejects(readFile(expectedPath), (error) => error.code === 'ENOENT');
});

test('never resolves or deletes paths outside the managed storage root', async (context) => {
  const parent = await createTemporaryRoot(context);
  const root = path.join(parent, 'products');
  const outside = path.join(parent, 'outside.png');
  await mkdir(root, { recursive: true });
  await writeFile(outside, 'keep me');
  const storage = createProductImageStorage({ rootDirectory: root });

  for (const candidate of [
    '/uploads/products/../../outside.png',
    '/uploads/products/not-random.png',
    outside,
    'C:\\outside.png',
    null,
  ]) {
    assert.equal(storage.resolveManagedPublicPath(candidate), null);
    assert.equal(await storage.remove(candidate), false);
  }

  assert.equal(await readFile(outside, 'utf8'), 'keep me');
});

test('rejects non-canonical storage input before constructing a path', async (context) => {
  const root = await createTemporaryRoot(context);
  const storage = createProductImageStorage({ rootDirectory: root });

  for (const image of [
    { buffer: Buffer.from('image'), extension: '../../outside.png' },
    { buffer: Buffer.from('image'), extension: '.svg' },
    { buffer: 'not a buffer', extension: '.png' },
  ]) {
    await assert.rejects(storage.store(image), /storage input is invalid/);
  }

  assert.deepEqual(await readdir(root), []);
});

test('cleans its temporary file when collision-safe publish fails', async (context) => {
  const root = await createTemporaryRoot(context);
  const publishError = new Error('publish failed');
  const storage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => Buffer.alloc(16, 0xcd),
    fileSystem: {
      mkdir,
      writeFile,
      async link() {
        throw publishError;
      },
      rm,
    },
  });

  await assert.rejects(
    storage.store({ buffer: Buffer.from('image'), extension: '.jpg' }),
    (error) => error === publishError,
  );
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  assert.deepEqual(await readdir(root), ['.tmp']);
});

test('preserves a write failure and leaves no temporary file', async (context) => {
  const root = await createTemporaryRoot(context);
  const writeError = new Error('write failed');
  const storage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => Buffer.alloc(16, 0xde),
    fileSystem: {
      mkdir,
      async writeFile() {
        throw writeError;
      },
      link,
      rm,
    },
  });

  await assert.rejects(
    storage.store({ buffer: Buffer.from('image'), extension: '.png' }),
    (error) => error === writeError,
  );
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  assert.deepEqual(await readdir(root), ['.tmp']);
});

test('preserves the publish failure when owned temporary cleanup also fails', async () => {
  const publishError = new Error('publish failed');
  const cleanupError = new Error('cleanup failed');
  const storage = createProductImageStorage({
    rootDirectory: path.join(tmpdir(), 'unused-riona-storage'),
    createRandomBytes: () => Buffer.alloc(16, 0xef),
    fileSystem: {
      async mkdir() {},
      async writeFile() {},
      async link() {
        throw publishError;
      },
      async rm() {
        throw cleanupError;
      },
    },
  });

  await assert.rejects(
    storage.store({ buffer: Buffer.from('image'), extension: '.webp' }),
    (error) =>
      error instanceof AggregateError &&
      error.cause === publishError &&
      error.errors[0] === publishError &&
      error.errors[1] === cleanupError,
  );
});

test('cleans owned files after a post-publish temp removal failure', async (context) => {
  const root = await createTemporaryRoot(context);
  const randomName = Buffer.alloc(16, 0x44);
  const randomHex = randomName.toString('hex');
  const temporaryPath = path.join(root, '.tmp', `${randomHex}.tmp`);
  const finalPath = path.join(root, `${randomHex}.webp`);
  const unrelatedName = `${'55'.repeat(16)}.png`;
  const unrelatedPath = path.join(root, unrelatedName);
  const unrelatedContents = Buffer.from('unrelated file must remain byte-for-byte');
  const primaryError = Object.assign(new Error('initial temp removal failed'), {
    code: 'EACCES',
  });
  const secondaryError = Object.assign(new Error('cleanup reported a failure'), {
    code: 'EIO',
  });
  let temporaryRemovalAttempts = 0;
  await writeFile(unrelatedPath, unrelatedContents, { flag: 'wx' });
  const storage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => randomName,
    fileSystem: {
      link,
      mkdir,
      writeFile,
      async rm(target, options) {
        if (target === temporaryPath) {
          temporaryRemovalAttempts += 1;

          if (temporaryRemovalAttempts === 1) {
            throw primaryError;
          }

          await rm(target, options);
          throw secondaryError;
        }

        return rm(target, options);
      },
    },
  });

  await assert.rejects(
    storage.store({
      buffer: Buffer.from('published payload'),
      extension: '.webp',
    }),
    (error) =>
      error instanceof AggregateError &&
      error.cause === primaryError &&
      error.errors[0] === primaryError &&
      error.errors[1] === secondaryError,
  );

  assert.equal(temporaryRemovalAttempts, 2);
  await assert.rejects(readFile(temporaryPath), (error) => error.code === 'ENOENT');
  await assert.rejects(readFile(finalPath), (error) => error.code === 'ENOENT');
  assert.deepEqual(await readFile(unrelatedPath), unrelatedContents);
  assert.deepEqual((await readdir(root)).sort(), ['.tmp', unrelatedName].sort());
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});

test('retries a final-name collision without overwriting the existing file', async (context) => {
  const root = await createTemporaryRoot(context);
  const firstName = Buffer.alloc(16, 0xab);
  const secondName = Buffer.alloc(16, 0xcd);
  const existingStorage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => firstName,
  });
  const existing = await existingStorage.store({
    buffer: Buffer.from('existing image'),
    extension: '.png',
  });
  const names = [firstName, secondName];
  const retryingStorage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => names.shift(),
  });
  const stored = await retryingStorage.store({
    buffer: Buffer.from('new image'),
    extension: '.png',
  });

  assert.notEqual(stored.publicPath, existing.publicPath);
  assert.equal(
    await readFile(existingStorage.resolveManagedPublicPath(existing.publicPath), 'utf8'),
    'existing image',
  );
  assert.equal(
    await readFile(retryingStorage.resolveManagedPublicPath(stored.publicPath), 'utf8'),
    'new image',
  );
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});

test('exhausts repeated collisions without overwriting or deleting the existing file', async (context) => {
  const root = await createTemporaryRoot(context);
  const repeatedName = Buffer.alloc(16, 0xef);
  const existingStorage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes: () => repeatedName,
  });
  const existing = await existingStorage.store({
    buffer: Buffer.from('keep existing'),
    extension: '.webp',
  });
  let attempts = 0;
  const collidingStorage = createProductImageStorage({
    rootDirectory: root,
    createRandomBytes() {
      attempts += 1;
      return repeatedName;
    },
  });

  await assert.rejects(
    collidingStorage.store({
      buffer: Buffer.from('must not publish'),
      extension: '.webp',
    }),
    (error) => error.code === 'PRODUCT_IMAGE_NAME_COLLISION',
  );
  assert.equal(attempts, 5);
  assert.equal(
    await readFile(existingStorage.resolveManagedPublicPath(existing.publicPath), 'utf8'),
    'keep existing',
  );
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});
