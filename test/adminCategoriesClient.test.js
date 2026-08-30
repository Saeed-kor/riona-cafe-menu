import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptedCategoryImageTypes,
  AdminCategoriesApiError,
  categoryImageAccept,
  createAdminCategoriesApi,
  maximumCategoryImageBytes,
  normalizeCategoryId,
  sanitizeCategory,
  validateCategoryImageFile,
} from '../src/api/adminCategories.js'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const managedCategoryImagePath = `/uploads/categories/${'a'.repeat(32)}.webp`

function validCategory(overrides = {}) {
  return {
    id: '1',
    name: 'Coffee',
    imagePath: null,
    sortOrder: 0,
    isVisible: true,
    ...overrides,
  }
}

function isProtocolError(error) {
  return (
    error instanceof AdminCategoriesApiError &&
    error.status === 0 &&
    error.kind === 'protocol' &&
    error.message === 'The category service returned an invalid response.'
  )
}

test('category API client uses credentials and the expected CRUD contract', async () => {
  const requests = []
  const category = validCategory()
  const responses = [
    jsonResponse({ success: true, categories: [category] }),
    jsonResponse({ success: true, category }),
    jsonResponse({ success: true, category: { ...category, isVisible: false } }),
    jsonResponse({ success: true, message: 'Category deleted' }),
  ]
  const api = createAdminCategoriesApi(async (path, options) => {
    requests.push({ path, options })
    return responses.shift()
  })

  assert.deepEqual(await api.list(), [category])
  assert.deepEqual(await api.create(category), category)
  assert.equal((await api.update('1', { isVisible: false })).isVisible, false)
  await api.remove('1')

  assert.deepEqual(
    requests.map(({ path, options }) => ({
      path,
      method: options.method ?? 'GET',
      credentials: options.credentials,
    })),
    [
      { path: '/api/admin/categories', method: 'GET', credentials: 'include' },
      { path: '/api/admin/categories', method: 'POST', credentials: 'include' },
      { path: '/api/admin/categories/1', method: 'PATCH', credentials: 'include' },
      { path: '/api/admin/categories/1', method: 'DELETE', credentials: 'include' },
    ],
  )

  assert.equal(requests[1].options.headers['Content-Type'], 'application/json')
  assert.equal(requests[2].options.headers['Content-Type'], 'application/json')
})

test('category sanitizer preserves only the canonical production response contract', () => {
  const maximumId = '18446744073709551615'
  const rawCategory = {
    ...validCategory({ id: maximumId, imagePath: managedCategoryImagePath }),
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    password_hash: 'must-not-cross-the-client-boundary',
    unknown: true,
  }
  const category = sanitizeCategory(rawCategory)

  assert.deepEqual(category, {
    id: maximumId,
    name: 'Coffee',
    imagePath: managedCategoryImagePath,
    sortOrder: 0,
    isVisible: true,
  })
  assert.equal(Object.isFrozen(category), true)
  assert.equal('password_hash' in category, false)
  assert.equal('unknown' in category, false)
  assert.equal(normalizeCategoryId(42), '42')
  assert.equal(normalizeCategoryId(maximumId), maximumId)

  const invalidIds = [
    '',
    '0',
    '00',
    '01',
    '-1',
    '+1',
    '1.0',
    '1e3',
    ' 1',
    '1 ',
    '../1',
    '1/../2',
    '۱۲۳',
    '18446744073709551616',
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
    {},
    [],
  ]

  for (const invalidId of invalidIds) {
    assert.throws(() => normalizeCategoryId(invalidId), isProtocolError)
  }

  const malformedCategories = [
    null,
    [],
    {},
    validCategory({ id: '0' }),
    validCategory({ name: ' Coffee' }),
    validCategory({ name: '' }),
    validCategory({ sortOrder: -1 }),
    validCategory({ sortOrder: 1.5 }),
    validCategory({ isVisible: 1 }),
    validCategory({ imagePath: '/uploads/categories/../unsafe.webp' }),
    validCategory({ imagePath: '/uploads/categories/category.webp' }),
  ]

  for (const malformedCategory of malformedCategories) {
    assert.throws(() => sanitizeCategory(malformedCategory), isProtocolError)
  }
})

