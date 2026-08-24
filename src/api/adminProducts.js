const maximumUnsignedBigIntString = '18446744073709551615'
const maximumUnsignedInt = 4_294_967_295
const maximumProductImageBytes = 5 * 1024 * 1024
const productFields = Object.freeze([
  'categoryId',
  'name',
  'description',
  'price',
  'sortOrder',
  'isAvailable',
  'isVisible',
])

export class AdminProductsApiError extends Error {
  constructor(message, { status = null, kind = 'http' } = {}) {
    super(message)
    this.name = 'AdminProductsApiError'
    this.status = status
    this.kind = kind
  }
}

function protocolError() {
  return new AdminProductsApiError('پاسخ سرویس محصولات معتبر نیست.', { kind: 'protocol' })
}

export function normalizeUnsignedBigIntId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw protocolError()
    }

    return String(value)
  }

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw protocolError()
  }

  if (
    value.length > maximumUnsignedBigIntString.length ||
    (value.length === maximumUnsignedBigIntString.length &&
      value > maximumUnsignedBigIntString)
  ) {
    throw protocolError()
  }

  return value
}

function normalizePrice(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw protocolError()
  }

  if (
    value.length > maximumUnsignedBigIntString.length ||
    (value.length === maximumUnsignedBigIntString.length &&
      value > maximumUnsignedBigIntString)
  ) {
    throw protocolError()
  }

  return value
}

function normalizeBoundedString(value, maximumCharacters, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim() === '') ||
    Array.from(value).length > maximumCharacters
  ) {
    throw protocolError()
  }

  return value
}

function assertPlainObject(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw protocolError()
  }
}

export function sanitizeProduct(value) {
  assertPlainObject(value)

  if (
    typeof value.isAvailable !== 'boolean' ||
    typeof value.isVisible !== 'boolean' ||
    !Number.isSafeInteger(value.sortOrder) ||
    value.sortOrder < 0 ||
    value.sortOrder > maximumUnsignedInt ||
    typeof value.imagePath !== 'string' ||
    !/^\/uploads\/products\/[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(value.imagePath) ||
    (value.description !== null && typeof value.description !== 'string')
  ) {
    throw protocolError()
  }

  if (
    value.description !== null &&
    new TextEncoder().encode(value.description).byteLength > 65_535
  ) {
    throw protocolError()
  }

  return Object.freeze({
    id: normalizeUnsignedBigIntId(value.id),
    categoryId: normalizeUnsignedBigIntId(value.categoryId),
    categoryName: normalizeBoundedString(value.categoryName, 100),
    name: normalizeBoundedString(value.name, 150),
    description: value.description,
    price: normalizePrice(value.price),
    imagePath: value.imagePath,
    sortOrder: value.sortOrder,
    isAvailable: value.isAvailable,
    isVisible: value.isVisible,
  })
}

function isFile(value) {
  return (
    typeof globalThis.File === 'function' &&
    value instanceof globalThis.File &&
    typeof value.name === 'string' &&
    typeof value.size === 'number' &&
    typeof value.type === 'string'
  )
}

function validateImageFile(file) {
  if (
    !isFile(file) ||
    file.size <= 0 ||
    file.size > maximumProductImageBytes ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
  ) {
    throw new AdminProductsApiError('یک تصویر معتبر JPEG، PNG یا WebP انتخاب کنید.', {
      kind: 'validation',
    })
  }
}

function pickMetadata(value, { partial = false } = {}) {
  assertPlainObject(value)
  const keys = Object.keys(value)

  if (keys.some((key) => !productFields.includes(key)) || (partial && keys.length === 0)) {
    throw new AdminProductsApiError('اطلاعات محصول معتبر نیست.', { kind: 'validation' })
  }

  if (!partial && productFields.some((field) => !Object.hasOwn(value, field))) {
    throw new AdminProductsApiError('اطلاعات محصول کامل نیست.', { kind: 'validation' })
  }

  return Object.fromEntries(
    productFields
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, value[field]]),
  )
}

function errorMessageForStatus(status) {
  if (status === 400) return 'اطلاعات یا تصویر محصول معتبر نیست.'
  if (status === 401) return 'نشست مدیریت منقضی شده است.'
  if (status === 404) return 'محصول یا دسته‌بندی موردنظر پیدا نشد.'
  if (status === 409) return 'عملیات محصول با وضعیت فعلی قابل انجام نیست.'
  if (status === 413) return 'حجم تصویر بیشتر از ۵ مگابایت است.'
  if (status === 415) return 'فرمت درخواست ایجاد محصول معتبر نیست.'
  return 'سرویس محصولات در حال حاضر در دسترس نیست.'
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function createAdminProductsApi(fetchImplementation = globalThis.fetch) {
  async function request(path = '', options = {}) {
    let response

    try {
      response = await fetchImplementation(`/api/admin/products${path}`, {
        ...options,
        credentials: 'include',
      })
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) {
        throw new AdminProductsApiError('درخواست محصولات لغو شد.', { kind: 'abort' })
      }

      throw new AdminProductsApiError('ارتباط با سرویس محصولات برقرار نشد.', {
        kind: 'network',
      })
    }

    const payload = await readJson(response)

    if (!response.ok) {
      throw new AdminProductsApiError(errorMessageForStatus(response.status), {
        status: response.status,
      })
    }

    if (!payload || payload.success !== true) {
      throw protocolError()
    }

    return payload
  }

  return Object.freeze({
    async list({ signal } = {}) {
      const payload = await request('', { signal })

      if (!Array.isArray(payload.products)) {
        throw protocolError()
      }

      return payload.products.map(sanitizeProduct)
    },

    async create(metadata, image, { signal } = {}) {
      validateImageFile(image)
      const formData = new FormData()
      formData.append('metadata', JSON.stringify(pickMetadata(metadata)))
      formData.append('image', image)
      const payload = await request('', { method: 'POST', body: formData, signal })
      return sanitizeProduct(payload.product)
    },

    async update(productId, changes, { signal } = {}) {
      const id = normalizeUnsignedBigIntId(productId)
      const payload = await request(`/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickMetadata(changes, { partial: true })),
        signal,
      })
      return sanitizeProduct(payload.product)
    },

    async replaceImage(productId, image, { signal } = {}) {
      validateImageFile(image)
      const id = normalizeUnsignedBigIntId(productId)
      const formData = new FormData()
      formData.append('image', image)
      const payload = await request(`/${id}/image`, {
        method: 'PUT',
        body: formData,
        signal,
      })
      return sanitizeProduct(payload.product)
    },

    async remove(productId, { signal } = {}) {
      const id = normalizeUnsignedBigIntId(productId)
      await request(`/${id}`, { method: 'DELETE', signal })
    },
  })
}

export const adminProductsApi = createAdminProductsApi()
