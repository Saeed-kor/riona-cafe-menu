import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';
import { configureTestEnvironment } from '../test-support/testEnvironment.js';

configureTestEnvironment();

const { createApp } = await import('../src/app.js');
const { maximumProductImageBytes } = await import('../src/config/productImages.js');
const { adminSessionCookieName } = await import('../src/routes/adminAuth.routes.js');
const { createAdminProductImagesService } = await import(
  '../src/services/adminProductImages.service.js'
);
const { createProductImageStorage } = await import(
  '../src/storage/productImages.storage.js'
);
const {
  corruptPngCrc,
  createAnimatedWebp,
  createPngWithExactSize,
  createValidJpeg,
  createValidPng,
  createValidWebp,
} = await import('../test-support/productImageFixtures.js');

const validToken = 'a'.repeat(64);
const validCookie = `${adminSessionCookieName}=${validToken}`;
const [validJpeg, validPng, validWebp, animatedWebp] = await Promise.all([
  createValidJpeg(),
  createValidPng(),
  createValidWebp(),
  createAnimatedWebp(),
]);

function product(overrides = {}) {
  return {
    id: '18446744073709551615',
    categoryId: '2',
    categoryName: 'Coffee',
    name: 'Espresso',
    description: null,
    price: '125000',
    imagePath: `/uploads/products/${'ef'.repeat(16)}.webp`,
    sortOrder: 0,
    isAvailable: true,
    isVisible: true,
    ...overrides,
  };
}

function createAuthService(onCurrentAdmin = () => {}) {
  return {
    async getCurrentAdmin(token) {
      onCurrentAdmin();
      return token === validToken ? { id: '1', username: 'admin' } : null;
    },
    async login() {
      throw new Error('Login is not used in product image route tests.');
    },
    async logout() {},
  };
}

async function startTestServer(app) {
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

function imageForm({
  buffer = validPng,
  field = 'image',
  filename = 'coffee.png',
  mimeType = 'image/png',
  secondFile = false,
} = {}) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type: mimeType }), filename);

  if (secondFile) {
    form.append(field, new Blob([buffer], { type: mimeType }), `second-${filename}`);
  }

  return form;
}

