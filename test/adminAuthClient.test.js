import assert from 'node:assert/strict'
import test from 'node:test'

import { AdminAuthApiError, createAdminAuthApi } from '../src/api/adminAuth.js'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('admin API client uses the real auth contract and includes credentials centrally', async () => {
  const requests = []
  const responses = [
    jsonResponse({
      success: true,
      admin: {
        id: '1',
        username: 'admin',
        passwordHash: 'must-not-reach-the-ui',
        sessionToken: 'must-not-reach-the-ui',
      },
    }),
    jsonResponse({
      success: true,
      admin: { id: '1', username: 'admin', displayName: 'مدیر ریونا', internalRole: 'owner' },
    }),
    new Response(null, { status: 204 }),
  ]
  const api = createAdminAuthApi(
    async (path, options) => {
      requests.push({ path, options })
      return responses.shift()
    },
    { baseUrl: 'http://localhost:3000/' },
  )

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
      {
        path: 'http://localhost:3000/api/admin/auth/login',
        method: 'POST',
        credentials: 'include',
      },
      {
        path: 'http://localhost:3000/api/admin/auth/me',
        method: 'GET',
        credentials: 'include',
      },
      {
        path: 'http://localhost:3000/api/admin/auth/logout',
        method: 'POST',
        credentials: 'include',
      },
    ],
  )
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    username: 'admin',
    password: 'secret',
  })
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json')
  assert.equal(requests[1].options.signal, undefined)
})

test('admin API client preserves supported HTTP statuses without retaining raw errors', async (context) => {
  for (const status of [400, 401, 403, 429]) {
    await context.test(String(status), async () => {
      const api = createAdminAuthApi(async () =>
        jsonResponse({ success: false, message: 'raw backend detail must stay hidden' }, status),
      )

      await assert.rejects(
        api.getCurrentAdmin(),
        (error) =>
          error instanceof AdminAuthApiError &&
          error.kind === 'http' &&
          error.status === status &&
          !error.message.includes('raw backend detail'),
      )
    })
  }
})

test('admin API client turns non-JSON HTTP failures into sanitized errors', async () => {
  const api = createAdminAuthApi(async () =>
    new Response('<h1>internal proxy failure</h1>', {
      status: 503,
      headers: { 'content-type': 'text/html' },
    }),
  )

  await assert.rejects(
    api.login('admin', 'secret'),
    (error) =>
      error instanceof AdminAuthApiError && error.kind === 'http' && error.status === 503,
  )
})

test('admin API client distinguishes network failures from HTTP failures', async () => {
  const api = createAdminAuthApi(async () => {
    throw new TypeError('socket address and internal detail')
  })

  await assert.rejects(
    api.getCurrentAdmin(),
    (error) =>
      error instanceof AdminAuthApiError &&
      error.kind === 'network' &&
      error.status === null &&
      !error.message.includes('socket address'),
  )
})

test('admin API client rejects malformed successful admin responses', async () => {
  const api = createAdminAuthApi(async () =>
    jsonResponse({ success: true, admin: { username: 'admin', passwordHash: 'hidden' } }),
  )

  await assert.rejects(
    api.login('admin', 'secret'),
    (error) => error instanceof AdminAuthApiError && error.kind === 'protocol',
  )
})

test('admin API client accepts only canonical unsigned BIGINT admin ids', async (context) => {
  const validIds = [
    { label: 'positive number', input: 1, expected: '1' },
    {
      label: 'maximum safe number',
      input: Number.MAX_SAFE_INTEGER,
      expected: String(Number.MAX_SAFE_INTEGER),
    },
    { label: 'backend string', input: '1', expected: '1' },
    { label: 'ordinary string', input: '42', expected: '42' },
    { label: 'above safe integer as string', input: '9007199254740992', expected: '9007199254740992' },
    {
      label: 'maximum unsigned BIGINT',
      input: '18446744073709551615',
      expected: '18446744073709551615',
    },
  ]

  for (const { label, input, expected } of validIds) {
    await context.test(`accepts ${label}`, async () => {
      const api = createAdminAuthApi(async () =>
        jsonResponse({
          success: true,
          admin: {
            id: input,
            username: 'admin',
            password_hash: 'must-be-removed',
            token: 'must-be-removed',
            role: 'must-be-removed',
          },
        }),
      )

      const admin = await api.getCurrentAdmin()
      assert.deepEqual(admin, { id: expected, username: 'admin' })
      assert.deepEqual(Object.keys(admin), ['id', 'username'])
    })
  }

  const invalidIds = [
    ['', 'empty string'],
    ['0', 'zero string'],
    ['00', 'zeroes'],
    ['01', 'leading zero'],
    ['-1', 'negative string'],
    ['+1', 'positive sign'],
    ['1.0', 'decimal string'],
    ['1e3', 'exponent string'],
    [' 1', 'leading whitespace'],
    ['1 ', 'trailing whitespace'],
    [' 1 ', 'surrounding whitespace'],
    ['abc', 'letters'],
    ['۱۲۳', 'non-ASCII digits'],
    ['18446744073709551616', 'above unsigned BIGINT'],
    [0, 'zero number'],
    [-1, 'negative number'],
    [1.5, 'decimal number'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [Number.MAX_SAFE_INTEGER + 1, 'unsafe integer'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'object'],
    [[], 'array'],
  ]

  for (const [input, label] of invalidIds) {
    await context.test(`rejects ${label}`, async () => {
      const api = createAdminAuthApi(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, admin: { id: input, username: 'admin' } }),
      }))

      await assert.rejects(
        api.getCurrentAdmin(),
        (error) =>
          error instanceof AdminAuthApiError &&
          error.kind === 'protocol' &&
          error.status === null,
      )
    })
  }
})

test('current-session forwards an AbortSignal to fetch', async () => {
  const controller = new AbortController()
  let receivedSignal
  const api = createAdminAuthApi(async (_path, options) => {
    receivedSignal = options.signal
    return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
  })

  await api.getCurrentAdmin({ signal: controller.signal })
  assert.equal(receivedSignal, controller.signal)
})
