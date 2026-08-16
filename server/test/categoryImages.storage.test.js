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

import { createCategoryImageStorage } from '../src/storage/categoryImages.storage.js';
import { createProductImageStorage } from '../src/storage/productImages.storage.js';

async function temporaryRoot(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-category-images-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('stores and removes category images atomically in their own namespace', async (context) => {
  const root = await temporaryRoot(context);
  const storage = createCategoryImageStorage({
    rootDirectory: root,
    createRandomBytes: () => Buffer.alloc(16, 0xab),
  });
  const stored = await storage.store({
    buffer: Buffer.from('canonical category image'),
    extension: '.png',
  });
  const filename = `${'ab'.repeat(16)}.png`;

  assert.equal(stored.publicPath, `/uploads/categories/${filename}`);
  assert.deepEqual(await readFile(path.join(root, filename)), Buffer.from('canonical category image'));
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  assert.equal(await storage.remove(stored.publicPath), true);
  await assert.rejects(access(path.join(root, filename)), (error) => error.code === 'ENOENT');
  assert.equal(await storage.remove(stored.publicPath), true);
});

test('rejects traversal, encoded separators, foreign URLs, and malformed references', async (context) => {
  const parent = await temporaryRoot(context);
  const root = path.join(parent, 'categories');
  const outside = path.join(parent, 'outside.png');
  await writeFile(outside, 'must remain');
  const storage = createCategoryImageStorage({ rootDirectory: root });

  for (const candidate of [
    `/uploads/categories/${'ab'.repeat(16)}%2fescape.png`,
    '/uploads/categories/../../outside.png',
    `/uploads/products/${'ab'.repeat(16)}.png`,
    'https://example.com/image.png',
    outside,
    'C:\\outside.png',
    null,
  ]) {
    assert.equal(storage.resolveManagedPublicPath(candidate), null);
    assert.equal(await storage.remove(candidate), false);
  }

  assert.equal(await readFile(outside, 'utf8'), 'must remain');
});

test('keeps product and category ownership isolated even for identical random names', async (context) => {
  const parent = await temporaryRoot(context);
  const categoryRoot = path.join(parent, 'categories');
  const productRoot = path.join(parent, 'products');
  const randomName = () => Buffer.alloc(16, 0xcd);
  const categoryStorage = createCategoryImageStorage({
    rootDirectory: categoryRoot,
    createRandomBytes: randomName,
  });
  const productStorage = createProductImageStorage({
    rootDirectory: productRoot,
    createRandomBytes: randomName,
  });
  const category = await categoryStorage.store({
    buffer: Buffer.from('category'),
    extension: '.webp',
  });
  const product = await productStorage.store({
    buffer: Buffer.from('product'),
    extension: '.webp',
  });

  assert.equal(await categoryStorage.remove(product.publicPath), false);
  assert.equal(await productStorage.remove(category.publicPath), false);
  assert.equal(await readFile(categoryStorage.resolveManagedPublicPath(category.publicPath), 'utf8'), 'category');
  assert.equal(await readFile(productStorage.resolveManagedPublicPath(product.publicPath), 'utf8'), 'product');
});

test('does not allow callers to override either owned public namespace', () => {
  const categoryStorage = createCategoryImageStorage({
    publicPath: '/uploads/products',
  });
  const productStorage = createProductImageStorage({
    publicPath: '/uploads/categories',
  });

  assert.equal(
    categoryStorage.resolveManagedPublicPath(
      `/uploads/categories/${'ab'.repeat(16)}.png`,
    )?.endsWith(`${'ab'.repeat(16)}.png`),
    true,
  );
  assert.equal(
    categoryStorage.resolveManagedPublicPath(
      `/uploads/products/${'ab'.repeat(16)}.png`,
    ),
    null,
  );
  assert.equal(
    productStorage.resolveManagedPublicPath(
      `/uploads/products/${'cd'.repeat(16)}.jpg`,
    )?.endsWith(`${'cd'.repeat(16)}.jpg`),
    true,
  );
  assert.equal(
    productStorage.resolveManagedPublicPath(
      `/uploads/categories/${'cd'.repeat(16)}.jpg`,
    ),
    null,
  );
});

test('retries collisions without overwriting and leaves no half-written file', async (context) => {
  const root = await temporaryRoot(context);
  const firstName = Buffer.alloc(16, 0xef);
  const secondName = Buffer.alloc(16, 0x12);
  const originalStorage = createCategoryImageStorage({
    rootDirectory: root,
    createRandomBytes: () => firstName,
  });
  const original = await originalStorage.store({
    buffer: Buffer.from('original'),
    extension: '.jpg',
  });
  const names = [firstName, secondName];
  const retryingStorage = createCategoryImageStorage({
    rootDirectory: root,
    createRandomBytes: () => names.shift(),
  });
  const replacement = await retryingStorage.store({
    buffer: Buffer.from('replacement'),
    extension: '.jpg',
  });

  assert.notEqual(replacement.publicPath, original.publicPath);
  assert.equal(await readFile(originalStorage.resolveManagedPublicPath(original.publicPath), 'utf8'), 'original');
  assert.equal(await readFile(retryingStorage.resolveManagedPublicPath(replacement.publicPath), 'utf8'), 'replacement');
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});
