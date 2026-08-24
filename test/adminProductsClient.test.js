import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import test from 'node:test'

import {
  AdminProductsApiError,
  createAdminProductsApi,
  normalizeUnsignedBigIntId,
  sanitizeProduct,
} from '../src/api/adminProducts.js'

const imagePath = `/uploads/products/${'ab'.repeat(16)}.png`

function product(overrides = {}) {
  return {
    id: '9007199254740992',
    categoryId: '18446744073709551615',
    categoryName: 'نوشیدنی گرم',
    name: 'لاته',
    description: null,
    price: '18446744073709551615',
    imagePath,
    sortOrder: 0,
    isAvailable: false,
    isVisible: true,
    password_hash: 'must-be-removed',
    token: 'must-be-removed',
    ...overrides,
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('sanitizes the exact Product response without BIGINT or price precision loss', () => {
  const sanitized = sanitizeProduct(product())

  assert.deepEqual(sanitized, {
    id: '9007199254740992',
    categoryId: '18446744073709551615',
    categoryName: 'نوشیدنی گرم',
    name: 'لاته',
    description: null,
    price: '18446744073709551615',
    imagePath,
    sortOrder: 0,
    isAvailable: false,
    isVisible: true,
  })
  assert.equal(Object.hasOwn(sanitized, 'password_hash'), false)
  assert.equal(Object.hasOwn(sanitized, 'token'), false)
  assert.equal(normalizeUnsignedBigIntId(42), '42')
});

test('rejects malformed successful products and every unsafe canonical field', () => {
  for (const value of [
    null,
    [],
    product({ id: '01' }),
    product({ id: '18446744073709551616' }),
    product({ categoryId: Number.MAX_SAFE_INTEGER + 1 }),
    product({ categoryId: '0' }),
    product({ price: '01' }),
    product({ price: '1e3' }),
    product({ price: '18446744073709551616' }),
    product({ imagePath: null }),
    product({ imagePath: '/uploads/categories/abc.png' }),
    product({ sortOrder: -1 }),
    product({ sortOrder: 4_294_967_296 }),
    product({ isVisible: 1 }),
    product({ isAvailable: 'true' }),
    product({ categoryName: '' }),
    product({ name: '' }),
    product({ description: {} }),
  ]) {
    assert.throws(() => sanitizeProduct(value), AdminProductsApiError)
  }
});

test('uses credentials, AbortSignal, exact FormData and JSON contracts for Product CRUD', async () => {
  const calls = []
  const api = createAdminProductsApi(async (path, options) => {
    calls.push({ path, options })

    if ((options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, products: [product()] })
    }

    if (options.method === 'DELETE') {
      return jsonResponse({ success: true, message: 'Product deleted' })
    }

    return jsonResponse({ success: true, product: product({ id: '1' }) }, options.method === 'POST' ? 201 : 200)
  })
  const controller = new AbortController()
  const image = new File(['image'], 'latte.png', { type: 'image/png' })
  const metadata = {
    categoryId: '18446744073709551615',
    name: 'لاته',
    description: null,
    price: '18446744073709551615',
    sortOrder: 0,
    isAvailable: false,
    isVisible: true,
    ignored: 'must-not-leave-the-client',
  }

  await assert.rejects(
    api.create(
      metadata,
      {
        name: 'spoofed.png',
        size: 1,
        type: 'image/png',
        [Symbol.toStringTag]: 'File',
      },
      { signal: controller.signal },
    ),
    (error) => error.kind === 'validation',
  )

  await api.list({ signal: controller.signal })
  await assert.rejects(
    api.create(metadata, image, { signal: controller.signal }),
    (error) => error.kind === 'validation',
  )
  delete metadata.ignored
  await api.create(metadata, image, { signal: controller.signal })
  await api.update('1', { price: '0', isAvailable: true }, { signal: controller.signal })
  await api.replaceImage('1', image, { signal: controller.signal })
  await api.remove('1', { signal: controller.signal })

  assert.equal(calls.length, 5)
  for (const call of calls) {
    assert.equal(call.options.credentials, 'include')
    assert.equal(call.options.signal, controller.signal)
  }

  const createCall = calls[1]
  assert.equal(createCall.path, '/api/admin/products')
  assert.equal(createCall.options.method, 'POST')
  assert.equal(createCall.options.body instanceof FormData, true)
  assert.equal(createCall.options.headers, undefined)
  assert.deepEqual(JSON.parse(createCall.options.body.get('metadata')), metadata)
  assert.equal(createCall.options.body.get('image').name, 'latte.png')

  const updateCall = calls[2]
  assert.equal(updateCall.path, '/api/admin/products/1')
  assert.deepEqual(JSON.parse(updateCall.options.body), { price: '0', isAvailable: true })
  assert.equal(updateCall.options.headers['Content-Type'], 'application/json')

  const replaceCall = calls[3]
  assert.equal(replaceCall.path, '/api/admin/products/1/image')
  assert.equal(replaceCall.options.body instanceof FormData, true)
  assert.equal(replaceCall.options.headers, undefined)
  assert.equal(calls[4].options.method, 'DELETE')
});

test('rejects malformed 200/201 payloads, empty responses, and unsafe status details', async () => {
  for (const response of [
    jsonResponse({ success: false, products: [] }),
    jsonResponse({ success: true }),
    jsonResponse({ success: true, products: [product({ imagePath: 'C:\\private\\x.png' })] }),
    new Response('', { status: 200 }),
  ]) {
    const api = createAdminProductsApi(async () => response)
    await assert.rejects(api.list(), (error) => error.kind === 'protocol')
  }

  for (const status of [400, 401, 404, 409, 413, 415, 500]) {
    const api = createAdminProductsApi(async () =>
      jsonResponse({ success: false, message: 'SELECT secret FROM menu_items C:\\private' }, status),
    )
    await assert.rejects(
      api.list(),
      (error) =>
        error.status === status &&
        error.message.includes('SELECT') === false &&
        error.message.includes('private') === false,
    )
  }
});

test('distinguishes abort and network failures without retaining raw errors', async () => {
  const abortController = new AbortController()
  abortController.abort()
  const abortedApi = createAdminProductsApi(async () => {
    throw Object.assign(new Error('private abort payload'), { name: 'AbortError' })
  })
  await assert.rejects(
    abortedApi.list({ signal: abortController.signal }),
    (error) => error.kind === 'abort' && error.message.includes('private') === false,
  )

  const networkApi = createAdminProductsApi(async () => {
    throw new Error('private network payload')
  })
  await assert.rejects(
    networkApi.list(),
    (error) => error.kind === 'network' && error.message.includes('private') === false,
  )
});
