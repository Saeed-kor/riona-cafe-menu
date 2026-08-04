import assert from 'node:assert/strict'
import test from 'node:test'

import {
  adminAuthStatus,
  bootstrapAdminAuth,
  getAdminRedirect,
} from '../src/admin/authState.js'

test('redirects an unauthenticated visitor from /admin to /admin/login', () => {
  assert.equal(getAdminRedirect('/admin', adminAuthStatus.anonymous), '/admin/login')
  assert.equal(getAdminRedirect('/admin/users', adminAuthStatus.anonymous), '/admin/login')
  assert.equal(getAdminRedirect('/admin/login', adminAuthStatus.anonymous), null)
})

test('redirects an authenticated administrator from login to /admin', () => {
  assert.equal(getAdminRedirect('/admin/login', adminAuthStatus.authenticated), '/admin')
  assert.equal(getAdminRedirect('/admin', adminAuthStatus.authenticated), null)
})

test('does not redirect before session bootstrap has resolved', () => {
  assert.equal(getAdminRedirect('/admin', adminAuthStatus.loading), null)
  assert.equal(getAdminRedirect('/admin/login', adminAuthStatus.error), null)
})

test('refresh bootstrap restores a valid administrator session', async () => {
  const admin = { id: '1', username: 'admin' }
  const result = await bootstrapAdminAuth({
    getCurrentAdmin: async () => admin,
  })

  assert.deepEqual(result, {
    status: adminAuthStatus.authenticated,
    admin,
    error: null,
  })
})

test('refresh bootstrap treats a 401 session as unauthenticated', async () => {
  const authenticationError = Object.assign(new Error('Authentication required'), { status: 401 })
  const result = await bootstrapAdminAuth({
    getCurrentAdmin: async () => {
      throw authenticationError
    },
  })

  assert.deepEqual(result, {
    status: adminAuthStatus.anonymous,
    admin: null,
    error: null,
  })
})

test('refresh bootstrap keeps service failures distinct from an invalid session', async () => {
  const serviceError = Object.assign(new Error('Service unavailable'), { status: 503 })
  const result = await bootstrapAdminAuth({
    getCurrentAdmin: async () => {
      throw serviceError
    },
  })

  assert.equal(result.status, adminAuthStatus.error)
  assert.equal(result.admin, null)
  assert.equal(result.error, serviceError)
})
