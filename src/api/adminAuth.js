export class AdminAuthApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'AdminAuthApiError'
    this.status = status
  }
}

async function parseResponse(response) {
  let payload = null

  try {
    payload = await response.json()
  } catch {
    // A non-JSON error must still be handled without exposing its response body.
  }

  if (!response.ok) {
    throw new AdminAuthApiError(
      payload?.message || 'The authentication request could not be completed.',
      response.status,
    )
  }

  return payload
}

export function createAdminAuthApi(fetchImplementation = globalThis.fetch) {
  async function request(path, options = {}) {
    const response = await fetchImplementation(path, {
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
    async login(username, password) {
      const payload = await request('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })

      return payload.admin
    },

    async getCurrentAdmin() {
      const payload = await request('/api/admin/auth/me')
      return payload.admin
    },

    async logout() {
      await request('/api/admin/auth/logout', { method: 'POST' })
    },
  })
}

export const adminAuthApi = createAdminAuthApi()
