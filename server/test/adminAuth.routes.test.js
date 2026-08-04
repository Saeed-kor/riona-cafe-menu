import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.NODE_ENV ??= 'test';
process.env.TRUST_PROXY ??= 'false';
process.env.PORT ??= '3000';
process.env.CLIENT_URL ??= 'http://localhost:5173';
process.env.DB_HOST ??= 'localhost';
process.env.DB_PORT ??= '3306';
process.env.DB_USER ??= 'root';
process.env.DB_PASSWORD ??= '';
process.env.DB_NAME ??= 'riona_cafe_menu';

const { createApp } = await import('../src/app.js');
const {
  adminSessionCookieName,
  getAdminSessionCookieOptions,
} = await import('../src/routes/adminAuth.routes.js');
const { parseTrustProxy } = await import('../src/config/env.js');

function invalidCredentialsError() {
  const error = new Error('Invalid username or password');
  error.code = 'INVALID_ADMIN_CREDENTIALS';
  error.status = 401;
  return error;
}

function createFakeAuthService() {
  const sessionToken = 'b'.repeat(64);
  const expiredSessionToken = 'c'.repeat(64);
  const admin = { id: '1', username: 'admin' };
  const sessions = new Map([
    [expiredSessionToken, { admin, expiresAt: Date.now() - 1_000 }],
  ]);

  return {
    sessionToken,
    expiredSessionToken,
    async login(username, password) {
      if (username.trim() !== 'admin' || password !== 'valid-password') {
        throw invalidCredentialsError();
      }

      sessions.set(sessionToken, {
        admin,
        expiresAt: Date.now() + 60_000,
      });
      return {
        admin,
        sessionToken,
      };
    },
    async getCurrentAdmin(token) {
      const session = sessions.get(token);
      return session && session.expiresAt > Date.now() ? session.admin : null;
    },
    async logout(token) {
      sessions.delete(token);
    },
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
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function readJson(response) {
  return response.json();
}

async function sendInvalidLogin(baseUrl, forwardedFor) {
  return fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
  });
}

test('admin auth endpoints enforce the complete server-side session lifecycle', async (context) => {
  const service = createFakeAuthService();
  const app = createApp({ adminAuthService: service });
  const testServer = await startTestServer(app);

  context.after(testServer.close);

  await context.test('rejects missing credentials with basic validation', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '', password: '' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await readJson(response), {
      success: false,
      message: 'Username and password are required',
    });
  });

  const invalidResponses = [];

  await context.test('uses one generic response for a wrong username', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'missing', password: 'valid-password' }),
    });
    invalidResponses.push(await readJson(response));
    assert.equal(response.status, 401);
  });

  await context.test('uses the same generic response for a wrong password', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    invalidResponses.push(await readJson(response));
    assert.equal(response.status, 401);
    assert.deepEqual(invalidResponses[0], invalidResponses[1]);
    assert.deepEqual(invalidResponses[1], {
      success: false,
      message: 'Invalid username or password',
    });
  });

  let sessionCookie;

  await context.test('logs in successfully without exposing credentials or the session token', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'valid-password' }),
    });
    const setCookie = response.headers.get('set-cookie');
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, {
      success: true,
      admin: { id: '1', username: 'admin' },
    });
    assert.equal(JSON.stringify(body).includes('password'), false);
    assert.equal(JSON.stringify(body).includes('hash'), false);
    assert.equal(JSON.stringify(body).includes(service.sessionToken), false);
    assert.match(setCookie, new RegExp(`^${adminSessionCookieName}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\/api\/admin/i);
    assert.doesNotMatch(setCookie, /Secure/i);
    sessionCookie = setCookie.split(';', 1)[0];
  });

  await context.test('returns current-admin for a valid session', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/admin/auth/me`, {
      headers: { cookie: sessionCookie },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      success: true,
      admin: { id: '1', username: 'admin' },
    });
  });

  await context.test('rejects current-admin without a session', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/admin/auth/me`);

    assert.equal(response.status, 401);
    assert.deepEqual(await readJson(response), {
      success: false,
      message: 'Authentication required',
    });
  });

  await context.test('rejects current-admin with an expired session', async () => {
    const response = await fetch(`${testServer.baseUrl}/api/admin/auth/me`, {
      headers: {
        cookie: `${adminSessionCookieName}=${service.expiredSessionToken}`,
      },
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await readJson(response), {
      success: false,
      message: 'Authentication required',
    });
  });

  await context.test('logout invalidates the server session and clears the cookie', async () => {
    const logoutResponse = await fetch(`${testServer.baseUrl}/api/admin/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie },
    });
    const clearedCookie = logoutResponse.headers.get('set-cookie');

    assert.equal(logoutResponse.status, 200);
    assert.deepEqual(await readJson(logoutResponse), {
      success: true,
      message: 'Logged out',
    });
    assert.match(clearedCookie, new RegExp(`^${adminSessionCookieName}=`));
    assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
    assert.match(clearedCookie, /Path=\/api\/admin/i);

    const meResponse = await fetch(`${testServer.baseUrl}/api/admin/auth/me`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(meResponse.status, 401);
  });
});

