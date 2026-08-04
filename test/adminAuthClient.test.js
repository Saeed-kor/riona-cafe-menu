import assert from 'node:assert/strict'
import test from 'node:test'

import { AdminAuthApiError, createAdminAuthApi } from '../src/api/adminAuth.js'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('admin API client sends every auth request with credentials included', async () => {
  const requests = []
  const responses = [
    jsonResponse({ success: true, admin: { id: '1', username: 'admin' } }),
    jsonResponse({ success: true, admin: { id: '1', username: 'admin' } }),
    jsonResponse({ success: true, message: 'Logged out' }),
  ]
  const api = createAdminAuthApi(async (path, options) => {
    requests.push({ path, options })
    return responses.shift()
  })

  assert.deepEqual(await api.login('admin', 'secret'), { id: '1', username: 'admin' })
  assert.deepEqual(await api.getCurrentAdmin(), { id: '1', username: 'admin' })
  await api.logout()

  assert.deepEqual(
    requests.map(({ path, options }) => ({
      path,
      method: options.method ?? 'GET',
      credentials: options.credentials,
    })),
    [
      { path: '/api/admin/auth/login', method: 'POST', credentials: 'include' },
      { path: '/api/admin/auth/me', method: 'GET', credentials: 'include' },
      { path: '/api/admin/auth/logout', method: 'POST', credentials: 'include' },
    ],
  )
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    username: 'admin',
    password: 'secret',
  })
})

test('admin API client preserves the HTTP status for authentication decisions', async () => {
  const api = createAdminAuthApi(async () =>
    jsonResponse({ success: false, message: 'Authentication required' }, 401),
  )

  await assert.rejects(
    api.getCurrentAdmin(),
    (error) =>
      error instanceof AdminAuthApiError &&
      error.status === 401 &&
      error.message === 'Authentication required',
  )
})
