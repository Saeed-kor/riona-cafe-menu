import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { configureTestEnvironment } from '../test-support/testEnvironment.js';

configureTestEnvironment();

const { createApp } = await import('../src/app.js');
const { adminSessionCookieName } = await import('../src/routes/adminAuth.routes.js');
const { createAdminCategoriesService } = await import(
  '../src/services/adminCategories.service.js'
);

const validToken = 'a'.repeat(64);
const validCookie = `${adminSessionCookieName}=${validToken}`;

function createAuthService() {
  return {
    async getCurrentAdmin(token) {
      return token === validToken ? { id: '1', username: 'admin' } : null;
    },
    async login() {
      throw new Error('Login is not used in category route tests.');
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

function category(overrides = {}) {
  return {
    id: '1',
    name: 'نوشیدنی گرم',
    imagePath: null,
    sortOrder: 0,
    isVisible: true,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
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

test('every category operation requires a valid admin session', async (context) => {
  let categoryCalls = 0;
  const categoriesService = {
    async list() { categoryCalls += 1; },
    async create() { categoryCalls += 1; },
    async update() { categoryCalls += 1; },
    async remove() { categoryCalls += 1; },
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminCategoriesService: categoriesService,
  });
  const server = await startTestServer(app);
  context.after(server.close);

  for (const [method, path, body] of [
    ['GET', '/api/admin/categories'],
    ['POST', '/api/admin/categories', { name: 'قهوه' }],
    ['PATCH', '/api/admin/categories/1', { isVisible: false }],
    ['DELETE', '/api/admin/categories/1'],
  ]) {
    const response = await fetch(`${server.baseUrl}${path}`, jsonRequest(method, body, false));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      success: false,
      message: 'Authentication required',
    });
  }

  assert.equal(categoryCalls, 0);
});

test('category routes expose the CRUD response contract through real middleware', async (context) => {
  const categories = [category()];
  const categoriesService = {
    async list() { return categories; },
    async create(body) { return category({ id: '2', ...body }); },
    async update(id, body) { return category({ id, ...body }); },
    async remove() {},
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminCategoriesService: categoriesService,
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const listResponse = await fetch(`${server.baseUrl}/api/admin/categories`, {
    headers: { cookie: validCookie },
  });
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await listResponse.json(), { success: true, categories });

  const createResponse = await fetch(
    `${server.baseUrl}/api/admin/categories`,
    jsonRequest('POST', { name: 'دسر', sortOrder: 3, isVisible: true }),
  );
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).category.name, 'دسر');

  const updateResponse = await fetch(
    `${server.baseUrl}/api/admin/categories/1`,
    jsonRequest('PATCH', { isVisible: false }),
  );
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).category.isVisible, false);

  const deleteResponse = await fetch(
    `${server.baseUrl}/api/admin/categories/1`,
    jsonRequest('DELETE'),
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), {
    success: true,
    message: 'Category deleted',
  });
});

test('category routes map validation, missing records, and conflicts without SQL details', async (context) => {
  const deleteConnection = {
    async beginTransaction() {},
    async execute(sql) {
      if (sql.startsWith('SELECT') && sql.includes('FROM categories')) {
        return [[category()], []];
      }

      throw Object.assign(new Error('sensitive foreign key SQL detail'), {
        code: 'ER_ROW_IS_REFERENCED_2',
      });
    },
    async rollback() {},
    release() {},
  };
  const executor = {
    async execute(sql) {
      if (sql.startsWith('DELETE')) {
        throw Object.assign(new Error('sensitive foreign key SQL detail'), {
          code: 'ER_ROW_IS_REFERENCED_2',
        });
      }

      return [[], []];
    },
    async getConnection() {
      return deleteConnection;
    },
  };
  const app = createApp({
    adminAuthService: createAuthService(),
    adminCategoriesService: createAdminCategoriesService({ executor }),
  });
  const server = await startTestServer(app);
  context.after(server.close);

  const invalidBody = await fetch(
    `${server.baseUrl}/api/admin/categories`,
    jsonRequest('POST', { name: '', sortOrder: -1, isVisible: 1 }),
  );
  assert.equal(invalidBody.status, 400);

  const invalidId = await fetch(
    `${server.baseUrl}/api/admin/categories/not-an-id`,
    jsonRequest('PATCH', { name: 'قهوه' }),
  );
  assert.equal(invalidId.status, 400);

  const duplicateExecutor = {
    async execute(sql) {
      if (sql.includes('INSERT INTO categories')) {
        throw Object.assign(new Error('sensitive duplicate index detail'), {
          code: 'ER_DUP_ENTRY',
        });
      }

      return [[], []];
    },
  };
  const duplicateApp = createApp({
    adminAuthService: createAuthService(),
    adminCategoriesService: createAdminCategoriesService({ executor: duplicateExecutor }),
  });
  const duplicateServer = await startTestServer(duplicateApp);
  context.after(duplicateServer.close);
  const duplicate = await fetch(
    `${duplicateServer.baseUrl}/api/admin/categories`,
    jsonRequest('POST', { name: 'قهوه' }),
  );
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 409);
  assert.equal(JSON.stringify(duplicateBody).includes('sensitive'), false);

  const missing = await fetch(
    `${server.baseUrl}/api/admin/categories/7`,
    jsonRequest('PATCH', { name: 'قهوه' }),
  );
  assert.equal(missing.status, 404);

  const conflict = await fetch(
    `${server.baseUrl}/api/admin/categories/7`,
    jsonRequest('DELETE'),
  );
  const conflictBody = await conflict.json();
  assert.equal(conflict.status, 409);
  assert.equal(JSON.stringify(conflictBody).includes('sensitive'), false);
  assert.deepEqual(conflictBody, {
    success: false,
    message: 'A category with menu items cannot be deleted',
  });
});