test('production session cookies are Secure while development cookies are not', () => {
  assert.equal(getAdminSessionCookieOptions(true).secure, true);
  assert.equal(getAdminSessionCookieOptions(false).secure, false);
  assert.equal(getAdminSessionCookieOptions(true).httpOnly, true);
  assert.equal(getAdminSessionCookieOptions(true).sameSite, 'lax');
});

test('TRUST_PROXY accepts only false, numeric hops, or explicit IP/CIDR values', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), 0);
  assert.equal(parseTrustProxy('2'), 2);
  assert.deepEqual(parseTrustProxy('127.0.0.1, 10.0.0.0/8, ::1/128'), [
    '127.0.0.1',
    '10.0.0.0/8',
    '::1/128',
  ]);
  assert.throws(() => parseTrustProxy('true'), /must not grant trust to every proxy/);
  assert.throws(() => parseTrustProxy('unknown-proxy'), /only proxy IP or CIDR/);
  assert.throws(() => parseTrustProxy('10.0.0.0/99'), /only proxy IP or CIDR/);
});

test('the real login limiter rejects request eleven from one IP', async (context) => {
  const app = createApp({ adminAuthService: createFakeAuthService(), trustProxy: false });
  const testServer = await startTestServer(app);
  context.after(testServer.close);

  for (let attempt = 1; attempt <= 11; attempt += 1) {
    const response = await sendInvalidLogin(testServer.baseUrl);
    assert.equal(response.status, attempt <= 10 ? 401 : 429);
  }
});

test('trusted proxy client IPs receive independent login quotas', async (context) => {
  const app = createApp({ adminAuthService: createFakeAuthService(), trustProxy: 1 });
  const testServer = await startTestServer(app);
  context.after(testServer.close);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await sendInvalidLogin(testServer.baseUrl, '198.51.100.10');
    assert.equal(response.status, 401);
  }

  const secondClientResponse = await sendInvalidLogin(testServer.baseUrl, '198.51.100.11');
  assert.equal(secondClientResponse.status, 401);

  const limitedFirstClientResponse = await sendInvalidLogin(
    testServer.baseUrl,
    '198.51.100.10',
  );
  assert.equal(limitedFirstClientResponse.status, 429);
});

test('untrusted X-Forwarded-For values cannot bypass the login quota', async (context) => {
  const app = createApp({ adminAuthService: createFakeAuthService(), trustProxy: false });
  const testServer = await startTestServer(app);
  const originalConsoleError = console.error;
  const limiterValidationErrors = [];
  context.after(testServer.close);

  console.error = (...argumentsList) => {
    if (
      argumentsList[0]?.code === 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR' ||
      String(argumentsList[0]).includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR')
    ) {
      limiterValidationErrors.push(argumentsList);
      return;
    }

    originalConsoleError(...argumentsList);
  };

  try {
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const response = await sendInvalidLogin(
        testServer.baseUrl,
        `198.51.100.${attempt}`,
      );
      assert.equal(response.status, attempt <= 10 ? 401 : 429);
    }
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(limiterValidationErrors.length >= 1);
});