test('category client rejects malformed 200 responses for every response-bearing endpoint', async () => {
  const image = new File(['valid image'], 'category.png', { type: 'image/png' })
  const cases = [
    {
      payload: { success: true, categories: {} },
      invoke: (api) => api.list(),
    },
    {
      payload: { success: true, categories: [validCategory(), {}] },
      invoke: (api) => api.list(),
    },
    {
      payload: { success: true, category: {} },
      invoke: (api) => api.create({ name: 'Coffee' }),
    },
    {
      payload: { success: true, category: validCategory({ id: '0' }) },
      invoke: (api) => api.update('1', { isVisible: false }),
    },
    {
      payload: { success: true, category: validCategory({ imagePath: '/unsafe.png' }) },
      invoke: (api) => api.replaceImage('1', image),
    },
    {
      payload: { success: true, category: null },
      invoke: (api) => api.removeImage('1'),
    },
    {
      payload: { message: 'Category deleted' },
      invoke: (api) => api.remove('1'),
    },
  ]

  for (const { payload, invoke } of cases) {
    const api = createAdminCategoriesApi(async () => jsonResponse(payload))
    await assert.rejects(invoke(api), isProtocolError)
  }
})

test('category resource IDs are canonicalized before safe URL construction', async () => {
  const requests = []
  const image = new File(['valid image'], 'category.png', { type: 'image/png' })
  const api = createAdminCategoriesApi(async (path, options) => {
    requests.push({ path, method: options.method })

    if (options.method === 'DELETE' && !path.endsWith('/image')) {
      return jsonResponse({ success: true, message: 'Category deleted' })
    }

    const id = path.match(/\/categories\/([0-9]+)/u)?.[1] ?? '1'
    return jsonResponse({ success: true, category: validCategory({ id }) })
  })

  await api.update(42, { isVisible: false })
  await api.remove('18446744073709551615')
  await api.replaceImage('41', image)
  await api.removeImage('41')

  assert.deepEqual(
    requests.map(({ path }) => path),
    [
      '/api/admin/categories/42',
      '/api/admin/categories/18446744073709551615',
      '/api/admin/categories/41/image',
      '/api/admin/categories/41/image',
    ],
  )

  const requestCount = requests.length
  const invalidIds = [
    '../1',
    '1/../2',
    '%2f',
    '01',
    '18446744073709551616',
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
  ]

  for (const invalidId of invalidIds) {
    await assert.rejects(api.update(invalidId, { isVisible: false }), isProtocolError)
    await assert.rejects(api.remove(invalidId), isProtocolError)
    await assert.rejects(api.replaceImage(invalidId, image), isProtocolError)
    await assert.rejects(api.removeImage(invalidId), isProtocolError)
  }

  assert.equal(requests.length, requestCount)
})

test('category image API sends the exact multipart field without setting Content-Type', async () => {
  const requests = []
  const category = {
    id: '41',
    name: 'قهوه',
    imagePath: managedCategoryImagePath,
    sortOrder: 0,
    isVisible: true,
  }
  const responses = [
    jsonResponse({ success: true, category }),
    jsonResponse({ success: true, category: { ...category, imagePath: null } }),
  ]
  const api = createAdminCategoriesApi(async (path, options) => {
    requests.push({ path, options })
    return responses.shift()
  })
  const image = new File(['valid image bytes'], 'coffee.JPEG', { type: 'image/jpeg' })

  assert.deepEqual(await api.replaceImage('41', image), category)
  assert.equal((await api.removeImage('41')).imagePath, null)

  assert.equal(requests[0].path, '/api/admin/categories/41/image')
  assert.equal(requests[0].options.method, 'PUT')
  assert.equal(requests[0].options.credentials, 'include')
  assert.equal(requests[0].options.body instanceof FormData, true)
  assert.equal(new Headers(requests[0].options.headers).has('content-type'), false)
  assert.deepEqual([...requests[0].options.body.keys()], ['image'])
  assert.equal(requests[0].options.body.getAll('image').length, 1)

  const uploadedImage = requests[0].options.body.get('image')
  assert.equal(uploadedImage.name, image.name)
  assert.equal(uploadedImage.type, image.type)
  assert.equal(uploadedImage.size, image.size)
  assert.deepEqual(
    requests.slice(1).map(({ path, options }) => ({
      path,
      method: options.method,
      credentials: options.credentials,
    })),
    [
      {
        path: '/api/admin/categories/41/image',
        method: 'DELETE',
        credentials: 'include',
      },
    ],
  )
})

