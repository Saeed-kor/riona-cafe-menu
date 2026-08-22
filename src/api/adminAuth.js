export class AdminAuthApiError extends Error {
  constructor(kind, status = null) {
    const messages = {
      aborted: 'The authentication request was cancelled.',
      http: 'The authentication request was rejected.',
      network: 'The authentication service could not be reached.',
      protocol: 'The authentication service returned an invalid response.',
    }

    super(messages[kind] ?? messages.protocol)
    this.name = 'AdminAuthApiError'
    this.kind = kind
    this.status = status
  }
}

const maximumUnsignedBigIntId = '18446744073709551615'

async function parseResponse(response) {
  let payload = null

  try {
    payload = await response.json()
  } catch {
    // A non-JSON error must still be handled without exposing its response body.
  }

  if (!response.ok) {
    throw new AdminAuthApiError('http', response.status)
  }

  return payload
}

function normalizeAdminId(id) {
  if (typeof id === 'number') {
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null
  }

  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) {
    return null
  }

  if (
    id.length > maximumUnsignedBigIntId.length ||
    (id.length === maximumUnsignedBigIntId.length && id > maximumUnsignedBigIntId)
  ) {
    return null
  }

  return id
}

function sanitizeAdmin(value) {
  const id = normalizeAdminId(value?.id)
  const username = typeof value?.username === 'string' ? value.username.trim() : ''

  if (!id || !username) {
    throw new AdminAuthApiError('protocol')
  }

  return Object.freeze({
    id,
    username,
  })
}

function normalizeBaseUrl(baseUrl) {
  return typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
}

export function createAdminAuthApi(
  fetchImplementation = globalThis.fetch,
  { baseUrl = '' } = {},
) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

  async function request(path, options = {}) {
    let response

    try {
      response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
        ...options,
        credentials: 'include',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      })
    } catch (error) {
      throw new AdminAuthApiError(error?.name === 'AbortError' ? 'aborted' : 'network')
    }

    return parseResponse(response)
  }

  return Object.freeze({
    async login(username, password, { signal } = {}) {
      const payload = await request('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        signal,
      })

      if (payload?.success !== true) {
        throw new AdminAuthApiError('protocol')
      }

      return sanitizeAdmin(payload?.admin)
    },

    async getCurrentAdmin({ signal } = {}) {
      const payload = await request('/api/admin/auth/me', { signal })

      if (payload?.success !== true) {
        throw new AdminAuthApiError('protocol')
      }

      return sanitizeAdmin(payload?.admin)
    },

    async logout({ signal } = {}) {
      await request('/api/admin/auth/logout', { method: 'POST', signal })
    },
  })
}

export const adminAuthApi = createAdminAuthApi()
