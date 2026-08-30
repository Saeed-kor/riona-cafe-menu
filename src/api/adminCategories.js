export class AdminCategoriesApiError extends Error {
  constructor(message, status, { kind = 'http' } = {}) {
    super(message)
    this.name = 'AdminCategoriesApiError'
    this.status = status
    this.kind = kind
  }
}

export const maximumCategoryImageBytes = 5 * 1024 * 1024
export const acceptedCategoryImageTypes = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
])
export const categoryImageAccept = acceptedCategoryImageTypes.join(',')

const acceptedCategoryImageExtensions = Object.freeze({
  'image/jpeg': Object.freeze(['jpg', 'jpeg']),
  'image/png': Object.freeze(['png']),
  'image/webp': Object.freeze(['webp']),
})
const maximumUnsignedBigIntId = '18446744073709551615'
const maximumCategoryNameCharacters = 100
const maximumSortOrder = 4_294_967_295
const managedCategoryImagePathPattern =
  /^\/uploads\/categories\/[a-f0-9]{32}\.(?:jpg|png|webp)$/u

function protocolError() {
  return new AdminCategoriesApiError(
    'The category service returned an invalid response.',
    0,
    { kind: 'protocol' },
  )
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeCategoryId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw protocolError()
    }

    return String(value)
  }

  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value)) {
    throw protocolError()
  }

  if (
    value.length > maximumUnsignedBigIntId.length ||
    (value.length === maximumUnsignedBigIntId.length && value > maximumUnsignedBigIntId)
  ) {
    throw protocolError()
  }

  return value
}

export function sanitizeCategory(value) {
  if (!isPlainObject(value)) {
    throw protocolError()
  }

  const id = normalizeCategoryId(value.id)
  const name = value.name
  const imagePath = value.imagePath ?? null

  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name !== name.trim() ||
    Array.from(name).length > maximumCategoryNameCharacters ||
    !Number.isInteger(value.sortOrder) ||
    value.sortOrder < 0 ||
    value.sortOrder > maximumSortOrder ||
    typeof value.isVisible !== 'boolean' ||
    (imagePath !== null &&
      (typeof imagePath !== 'string' || !managedCategoryImagePathPattern.test(imagePath)))
  ) {
    throw protocolError()
  }

  return Object.freeze({
    id,
    name,
    imagePath,
    sortOrder: value.sortOrder,
    isVisible: value.isVisible,
  })
}

function isFile(value) {
  return (
    typeof globalThis.File === 'function' &&
    value instanceof globalThis.File &&
    typeof value.name === 'string'
  )
}

function hasSafeOriginalName(fileName) {
  return (
    typeof fileName === 'string' &&
    fileName !== '' &&
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    !/^[a-z]:/iu.test(fileName)
  )
}

export function validateCategoryImageFile(file) {
  const extension = isFile(file) ? file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] : null
  const acceptedExtensions = isFile(file) ? acceptedCategoryImageExtensions[file.type] : null

  if (
    !isFile(file) ||
    file.size <= 0 ||
    file.size > maximumCategoryImageBytes ||
    !hasSafeOriginalName(file.name) ||
    !acceptedCategoryImageTypes.includes(file.type) ||
    !acceptedExtensions?.includes(extension)
  ) {
    throw new AdminCategoriesApiError(
      'Category image must be a JPEG, PNG, or WebP file up to 5 MiB.',
      400,
    )
  }

  return file
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
      typeof payload?.message === 'string' && payload.message.length > 0
        ? payload.message
        : 'The category request could not be completed.',
      response.status,
    )
  }

  if (!isPlainObject(payload) || payload.success !== true) {
    throw protocolError()
  }

  return payload
}

export function createAdminCategoriesApi(fetchImplementation = globalThis.fetch) {
  async function request(path = '', options = {}) {
    const hasJsonBody =
      options.body !== undefined &&
      !(typeof globalThis.FormData === 'function' && options.body instanceof globalThis.FormData)
    const response = await fetchImplementation(`/api/admin/categories${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })

    return parseResponse(response)
  }

  function categoryPath(categoryId, suffix = '') {
    const canonicalId = normalizeCategoryId(categoryId)
    return `/${encodeURIComponent(canonicalId)}${suffix}`
  }

  return Object.freeze({
    async list({ signal } = {}) {
      const payload = await request('', { signal })
      if (!Array.isArray(payload.categories)) {
        throw protocolError()
      }

      return Object.freeze(payload.categories.map(sanitizeCategory))
    },

    async create(category) {
      const payload = await request('', {
        method: 'POST',
        body: JSON.stringify(category),
      })
      return sanitizeCategory(payload.category)
    },

    async update(categoryId, changes) {
      const payload = await request(categoryPath(categoryId), {
        method: 'PATCH',
        body: JSON.stringify(changes),
      })
      return sanitizeCategory(payload.category)
    },

    async remove(categoryId) {
      await request(categoryPath(categoryId), { method: 'DELETE' })
    },

    async replaceImage(categoryId, image) {
      validateCategoryImageFile(image)

      if (typeof globalThis.FormData !== 'function') {
        throw new AdminCategoriesApiError('Category image upload is unavailable.', 0)
      }

      const formData = new globalThis.FormData()
      formData.append('image', image)
      const payload = await request(categoryPath(categoryId, '/image'), {
        method: 'PUT',
        body: formData,
      })
      return sanitizeCategory(payload.category)
    },

    async removeImage(categoryId) {
      const payload = await request(categoryPath(categoryId, '/image'), { method: 'DELETE' })
      return sanitizeCategory(payload.category)
    },
  })
}

export const adminCategoriesApi = createAdminCategoriesApi()