test('category image validator matches the production file type and size boundary', async () => {
  assert.deepEqual(acceptedCategoryImageTypes, ['image/jpeg', 'image/png', 'image/webp'])
  assert.equal(categoryImageAccept, 'image/jpeg,image/png,image/webp')

  const maximumImage = new File(
    [new Uint8Array(maximumCategoryImageBytes)],
    'maximum.webp',
    { type: 'image/webp' },
  )
  assert.equal(validateCategoryImageFile(maximumImage), maximumImage)

  const invalidImages = [
    new File([], 'empty.png', { type: 'image/png' }),
    new File([new Uint8Array(maximumCategoryImageBytes + 1)], 'large.png', {
      type: 'image/png',
    }),
    new File(['image'], 'wrong.gif', { type: 'image/gif' }),
    new File(['image'], 'mismatch.jpg', { type: 'image/png' }),
    new File(['image'], 'missing-extension', { type: 'image/png' }),
    new File(['image'], '../unsafe.png', { type: 'image/png' }),
    new File(['image'], 'folder\\unsafe.png', { type: 'image/png' }),
    new File(['image'], 'C:unsafe.png', { type: 'image/png' }),
    new File(['image'], 'c:unsafe.png', { type: 'image/png' }),
    new Blob(['image'], { type: 'image/png' }),
    null,
  ]

  for (const invalidImage of invalidImages) {
    assert.throws(
      () => validateCategoryImageFile(invalidImage),
      (error) => error instanceof AdminCategoriesApiError && error.status === 400,
    )
  }

  let requests = 0
  const api = createAdminCategoriesApi(async () => {
    requests += 1
    return jsonResponse({ success: true, category: {} })
  })

  await assert.rejects(api.replaceImage('1', invalidImages[2]), AdminCategoriesApiError)
  assert.equal(requests, 0)
})

test('category JSON requests remain safe when FormData is not defined', async () => {
  const formDataDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FormData')
  const requests = []

  try {
    Object.defineProperty(globalThis, 'FormData', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const category = validCategory({ name: 'Tea' })
    const api = createAdminCategoriesApi(async (path, options) => {
      requests.push({ path, options })
      return jsonResponse({ success: true, category })
    })

    assert.deepEqual(await api.create(category), category)
    assert.equal(requests[0].options.headers['Content-Type'], 'application/json')
    assert.equal(requests[0].options.body, JSON.stringify(category))
    await assert.rejects(
      api.replaceImage(
        '1',
        new File(['valid image'], 'category.png', { type: 'image/png' }),
      ),
      (error) =>
        error instanceof AdminCategoriesApiError &&
        error.status === 0 &&
        error.message === 'Category image upload is unavailable.',
    )
    assert.equal(requests.length, 1)
  } finally {
    Object.defineProperty(globalThis, 'FormData', formDataDescriptor)
  }
})

test('category API client preserves safe API errors and status codes', async () => {
  const api = createAdminCategoriesApi(async () =>
    jsonResponse({ success: false, message: 'A category with this name already exists' }, 409),
  )

  await assert.rejects(
    api.create({ name: 'قهوه' }),
    (error) =>
      error instanceof AdminCategoriesApiError &&
      error.status === 409 &&
      error.message === 'A category with this name already exists',
  )
})
