import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { configureTestEnvironment } from '../test-support/testEnvironment.js';

configureTestEnvironment();

const { createApp } = await import('../src/app.js');
const { adminSessionCookieName } = await import('../src/routes/adminAuth.routes.js');
const { createAdminProductsService } = await import(
  '../src/services/adminProducts.service.js'
);

const validToken = 'a'.repeat(64);
const validCookie = `${adminSessionCookieName}=${validToken}`;

function createAuthService(onCurrentAdmin = () => {}) {
  return {
    async getCurrentAdmin(token) {
      onCurrentAdmin();
      return token === validToken ? { id: '1', username: 'admin' } : null;
    },
    async login() {
      throw new Error('Login is not used in product route tests.');
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

function product(overrides = {}) {
  return {
    id: '1',
    categoryId: '2',
    categoryName: 'نوشیدنی گرم',
    name: 'قهوه',
    description: 'قهوه تازه‌دم',
    price: '125000',
    imagePath: null,
    sortOrder: 0,
    isAvailable: true,
    isVisible: true,
    ...overrides,
  };
}

function jsonRequest(method, body, authenticated = true) {
  return {
    method,
    headers: {
      ...(authenticated ? { cookie: validCookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test('every product operation requires a valid admin session', async (context) => {
  let productCalls = 0;
  const productsService = {
    async list() { productCalls += 1; },
    async create() { productCalls += 1; },
    async update() { productCalls += 1; },
    async remove() { productCalls += 1; },
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductsService: productsService,
  });
  const server = await startTestServer(app);
  context.after(server.close);

  for (const [method, path, body] of [
    ['GET', '/api/admin/products'],
    ['POST', '/api/admin/products', { categoryId: 2, name: 'قهوه', price: '1' }],
    ['PATCH', '/api/admin/products/1', { isVisible: false }],
    ['DELETE', '/api/admin/products/1'],
  ]) {
    const response = await fetch(`${server.baseUrl}${path}`, jsonRequest(method, body, false));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      success: false,
      message: 'Authentication required',
    });
  }

  assert.equal(productCalls, 0);
});

test('product routes expose the CRUD response contract through real middleware', async (context) => {
  const products = [product()];
  let authCalls = 0;
  const productsService = {
    async list() { return products; },
    async create(body) { return product({ id: '2', ...body, categoryId: String(body.categoryId) }); },
    async update(id, body) { return product({ id, ...body }); },
    async remove() {},
  };
  const app = createApp({
    adminAuthService: createAuthService(() => { authCalls += 1; }),
    adminProductsService: productsService,
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const listResponse = await fetch(`${server.baseUrl}/api/admin/products`, {
    headers: { cookie: validCookie },
  });
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await listResponse.json(), { success: true, products });
  assert.equal(authCalls, 1);

  const createResponse = await fetch(
    `${server.baseUrl}/api/admin/products`,
    jsonRequest('POST', {
      categoryId: 2,
      name: 'چای',
      description: null,
      price: '85000',
      sortOrder: 3,
      isAvailable: true,
      isVisible: true,
    }),
  );
  assert.equal(createResponse.status, 201);
  assert.equal(authCalls, 2);
  assert.equal((await createResponse.json()).product.name, 'چای');

  const updateResponse = await fetch(
    `${server.baseUrl}/api/admin/products/1`,
    jsonRequest('PATCH', { isAvailable: false }),
  );
  assert.equal(updateResponse.status, 200);
  assert.equal(authCalls, 3);
  assert.equal((await updateResponse.json()).product.isAvailable, false);

  const deleteResponse = await fetch(
    `${server.baseUrl}/api/admin/products/1`,
    jsonRequest('DELETE'),
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), {
    success: true,
    message: 'Product deleted',
  });
  assert.equal(authCalls, 4);
});

test('product routes map validation and missing records to safe responses', async (context) => {
  let databaseCalls = 0;
  const connection = {
    async beginTransaction() {},
    async execute() {
      databaseCalls += 1;
      return [[], []];
    },
    async rollback() {},
    release() {},
  };
  const executor = {
    async getConnection() {
      return connection;
    },
    async execute(sql) {
      databaseCalls += 1;

      if (sql.includes('UPDATE menu_items')) {
        return [{ affectedRows: 0 }, []];
      }

      if (sql.startsWith('DELETE FROM menu_items')) {
        return [{ affectedRows: 0 }, []];
      }

      return [[], []];
    },
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminProductsService: createAdminProductsService({ executor }),
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const invalidBody = await fetch(
    `${server.baseUrl}/api/admin/products`,
    jsonRequest('POST', { categoryId: 2, name: '', price: '100' }),
  );
  assert.equal(invalidBody.status, 400);

  const callsBeforeUnknownField = databaseCalls;
  const unknownField = await fetch(
    `${server.baseUrl}/api/admin/products`,
    jsonRequest('POST', {
      categoryId: 2,
      name: 'قهوه',
      price: '100',
      image_path: '/unsafe/path',
    }),
  );
  assert.equal(unknownField.status, 400);
  assert.equal(databaseCalls, callsBeforeUnknownField);

  const invalidId = await fetch(
    `${server.baseUrl}/api/admin/products/12abc`,
    jsonRequest('PATCH', { name: 'قهوه' }),
  );
  assert.equal(invalidId.status, 400);

  const missingCategory = await fetch(
    `${server.baseUrl}/api/admin/products`,
    jsonRequest('POST', { categoryId: 99, name: 'قهوه', price: '100' }),
  );
  assert.equal(missingCategory.status, 400);
  assert.deepEqual(await missingCategory.json(), {
    success: false,
    message: 'Category does not exist',
  });

  const missingProduct = await fetch(
    `${server.baseUrl}/api/admin/products/7`,
    jsonRequest('PATCH', { name: 'قهوه' }),
  );
  assert.equal(missingProduct.status, 404);
  assert.deepEqual(await missingProduct.json(), {
    success: false,
    message: 'Product not found',
  });

  const missingDelete = await fetch(
    `${server.baseUrl}/api/admin/products/7`,
    jsonRequest('DELETE'),
  );
  assert.equal(missingDelete.status, 404);
  assert.deepEqual(await missingDelete.json(), {
    success: false,
    message: 'Product not found',
  });
});

test('product routes forward explicitly safe typed service errors and hide internal database errors', async (context) => {
  const conflict = Object.assign(new Error('Typed product service conflict'), {
    code: 'TYPED_PRODUCT_SERVICE_CONFLICT',
    status: 409,
    isSafeToDisplay: true,
  });
  const conflictApp = createApp({
    adminAuthService: createAuthService(),
    adminProductsService: {
      async list() { return []; },
      async create() { throw conflict; },
      async update() { throw conflict; },
      async remove() { throw conflict; },
    },
  });
  const conflictServer = await startTestServer(conflictApp);
  context.after(conflictServer.close);

  const conflictResponse = await fetch(
    `${conflictServer.baseUrl}/api/admin/products/1`,
    jsonRequest('DELETE'),
  );
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), {
    success: false,
    message: 'Typed product service conflict',
  });

  const internalApp = createApp({
    adminAuthService: createAuthService(),
    adminProductsService: {
      async list() {
        throw Object.assign(new Error('SELECT secret FROM menu_items'), {
          code: 'ER_PARSE_ERROR',
        });
      },
    },
  });
  const internalServer = await startTestServer(internalApp);
  context.after(internalServer.close);
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const internalResponse = await fetch(`${internalServer.baseUrl}/api/admin/products`, {
      headers: { cookie: validCookie },
    });
    const body = await internalResponse.json();

    assert.equal(internalResponse.status, 500);
    assert.equal(internalResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, { success: false, message: 'Internal server error' });
    assert.equal(JSON.stringify(body).includes('SELECT secret'), false);
  } finally {
    console.error = originalConsoleError;
  }
});