test('authenticates before multipart parsing and applies no-store to 401', async (context) => {
  let serviceCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: {
      async replace() { serviceCalls += 1; },
      async remove() { serviceCalls += 1; },
    },
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/admin/products/1/image`,
    {
      method: 'PUT',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: 'this is deliberately malformed',
    },
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    success: false,
    message: 'Authentication required',
  });
  assert.equal(serviceCalls, 0);

  const oversizedResponse = await fetch(
    `${server.baseUrl}/api/admin/products/1/image`,
    {
      method: 'PUT',
      body: imageForm({ buffer: Buffer.alloc(maximumProductImageBytes + 1) }),
    },
  );

  assert.equal(oversizedResponse.status, 401);
  assert.equal(oversizedResponse.headers.get('cache-control'), 'no-store');
  assert.equal(serviceCalls, 0);
});

test('uploads images and rejects independent deletion through the real middleware stack', async (context) => {
  const calls = [];
  let authCalls = 0;
  const uploadedProduct = product({ imagePath: `/uploads/products/${'ab'.repeat(16)}.png` });
  const app = createApp({
    adminAuthService: createAuthService(() => { authCalls += 1; }),
    adminProductImagesService: {
      async replace(id, image) {
        calls.push({ operation: 'replace', id, image });
        return uploadedProduct;
      },
      async remove(id) {
        calls.push({ operation: 'remove', id });
        return product();
      },
    },
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const uploadResponse = await fetch(
    `${server.baseUrl}/api/admin/products/18446744073709551615/image`,
    {
      method: 'PUT',
      headers: { cookie: validCookie },
      body: imageForm(),
    },
  );

  assert.equal(uploadResponse.status, 200);
  assert.equal(uploadResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await uploadResponse.json(), {
    success: true,
    product: uploadedProduct,
  });
  assert.equal(calls[0].id, '18446744073709551615');
  assert.equal(calls[0].image.extension, '.png');
  assert.equal(calls[0].image.mimeType, 'image/png');

  const deleteResponse = await fetch(
    `${server.baseUrl}/api/admin/products/18446744073709551615/image`,
    { method: 'DELETE', headers: { cookie: validCookie } },
  );

  assert.equal(deleteResponse.status, 409);
  assert.equal(deleteResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await deleteResponse.json(), {
    success: false,
    message: 'Product image is required; replace the image instead',
  });
  assert.equal(calls.length, 1);
  assert.equal(authCalls, 2);
});

test('uses exact image authentication without falling through or reauthenticating adjacent paths', async (context) => {
  let authCalls = 0;
  let productListCalls = 0;
  let productRemoveCalls = 0;
  let imageReplaceCalls = 0;
  let imageRemoveCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(() => { authCalls += 1; }),
    adminProductImagesService: {
      async replace() {
        imageReplaceCalls += 1;
        throw new Error('Image replace must not run.');
      },
      async remove() {
        imageRemoveCalls += 1;
        throw new Error('Image remove must not run.');
      },
    },
    adminProductsService: {
      async list() {
        productListCalls += 1;
        return [];
      },
      async create() { throw new Error('Product create must not run.'); },
      async update(id) { return product({ id }); },
      async remove() { productRemoveCalls += 1; },
    },
  });
  const server = await startTestServer(app);
  context.after(server.close);

  for (const method of ['GET', 'POST', 'PATCH']) {
    const callsBefore = authCalls;
    const response = await fetch(
      `${server.baseUrl}/api/admin/products/1/image`,
      { method, headers: { cookie: validCookie } },
    );

    assert.equal(response.status, 404, method);
    assert.equal(response.headers.get('cache-control'), 'no-store', method);
    assert.deepEqual(await response.json(), {
      success: false,
      message: 'Route not found',
    });
    assert.equal(authCalls - callsBefore, 1, method);
    assert.equal(productListCalls, 0, method);
  }

  const callsBeforeHead = authCalls;
  const headResponse = await fetch(
    `${server.baseUrl}/api/admin/products/1/image`,
    { method: 'HEAD', headers: { cookie: validCookie } },
  );
  assert.equal(headResponse.status, 404);
  assert.equal(headResponse.headers.get('cache-control'), 'no-store');
  assert.equal(await headResponse.text(), '');
  assert.equal(authCalls - callsBeforeHead, 1);

  for (const suffix of ['extra', 'extra/more']) {
    const callsBefore = authCalls;
    const response = await fetch(
      `${server.baseUrl}/api/admin/products/1/image/${suffix}`,
      { headers: { cookie: validCookie } },
    );

    assert.equal(response.status, 404, suffix);
    assert.equal(response.headers.get('cache-control'), 'no-store', suffix);
    assert.equal(authCalls - callsBefore, 1, suffix);
  }

  const callsBeforeProductList = authCalls;
  const productResponse = await fetch(`${server.baseUrl}/api/admin/products`, {
    headers: { cookie: validCookie },
  });

  assert.equal(productResponse.status, 200);
  assert.deepEqual(await productResponse.json(), { success: true, products: [] });
  assert.equal(authCalls - callsBeforeProductList, 1);
  assert.equal(productListCalls, 1);

  const callsBeforeProductPut = authCalls;
  const productPut = await fetch(`${server.baseUrl}/api/admin/products/1`, {
    method: 'PUT',
    headers: { cookie: validCookie },
  });
  assert.equal(productPut.status, 404);
  assert.equal(authCalls - callsBeforeProductPut, 1);

  const callsBeforeProductDelete = authCalls;
  const productDelete = await fetch(`${server.baseUrl}/api/admin/products/1`, {
    method: 'DELETE',
    headers: { cookie: validCookie },
  });
  assert.equal(productDelete.status, 200);
  assert.equal(authCalls - callsBeforeProductDelete, 1);
  assert.equal(productRemoveCalls, 1);

  const callsBeforeUnknown = authCalls;
  const unknownResponse = await fetch(
    `${server.baseUrl}/api/admin/products/unknown/route`,
    { headers: { cookie: validCookie } },
  );
  assert.equal(unknownResponse.status, 404);
  assert.equal(authCalls - callsBeforeUnknown, 1);

  const callsBeforeOptions = authCalls;
  const productListCallsBeforeOptions = productListCalls;
  const productRemoveCallsBeforeOptions = productRemoveCalls;
  const imageReplaceCallsBeforeOptions = imageReplaceCalls;
  const imageRemoveCallsBeforeOptions = imageRemoveCalls;
  const optionsResponse = await fetch(
    `${server.baseUrl}/api/admin/products/1/image`,
    {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PUT',
        'content-type': 'multipart/form-data; boundary=broken-preflight-body',
      },
      body: '--broken-preflight-body\r\nmalformed multipart body',
    },
  );
  assert.equal(optionsResponse.status, 204);
  assert.equal(optionsResponse.headers.get('cache-control'), 'no-store');
  assert.equal(
    optionsResponse.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  );
  assert.equal(optionsResponse.headers.get('access-control-allow-credentials'), 'true');
  assert.match(optionsResponse.headers.get('access-control-allow-methods') ?? '', /(^|,\s*)PUT(,|$)/);
  assert.equal(await optionsResponse.text(), '');
  assert.equal(authCalls - callsBeforeOptions, 0);
  assert.equal(productListCalls, productListCallsBeforeOptions);
  assert.equal(productRemoveCalls, productRemoveCallsBeforeOptions);
  assert.equal(imageReplaceCalls, imageReplaceCallsBeforeOptions);
  assert.equal(imageRemoveCalls, imageRemoveCallsBeforeOptions);
});

test('rejects missing, wrong, multiple, and invalid image files with no-store 400', async (context) => {
  let serviceCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: {
      async replace() { serviceCalls += 1; },
      async remove() {},
    },
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const requests = [
    new FormData(),
    imageForm({ field: 'photo' }),
    imageForm({ secondFile: true }),
    imageForm({ buffer: Buffer.alloc(0) }),
    imageForm({ buffer: Buffer.from('<svg></svg>') }),
  ];

  const formWithTextField = imageForm();
  formWithTextField.append('caption', 'not accepted');
  requests.push(formWithTextField);

  for (const body of requests) {
    const response = await fetch(`${server.baseUrl}/api/admin/products/1/image`, {
      method: 'PUT',
      headers: { cookie: validCookie },
      body,
    });

    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).success, false);
  }

  assert.equal(serviceCalls, 0);
});

test('accepts exactly 5 MiB and rejects an oversized file with no-store 413', async (context) => {
  let serviceCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: {
      async replace() {
        serviceCalls += 1;
        return product({ imagePath: `/uploads/products/${'ab'.repeat(16)}.png` });
      },
      async remove() {},
    },
  });
  const server = await startTestServer(app);
  context.after(server.close);
  const exactLimit = await createPngWithExactSize(maximumProductImageBytes);
  const exactResponse = await fetch(`${server.baseUrl}/api/admin/products/1/image`, {
    method: 'PUT',
    headers: { cookie: validCookie },
    body: imageForm({ buffer: exactLimit }),
  });

  assert.equal(exactResponse.status, 200);
  assert.equal(exactResponse.headers.get('cache-control'), 'no-store');

  const response = await fetch(`${server.baseUrl}/api/admin/products/1/image`, {
    method: 'PUT',
    headers: { cookie: validCookie },
    body: imageForm({ buffer: Buffer.alloc(maximumProductImageBytes + 1) }),
  });

  assert.equal(response.status, 413);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    success: false,
    message: 'Product image exceeds the 5 MiB limit',
  });
  assert.equal(serviceCalls, 1);
});

test('validates the product id before parsing multipart content', async (context) => {
  let serviceCalls = 0;
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: {
      async replace() { serviceCalls += 1; },
      async remove() { serviceCalls += 1; },
    },
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const uploadResponse = await fetch(
    `${server.baseUrl}/api/admin/products/12abc/image`,
    {
      method: 'PUT',
      headers: {
        cookie: validCookie,
        'content-type': 'multipart/form-data; boundary=broken',
      },
      body: 'malformed',
    },
  );
  const deleteResponse = await fetch(
    `${server.baseUrl}/api/admin/products/18446744073709551616/image`,
    { method: 'DELETE', headers: { cookie: validCookie } },
  );

  for (const response of [uploadResponse, deleteResponse]) {
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      success: false,
      message: 'Product id is invalid',
    });
  }
  assert.equal(serviceCalls, 0);
});

test('maps missing products to 404 and hides internal errors behind no-store 500', async (context) => {
  const missingError = Object.assign(new Error('Product not found'), {
    code: 'PRODUCT_NOT_FOUND',
    status: 404,
    isSafeToDisplay: true,
  });
  const missingApp = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: {
      async replace() { throw missingError; },
      async remove() { throw missingError; },
    },
  });
  const missingServer = await startTestServer(missingApp);
  context.after(missingServer.close);

  for (const [method, body] of [['PUT', imageForm()]]) {
    const response = await fetch(`${missingServer.baseUrl}/api/admin/products/7/image`, {
      method,
      headers: { cookie: validCookie },
      ...(body ? { body } : {}),
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      success: false,
      message: 'Product not found',
    });
  }

  const forbiddenDelete = await fetch(
    `${missingServer.baseUrl}/api/admin/products/7/image`,
    { method: 'DELETE', headers: { cookie: validCookie } },
  );
  assert.equal(forbiddenDelete.status, 409);
  assert.deepEqual(await forbiddenDelete.json(), {
    success: false,
    message: 'Product image is required; replace the image instead',
  });

  const internalApp = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: {
      async replace() {
        throw Object.assign(new Error('C:\\secret\\image.png'), {
          code: 'ER_INTERNAL_ERROR',
        });
      },
      async remove() {},
    },
  });
  const internalServer = await startTestServer(internalApp);
  context.after(internalServer.close);
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await fetch(`${internalServer.baseUrl}/api/admin/products/1/image`, {
      method: 'PUT',
      headers: { cookie: validCookie },
      body: imageForm(),
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, { success: false, message: 'Internal server error' });
    assert.equal(JSON.stringify(body).includes('secret'), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('serves only the configured product image directory through the public path', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-public-products-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filename = `${'ef'.repeat(16)}.png`;
  const contents = validPng;
  await writeFile(path.join(root, filename), contents);
  const app = createApp({
    adminAuthService: createAuthService(),
    productImagesDirectory: root,
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/uploads/products/${filename}`);

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), contents);
  assert.equal(
    (await fetch(`${server.baseUrl}/uploads/products/.tmp/hidden`)).status,
    404,
  );
});

