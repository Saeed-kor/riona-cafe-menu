import assert from 'node:assert/strict'
import test from 'node:test'

import {
  adminRouteKind,
  adminAuthStatus,
  bootstrapAdminAuth,
  getAdminRedirect,
  resolveAdminRoute,
} from '../src/admin/authState.js'

test('auth state exposes the required four distinct states', () => {
  assert.deepEqual(adminAuthStatus, {
    checking: 'checking',
    authenticated: 'authenticated',
    unauthenticated: 'unauthenticated',
    error: 'error',
  })
})

test('redirects an unauthenticated visitor from protected admin paths to login', () => {
  assert.equal(getAdminRedirect('/admin', adminAuthStatus.unauthenticated), '/admin/login')
  assert.equal(getAdminRedirect('/admin/categories', adminAuthStatus.unauthenticated), '/admin/login')
  assert.equal(getAdminRedirect('/admin/login', adminAuthStatus.unauthenticated), null)
})

test('redirects an authenticated administrator from login to /admin', () => {
  assert.equal(getAdminRedirect('/admin/login', adminAuthStatus.authenticated), '/admin')
  assert.equal(getAdminRedirect('/admin', adminAuthStatus.authenticated), null)
})

test('does not redirect before session bootstrap resolves or while it is in error', () => {
  assert.equal(getAdminRedirect('/admin', adminAuthStatus.checking), null)
  assert.equal(getAdminRedirect('/admin/login', adminAuthStatus.error), null)
  assert.equal(getAdminRedirect('/', adminAuthStatus.unauthenticated), null)
})

test('classifies only exact admin routes and exposes known trailing-slash canonical paths', () => {
  assert.deepEqual(resolveAdminRoute('/admin'), {
    kind: adminRouteKind.protected,
    canonicalPath: null,
  })
  assert.deepEqual(resolveAdminRoute('/admin/login'), {
    kind: adminRouteKind.login,
    canonicalPath: null,
  })
  assert.deepEqual(resolveAdminRoute('/admin/categories'), {
    kind: adminRouteKind.protected,
    canonicalPath: null,
  })
  assert.deepEqual(resolveAdminRoute('/admin/'), {
    kind: adminRouteKind.canonical,
    canonicalPath: '/admin',
  })
  assert.deepEqual(resolveAdminRoute('/admin/login/'), {
    kind: adminRouteKind.canonical,
    canonicalPath: '/admin/login',
  })
  assert.deepEqual(resolveAdminRoute('/admin/categories/'), {
    kind: adminRouteKind.canonical,
    canonicalPath: '/admin/categories',
  })

  for (const pathname of [
    '/admin/unknown',
    '/admin/login-extra',
    '/admin/categories-extra',
    '/admin//categories',
  ]) {
    assert.equal(resolveAdminRoute(pathname).kind, adminRouteKind.notFound)
    assert.equal(getAdminRedirect(pathname, adminAuthStatus.unauthenticated), null)
  }

  assert.equal(resolveAdminRoute('/administrator').kind, adminRouteKind.public)
  assert.equal(resolveAdminRoute('/Admin').kind, adminRouteKind.public)
})

test('refresh bootstrap restores a valid administrator session and forwards its signal', async () => {
  const admin = { id: '1', username: 'admin' }
  const controller = new AbortController()
  let receivedSignal
  const result = await bootstrapAdminAuth(
    {
      getCurrentAdmin: async ({ signal }) => {
        receivedSignal = signal
        return admin
      },
    },
    { signal: controller.signal },
  )

  assert.equal(receivedSignal, controller.signal)
  assert.deepEqual(result, {
    status: adminAuthStatus.authenticated,
    admin,
    error: null,
  })
})

test('refresh bootstrap treats only a 401 session response as unauthenticated', async () => {
  const result = await bootstrapAdminAuth({
    getCurrentAdmin: async () => {
      throw Object.assign(new Error('Authentication required'), { status: 401, kind: 'http' })
    },
  })

  assert.deepEqual(result, {
    status: adminAuthStatus.unauthenticated,
    admin: null,
    error: null,
  })
})

test('refresh bootstrap keeps failures distinct and stores only sanitized error metadata', async () => {
  const serviceError = Object.assign(new Error('private upstream detail'), {
    kind: 'network',
    status: null,
    privateAddress: 'internal.example',
  })
  const result = await bootstrapAdminAuth({
    getCurrentAdmin: async () => {
      throw serviceError
    },
  })

  assert.deepEqual(result, {
    status: adminAuthStatus.error,
    admin: null,
    error: { kind: 'network', status: null },
  })
  assert.notEqual(result.error, serviceError)
  assert.equal('privateAddress' in result.error, false)
})

test('a 403 current-session response is an error rather than an authenticated session', async () => {
  const result = await bootstrapAdminAuth({
    getCurrentAdmin: async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403, kind: 'http' })
    },
  })

  assert.deepEqual(result, {
    status: adminAuthStatus.error,
    admin: null,
    error: { kind: 'http', status: 403 },
  })
})
