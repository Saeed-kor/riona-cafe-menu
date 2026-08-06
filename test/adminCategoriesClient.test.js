import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AdminCategoriesApiError,
  createAdminCategoriesApi,
} from '../src/api/adminCategories.js'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('category API client uses credentials and the expected CRUD contract', async () => {
  const requests = []
  const category = { id: '1', name: 'قهوه', sortOrder: 0, isVisible: true }
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
});

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
});