test('rejects a malformed image before service or filesystem storage', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-malformed-route-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = createProductImageStorage({ rootDirectory: root });
  const service = createAdminProductImagesService({
    executor: {
      async getConnection() {
        throw new Error('Database must not be reached for a malformed image.');
      },
    },
    storage,
  });
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: service,
  });
  const server = await startTestServer(app);
  context.after(server.close);
  const response = await fetch(`${server.baseUrl}/api/admin/products/1/image`, {
    method: 'PUT',
    headers: { cookie: validCookie },
    body: imageForm({ buffer: corruptPngCrc(validPng) }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    success: false,
    message: 'Product image must be a valid JPEG, PNG, or WebP file',
  });
  assert.deepEqual(await readdir(root), []);
});

test('stores only canonical JPEG, PNG, and WebP bytes through the real route and service', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-canonical-route-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = createProductImageStorage({ rootDirectory: root });
  const marker = Buffer.from('RIONA_ROUTE_TRAILING_PAYLOAD_MUST_NOT_SURVIVE');
  let durableImagePath = null;
  let pendingImagePath = null;
  const connection = {
    async beginTransaction() {
      pendingImagePath = durableImagePath;
    },
    async execute(sql, parameters) {
      if (sql.includes('FROM menu_items AS menuItems')) {
        return [[product({ id: '1', imagePath: pendingImagePath })], []];
      }

      if (sql === 'UPDATE menu_items SET image_path = ? WHERE id = ?') {
        assert.equal(parameters[1], '1');
        pendingImagePath = parameters[0];
        return [{ affectedRows: 1, changedRows: 1 }, []];
      }

      throw new Error(`Unexpected canonical route SQL: ${sql}`);
    },
    async commit() {
      durableImagePath = pendingImagePath;
    },
    async rollback() {
      pendingImagePath = durableImagePath;
    },
    release() {},
  };
  const service = createAdminProductImagesService({
    executor: { async getConnection() { return connection; } },
    storage,
    logger: { error() {} },
  });
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: service,
    productImagesDirectory: root,
  });
  const server = await startTestServer(app);
  context.after(server.close);

  for (const [buffer, filename, mimeType, expectedFormat] of [
    [validJpeg, 'coffee.jpg', 'image/jpeg', 'jpeg'],
    [validPng, 'coffee.png', 'image/png', 'png'],
    [validWebp, 'coffee.webp', 'image/webp', 'webp'],
  ]) {
    const response = await fetch(`${server.baseUrl}/api/admin/products/1/image`, {
      method: 'PUT',
      headers: { cookie: validCookie },
      body: imageForm({
        buffer: Buffer.concat([buffer, marker]),
        filename,
        mimeType,
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.product.imagePath, durableImagePath);
    const absolutePath = storage.resolveManagedPublicPath(durableImagePath);
    const storedBuffer = await readFile(absolutePath);
    const metadata = await sharp(storedBuffer).metadata();
    assert.equal(storedBuffer.includes(marker), false);
    assert.equal(metadata.format, expectedFormat);
    assert.equal(metadata.pages ?? 1, 1);
  }

  const entries = await readdir(root);
  assert.equal(entries.includes('.tmp'), true);
  assert.equal(entries.length, 2);
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
});

test('rejects a real multi-frame WebP before service or storage', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'riona-animated-route-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const metadata = await sharp(animatedWebp, { animated: true }).metadata();
  const realStorage = createProductImageStorage({ rootDirectory: root });
  let serviceCalls = 0;
  let storageCalls = 0;
  const realService = createAdminProductImagesService({
    executor: {
      async getConnection() {
        throw new Error('Database must not be reached for an animated image.');
      },
    },
    storage: {
      async store(image) {
        storageCalls += 1;
        return realStorage.store(image);
      },
      remove: realStorage.remove,
    },
  });
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductImagesService: {
      async replace(...arguments_) {
        serviceCalls += 1;
        return realService.replace(...arguments_);
      },
      remove: realService.remove,
    },
  });
  const server = await startTestServer(app);
  context.after(server.close);

  assert.equal(metadata.format, 'webp');
  assert.ok(Number(metadata.pages) > 1);
  const response = await fetch(`${server.baseUrl}/api/admin/products/1/image`, {
    method: 'PUT',
    headers: { cookie: validCookie },
    body: imageForm({ buffer: animatedWebp, filename: 'animated.webp', mimeType: 'image/webp' }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(body, {
    success: false,
    message: 'Product image must be a valid JPEG, PNG, or WebP file',
  });
  assert.equal(JSON.stringify(body).includes(root), false);
  assert.equal(JSON.stringify(body).toLowerCase().includes('sharp'), false);
  assert.equal(JSON.stringify(body).toLowerCase().includes('stack'), false);
  assert.equal(serviceCalls, 0);
  assert.equal(storageCalls, 0);
  assert.deepEqual(await readdir(root), []);
});
