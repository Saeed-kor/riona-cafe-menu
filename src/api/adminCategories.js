export class AdminCategoriesApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'AdminCategoriesApiError'
    this.status = status
  }
}

async function parseResponse(response) {
  let payload = null

  try {
    payload = await response.json()
  } catch {
    // Error bodies are deliberately not exposed when the API does not return JSON.
  }

  if (!response.ok) {
    throw new AdminCategoriesApiError(
      payload?.message || 'The category request could not be completed.',
      response.status,
    )
  }

  return payload
}

export function createAdminCategoriesApi(fetchImplementation = globalThis.fetch) {
  async function request(path = '', options = {}) {
    const response = await fetchImplementation(`/api/admin/categories${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })

    return parseResponse(response)
  }

  return Object.freeze({
    async list() {
      const payload = await request()
      return payload.categories
    },

    async create(category) {
      const payload = await request('', {
        method: 'POST',
        body: JSON.stringify(category),
      })
      return payload.category
    },

    async update(categoryId, changes) {
      const payload = await request(`/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      })
      return payload.category
    },

    async remove(categoryId) {
      await request(`/${categoryId}`, { method: 'DELETE' })
    },
  })
}

export const adminCategoriesApi = createAdminCategoriesApi()
