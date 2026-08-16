import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import {
  createValidJpeg,
  createValidPng,
  createValidWebp,
} from '../test-support/productImageFixtures.js';
import { configureTestEnvironment } from '../test-support/testEnvironment.js';

configureTestEnvironment();

const { createApp } = await import('../src/app.js');
const { maximumProductImageBytes } = await import('../src/config/productImages.js');
const { adminSessionCookieName } = await import('../src/routes/adminAuth.routes.js');

const validToken = 'a'.repeat(64);
const validCookie = `${adminSessionCookieName}=${validToken}`;
const [validJpeg, validPng, validWebp] = await Promise.all([
  createValidJpeg(),
  createValidPng(),
  createValidWebp(),
]);

function category(overrides = {}) {
  return {
    id: '1',
    name: 'Coffee',
    imagePath: null,
    sortOrder: 0,
    isVisible: true,
    createdAt: '2026-08-15T10:00:00.000Z',
    updatedAt: '2026-08-15T10:00:00.000Z',
    ...overrides,
  };
}

function createAuthService(counter = { calls: 0 }) {
  return {
    async getCurrentAdmin(token) {
      counter.calls += 1;
      return token === validToken ? { id: '1', username: 'admin' } : null;
    },
    async login() {
      throw new Error('Login is not used in category image tests.');
    },
    async logout() {},
  };
}

function createCategoriesService(counter = { calls: 0 }) {
  return {
    async list() {
      counter.calls += 1;
      return [];
    },
    async create() {
      counter.calls += 1;
      return category();
    },
    async update() {
      counter.calls += 1;
      return category();
    },
    async remove() {
      counter.calls += 1;
    },
  };
}

async function startServer(app) {
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function imageForm(buffer, filename, type, field = 'image') {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), filename);
  return form;
}

function authenticated(options = {}) {
  const headers = new Headers(options.headers);
  headers.set('cookie', validCookie);
  return { ...options, headers };
}

test('accepts real JPEG, PNG, and WebP through the production category image stack', async (context) => {
  const receivedImages = [];
  const imageService = {
    async assertExists() {},
    async replace(id, image) {
      receivedImages.push({ id, image });
      return category({ imagePath: `/uploads/categories/test${image.extension}` });
    },
    async remove() {
      return category();
    },
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminCategoryImagesService: imageService,
    adminCategoriesService: createCategoriesService(),
  });
  const server = await startServer(app);
  context.after(server.close);

  for (const [buffer, filename, type, format] of [
    [validJpeg, 'coffee.jpg', 'image/jpeg', 'jpeg'],
    [validPng, 'coffee.png', 'image/png', 'png'],
    [validWebp, 'coffee.webp', 'image/webp', 'webp'],
  ]) {
    const response = await fetch(
      `${server.baseUrl}/api/admin/categories/1/image`,
      authenticated({ method: 'PUT', body: imageForm(buffer, filename, type) }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.success, true);
    assert.equal(body.category.imagePath.endsWith(`.${format === 'jpeg' ? 'jpg' : format}`), true);
  }

  assert.equal(receivedImages.length, 3);
  for (const [index, expectedFormat] of ['jpeg', 'png', 'webp'].entries()) {
    const metadata = await sharp(receivedImages[index].image.buffer).metadata();
    assert.equal(metadata.format, expectedFormat);
    assert.equal(metadata.pages ?? 1, 1);
  }
});

test('replaces and deletes a category image with the expected response contract', async (context) => {
  const calls = [];
  const imageService = {
    async assertExists() {},
    async replace(id) {
      calls.push(['replace', id]);
      return category({ imagePath: '/uploads/categories/replaced.png' });
    },
    async remove(id) {
      calls.push(['remove', id]);
      return category({ imagePath: null });
    },
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminCategoryImagesService: imageService,
    adminCategoriesService: createCategoriesService(),
  });
  const server = await startServer(app);
  context.after(server.close);

  const put = await fetch(
    `${server.baseUrl}/api/admin/categories/1/image`,
    authenticated({
      method: 'PUT',
      body: imageForm(validPng, 'category.png', 'image/png'),
    }),
  );
  const remove = await fetch(
    `${server.baseUrl}/api/admin/categories/1/image`,
    authenticated({ method: 'DELETE' }),
  );

  assert.equal(put.status, 200);
  assert.equal((await put.json()).category.imagePath, '/uploads/categories/replaced.png');
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).category.imagePath, null);
  assert.deepEqual(calls, [['replace', '1'], ['remove', '1']]);
});

test('authenticates once before multipart parsing and rejects invalid tokens', async (context) => {
  const authCounter = { calls: 0 };
  let serviceCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(authCounter),
    adminCategoryImagesService: {
      async assertExists() {
        serviceCalls += 1;
      },
      async replace() {
        serviceCalls += 1;
      },
      async remove() {
        serviceCalls += 1;
      },
    },
    adminCategoriesService: createCategoriesService(),
  });
  const server = await startServer(app);
  context.after(server.close);

  for (const headers of [{}, { cookie: `${adminSessionCookieName}=invalid` }]) {
    const response = await fetch(`${server.baseUrl}/api/admin/categories/1/image`, {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'multipart/form-data; boundary=broken',
      },
      body: Buffer.alloc(maximumProductImageBytes + 1),
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  assert.equal(authCounter.calls, 2);
  assert.equal(serviceCalls, 0);
});

test('maps multipart, validation, id, missing-category, and internal failures safely', async (context) => {
  const missingError = Object.assign(new Error('Category not found'), {
    code: 'CATEGORY_NOT_FOUND',
    status: 404,
    isSafeToDisplay: true,
  });
  const imageService = {
    async assertExists(id) {
      if (id === '2') throw missingError;
    },
    async replace(id) {
      if (id === '3') throw new Error('sensitive SQL and filesystem path');
      return category();
    },
    async remove(id) {
      if (id === '2') throw missingError;
      if (id === '3') throw new Error('sensitive SQL and filesystem path');
      return category();
    },
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminCategoryImagesService: imageService,
    adminCategoriesService: createCategoriesService(),
  });
  const server = await startServer(app);
  context.after(server.close);

  const emptyForm = new FormData();
  const multiple = imageForm(validPng, 'one.png', 'image/png');
  multiple.append('image', new Blob([validPng], { type: 'image/png' }), 'two.png');
  const cases = [
    ['1', emptyForm, 400],
    ['1', imageForm(validPng, 'wrong.png', 'image/png', 'wrong'), 400],
    ['1', multiple, 400],
    ['1', imageForm(Buffer.from('not an image'), 'fake.png', 'image/png'), 400],
    ['1', imageForm(validPng.subarray(0, 20), 'broken.png', 'image/png'), 400],
    ['1', imageForm(Buffer.alloc(maximumProductImageBytes + 1), 'large.png', 'image/png'), 413],
    ['bad-id', imageForm(validPng, 'valid.png', 'image/png'), 400],
    ['2', imageForm(validPng, 'valid.png', 'image/png'), 404],
    ['2', imageForm(Buffer.from('not an image'), 'fake.png', 'image/png'), 404],
    ['3', imageForm(validPng, 'valid.png', 'image/png'), 500],
  ];

  for (const [id, body, status] of cases) {
    const response = await fetch(
      `${server.baseUrl}/api/admin/categories/${id}/image`,
      authenticated({ method: 'PUT', body }),
    );
    const responseBody = await response.json();

    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(responseBody).includes('sensitive'), false);
  }

  for (const [id, status] of [['2', 404], ['3', 500]]) {
    const response = await fetch(
      `${server.baseUrl}/api/admin/categories/${id}/image`,
      authenticated({ method: 'DELETE' }),
    );
    const responseBody = await response.json();

    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(responseBody).includes('sensitive'), false);
  }
});

test('OPTIONS is terminal with CORS and no-store and invokes no auth or parser', async (context) => {
  const authCounter = { calls: 0 };
  const categoryCounter = { calls: 0 };
  let imageCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(authCounter),
    adminCategoryImagesService: {
      async assertExists() { imageCalls += 1; },
      async replace() { imageCalls += 1; },
      async remove() { imageCalls += 1; },
    },
    adminCategoriesService: createCategoriesService(categoryCounter),
  });
  const server = await startServer(app);
  context.after(server.close);

  for (const suffix of ['', '?cache=no', '/']) {
    const response = await fetch(
      `${server.baseUrl}/api/admin/categories/1/image${suffix}`,
      {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'PUT',
        },
      },
    );

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(await response.text(), '');
  }

  assert.equal(authCounter.calls, 0);
  assert.equal(imageCalls, 0);
  assert.equal(categoryCounter.calls, 0);
});

test('HEAD, unsupported methods, and adjacent paths neither bypass nor duplicate auth', async (context) => {
  const authCounter = { calls: 0 };
  const categoryCounter = { calls: 0 };
  let imageCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(authCounter),
    adminCategoryImagesService: {
      async assertExists() { imageCalls += 1; },
      async replace() { imageCalls += 1; },
      async remove() { imageCalls += 1; },
    },
    adminCategoriesService: createCategoriesService(categoryCounter),
  });
  const server = await startServer(app);
  context.after(server.close);

  for (const [method, path] of [
    ['HEAD', '/api/admin/categories/1/image'],
    ['GET', '/api/admin/categories/1/image'],
    ['POST', '/api/admin/categories/1/image'],
    ['PATCH', '/api/admin/categories/1/image'],
    ['GET', '/api/admin/categories/1/image/extra'],
    ['GET', '/api/admin/categories/1/image/extra/more'],
  ]) {
    const before = authCounter.calls;
    const response = await fetch(
      `${server.baseUrl}${path}`,
      authenticated({ method }),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(authCounter.calls, before + 1);
  }

  assert.equal(imageCalls, 0);
  assert.equal(categoryCounter.calls, 0);
});

test('serves only the configured category image directory through its public namespace', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-category-static-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filename = `${'ab'.repeat(16)}.png`;
  const contents = Buffer.from('public category image');
  await writeFile(path.join(root, filename), contents);
  const app = createApp({
    adminAuthService: createAuthService(),
    adminCategoryImagesService: {
      async assertExists() {},
      async replace() { return category(); },
      async remove() { return category(); },
    },
    adminCategoriesService: createCategoriesService(),
    categoryImagesDirectory: root,
  });
  const server = await startServer(app);
  context.after(server.close);

  const categoryResponse = await fetch(
    `${server.baseUrl}/uploads/categories/${filename}`,
  );
  const productResponse = await fetch(
    `${server.baseUrl}/uploads/products/${filename}`,
  );

  assert.equal(categoryResponse.status, 200);
  assert.deepEqual(Buffer.from(await categoryResponse.arrayBuffer()), contents);
  assert.equal(productResponse.status, 404);
});
