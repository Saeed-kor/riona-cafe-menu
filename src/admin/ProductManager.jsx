import { useEffect, useRef, useState } from 'react'

import { adminCategoriesApi } from '../api/adminCategories.js'
import { adminProductsApi } from '../api/adminProducts.js'

const maximumUnsignedBigIntString = '18446744073709551615'
const maximumSortOrder = 4_294_967_295
const maximumImageBytes = 5 * 1024 * 1024
const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp']

function compareCanonicalIds(first, second) {
  if (first.length !== second.length) return first.length - second.length
  return first < second ? -1 : first > second ? 1 : 0
}

function sortProducts(products) {
  return [...products].sort(
    (first, second) =>
      first.sortOrder - second.sortOrder || compareCanonicalIds(first.id, second.id),
  )
}

function sanitizeCategories(categories) {
  if (!Array.isArray(categories)) throw new Error('Invalid categories response')

  return categories.map((category) => {
    if (
      !category ||
      typeof category !== 'object' ||
      typeof category.id !== 'string' ||
      !/^[1-9]\d*$/.test(category.id) ||
      category.id.length > maximumUnsignedBigIntString.length ||
      (category.id.length === maximumUnsignedBigIntString.length &&
        category.id > maximumUnsignedBigIntString) ||
      typeof category.name !== 'string' ||
      category.name.trim() === ''
    ) {
      throw new Error('Invalid categories response')
    }

    return Object.freeze({ id: category.id, name: category.name })
  })
}

function formatTomanPrice(price) {
  return price.replace(/\B(?=(\d{3})+(?!\d))/g, '٬')
}

function validatePrice(price) {
  return (
    /^(0|[1-9]\d*)$/.test(price) &&
    (price.length < maximumUnsignedBigIntString.length ||
      (price.length === maximumUnsignedBigIntString.length &&
        price <= maximumUnsignedBigIntString))
  )
}

function validateProductValues(values, categories, { imageRequired }) {
  const name = values.name.trim()

  if (!name || Array.from(name).length > 150) {
    return { field: 'name', message: 'نام محصول باید بین ۱ تا ۱۵۰ نویسه باشد.' }
  }

  if (!categories.some((category) => category.id === values.categoryId)) {
    return { field: 'categoryId', message: 'یک دسته‌بندی معتبر انتخاب کنید.' }
  }

  if (!validatePrice(values.price)) {
    return { field: 'price', message: 'قیمت باید عدد صحیح تومان و در محدودهٔ مجاز باشد.' }
  }

  if (!/^\d+$/.test(values.sortOrder)) {
    return { field: 'sortOrder', message: 'ترتیب نمایش باید عدد صحیح نامنفی باشد.' }
  }

  const sortOrder = Number(values.sortOrder)

  if (!Number.isSafeInteger(sortOrder) || sortOrder > maximumSortOrder) {
    return { field: 'sortOrder', message: 'ترتیب نمایش خارج از محدودهٔ مجاز است.' }
  }

  if (new TextEncoder().encode(values.description).byteLength > 65_535) {
    return { field: 'description', message: 'توضیحات محصول بیش از حد طولانی است.' }
  }

  if (imageRequired && !values.image) {
    return { field: 'image', message: 'انتخاب تصویر محصول الزامی است.' }
  }

  if (
    values.image &&
    (!acceptedImageTypes.includes(values.image.type) ||
      values.image.size <= 0 ||
      values.image.size > maximumImageBytes)
  ) {
    return {
      field: 'image',
      message: 'تصویر باید JPEG، PNG یا WebP و حداکثر ۵ مگابایت باشد.',
    }
  }

  return {
    metadata: {
      categoryId: values.categoryId,
      name,
      description: values.description === '' ? null : values.description,
      price: values.price,
      sortOrder,
      isVisible: values.isVisible,
      isAvailable: values.isAvailable,
    },
  }
}

function useObjectUrl(file) {
  const [previewUrl, setPreviewUrl] = useState(null)

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setPreviewUrl(null)
      return undefined
    }

    const nextUrl = URL.createObjectURL(file)
    setPreviewUrl(nextUrl)

    return () => URL.revokeObjectURL(nextUrl)
  }, [file])

  return previewUrl
}

function ProductForm({ categories, initialProduct = null, busy, disabled, onSubmit, onCancel }) {
  const isCreate = initialProduct === null
  const [values, setValues] = useState(() => ({
    categoryId: initialProduct?.categoryId ?? categories[0]?.id ?? '',
    name: initialProduct?.name ?? '',
    description: initialProduct?.description ?? '',
    price: initialProduct?.price ?? '',
    sortOrder: String(initialProduct?.sortOrder ?? 0),
    isVisible: initialProduct?.isVisible ?? true,
    isAvailable: initialProduct?.isAvailable ?? true,
    image: null,
  }))
  const [validationError, setValidationError] = useState(null)
  const [fileInputVersion, setFileInputVersion] = useState(0)
  const submitLockRef = useRef(false)
  const fieldRefs = useRef({})
  const previewUrl = useObjectUrl(values.image)
  const formId = initialProduct ? `edit-product-${initialProduct.id}` : 'create-product'

  function updateField(field, value) {
    setValues((current) => ({ ...current, [field]: value }))
    if (validationError?.field === field) setValidationError(null)
  }

  function resetCreateForm() {
    setValues({
      categoryId: categories[0]?.id ?? '',
      name: '',
      description: '',
      price: '',
      sortOrder: '0',
      isVisible: true,
      isAvailable: true,
      image: null,
    })
    setFileInputVersion((version) => version + 1)
    setValidationError(null)
  }

  function handleReset(event) {
    event.preventDefault()
    if (!isCreate || disabled) return
    resetCreateForm()
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (submitLockRef.current || disabled) return

    const validation = validateProductValues(values, categories, { imageRequired: isCreate })

    if (validation.message) {
      setValidationError(validation)
      fieldRefs.current[validation.field]?.focus()
      return
    }

    let metadata = validation.metadata

    if (!isCreate) {
      metadata = Object.fromEntries(
        Object.entries(metadata).filter(([field, value]) => {
          const initialValue = initialProduct[field]
          return value !== initialValue
        }),
      )

      if (Object.keys(metadata).length === 0) {
        setValidationError({ field: 'form', message: 'تغییری برای ذخیره وجود ندارد.' })
        return
      }
    }

    submitLockRef.current = true

    try {
      const succeeded = await onSubmit(metadata, values.image)

      if (succeeded && isCreate) {
        resetCreateForm()
      }
    } finally {
      submitLockRef.current = false
    }
  }

  function fieldError(field) {
    return validationError?.field === field ? validationError.message : ''
  }

  function describedBy(field, helpId) {
    return `${helpId}${fieldError(field) ? ` ${formId}-${field}-error` : ''}`
  }

  return (
    <form
      className={`product-form product-form--${isCreate ? 'create' : 'edit'}`}
      onSubmit={handleSubmit}
      onReset={isCreate ? handleReset : undefined}
      noValidate
      aria-busy={busy}
    >
      <div className="product-form__layout">
        <div className="product-form__group product-form__group--details" role="group" aria-labelledby={`${formId}-details-title`}>
          <div className="product-form__group-heading">
            <p id={`${formId}-details-title`}>اطلاعات اصلی</p>
            <span>مشخصات قابل مشاهده در منوی کافه</span>
          </div>

          <div className="product-form__field">
            <label htmlFor={`${formId}-name`}>نام محصول</label>
            <input
              ref={(node) => { fieldRefs.current.name = node }}
              id={`${formId}-name`}
              value={values.name}
              onChange={(event) => updateField('name', event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldError('name'))}
              aria-describedby={describedBy('name', `${formId}-name-help`)}
              required
            />
            <span id={`${formId}-name-help`} className="product-form__help">حداکثر ۱۵۰ نویسه</span>
            {fieldError('name') ? <span id={`${formId}-name-error`} className="product-form__error" role="alert">{fieldError('name')}</span> : null}
          </div>

          <div className="product-form__field">
            <label htmlFor={`${formId}-category`}>دسته‌بندی</label>
            <select
              ref={(node) => { fieldRefs.current.categoryId = node }}
              id={`${formId}-category`}
              value={values.categoryId}
              onChange={(event) => updateField('categoryId', event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldError('categoryId'))}
              aria-describedby={fieldError('categoryId') ? `${formId}-categoryId-error` : undefined}
              required
            >
              <option value="">انتخاب دسته‌بندی</option>
              {categories.map((category) => (
                <option value={category.id} key={category.id}>{category.name}</option>
              ))}
            </select>
            {fieldError('categoryId') ? (
              <span id={`${formId}-categoryId-error`} className="product-form__error" role="alert">
                {fieldError('categoryId')}
              </span>
            ) : null}
          </div>

          <div className="product-form__inline-fields">
            <div className="product-form__field">
              <label htmlFor={`${formId}-price`}>قیمت (تومان)</label>
              <input
                ref={(node) => { fieldRefs.current.price = node }}
                id={`${formId}-price`}
                value={values.price}
                onChange={(event) => updateField('price', event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                disabled={disabled}
                aria-invalid={Boolean(fieldError('price'))}
                aria-describedby={describedBy('price', `${formId}-price-help`)}
                required
              />
              <span id={`${formId}-price-help`} className="product-form__help">مبلغ صحیح بدون جداکننده و بر حسب تومان</span>
              {fieldError('price') ? <span id={`${formId}-price-error`} className="product-form__error" role="alert">{fieldError('price')}</span> : null}
            </div>

            <div className="product-form__field">
              <label htmlFor={`${formId}-order`}>ترتیب نمایش</label>
              <input
                ref={(node) => { fieldRefs.current.sortOrder = node }}
                id={`${formId}-order`}
                value={values.sortOrder}
                onChange={(event) => updateField('sortOrder', event.target.value)}
                inputMode="numeric"
                disabled={disabled}
                aria-invalid={Boolean(fieldError('sortOrder'))}
                aria-describedby={fieldError('sortOrder') ? `${formId}-sortOrder-error` : undefined}
              />
              {fieldError('sortOrder') ? <span id={`${formId}-sortOrder-error`} className="product-form__error" role="alert">{fieldError('sortOrder')}</span> : null}
            </div>
          </div>

          <div className="product-form__field">
            <label htmlFor={`${formId}-description`}>توضیحات (اختیاری)</label>
            <textarea
              ref={(node) => { fieldRefs.current.description = node }}
              id={`${formId}-description`}
              value={values.description}
              onChange={(event) => updateField('description', event.target.value)}
              disabled={disabled}
              aria-invalid={Boolean(fieldError('description'))}
              aria-describedby={fieldError('description') ? `${formId}-description-error` : undefined}
              rows="3"
            />
            {fieldError('description') ? <span id={`${formId}-description-error`} className="product-form__error" role="alert">{fieldError('description')}</span> : null}
          </div>
        </div>

        <div className="product-form__side">
          {isCreate ? (
            <div className="product-form__group product-form__group--image" role="group" aria-labelledby={`${formId}-image-title`}>
              <div className="product-form__group-heading">
                <p id={`${formId}-image-title`}>تصویر محصول</p>
                <span>برای کارت محصول یک تصویر روشن انتخاب کنید</span>
              </div>
              <div className="product-upload">
                <div className="product-upload__picker">
                  <input
                    key={`${formId}-image-${fileInputVersion}`}
                    ref={(node) => { fieldRefs.current.image = node }}
                    className="product-file-input"
                    id={`${formId}-image`}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => updateField('image', event.target.files?.[0] ?? null)}
                    disabled={disabled}
                    aria-invalid={Boolean(fieldError('image'))}
                    aria-describedby={describedBy('image', `${formId}-image-state ${formId}-image-help`)}
                    required
                  />
                  <label className="product-upload__button" htmlFor={`${formId}-image`}>انتخاب تصویر محصول</label>
                  <p id={`${formId}-image-state`} className="product-upload__state" aria-live="polite" dir="auto">
                    {values.image?.name ?? 'تصویری انتخاب نشده است.'}
                  </p>
                </div>
                <span id={`${formId}-image-help`} className="product-form__help">JPEG، PNG یا WebP، حداکثر ۵ مگابایت</span>
                {previewUrl ? <img className="product-form__preview" src={previewUrl} alt="پیش‌نمایش تصویر محصول تازه" /> : null}
                {fieldError('image') ? <span id={`${formId}-image-error`} className="product-form__error" role="alert">{fieldError('image')}</span> : null}
              </div>
            </div>
          ) : null}

          <fieldset className="product-form__switches" disabled={disabled}>
            <legend>وضعیت محصول</legend>
            <div className="product-status-control">
              <input
                id={`${formId}-visible`}
                type="checkbox"
                checked={values.isVisible}
                onChange={(event) => updateField('isVisible', event.target.checked)}
                aria-label="نمایش در منو"
                aria-describedby={`${formId}-visible-help`}
              />
              <label htmlFor={`${formId}-visible`}>
                <span className="product-status-control__copy">
                  <strong>نمایش در منو</strong>
                  <small id={`${formId}-visible-help`}>آیا محصول در منوی عمومی دیده شود؟</small>
                </span>
                <span className="product-status-control__value">{values.isVisible ? 'فعال' : 'غیرفعال'}</span>
                <span className="product-status-control__switch" aria-hidden="true"><span /></span>
              </label>
            </div>
            <div className="product-status-control">
              <input
                id={`${formId}-available`}
                type="checkbox"
                checked={values.isAvailable}
                onChange={(event) => updateField('isAvailable', event.target.checked)}
                aria-label="موجود بودن"
                aria-describedby={`${formId}-available-help`}
              />
              <label htmlFor={`${formId}-available`}>
                <span className="product-status-control__copy">
                  <strong>موجود بودن</strong>
                  <small id={`${formId}-available-help`}>آیا محصول اکنون قابل سفارش است؟</small>
                </span>
                <span className="product-status-control__value">{values.isAvailable ? 'موجود' : 'ناموجود'}</span>
                <span className="product-status-control__switch" aria-hidden="true"><span /></span>
              </label>
            </div>
          </fieldset>
        </div>
      </div>

      {fieldError('form') ? <p className="product-form__error product-form__error--form" role="alert">{fieldError('form')}</p> : null}

      <footer className="product-form__actions">
        <div className="product-form__action-note">
          <strong>{isCreate ? 'آمادهٔ انتشار در منو' : 'ویرایش محصول'}</strong>
          <span>{isCreate ? 'پس از بررسی تصویر و قیمت، محصول را ایجاد کنید.' : 'فقط تغییرهای موردنیاز را ذخیره کنید.'}</span>
        </div>
        <div className="product-form__action-buttons">
          <button type="submit" className="admin-primary-button" disabled={disabled}>
            {busy ? 'در حال ذخیره…' : isCreate ? 'ایجاد محصول' : 'ذخیره تغییرات'}
          </button>
          {isCreate ? <button type="reset" className="admin-secondary-button" disabled={disabled}>پاک‌کردن فرم</button> : null}
          {onCancel ? <button type="button" className="admin-secondary-button" onClick={onCancel} disabled={disabled}>انصراف</button> : null}
        </div>
      </footer>
    </form>
  )
}

function ProductImage({ product }) {
  const [failedPath, setFailedPath] = useState(null)
  const failed = failedPath === product.imagePath

  return (
    <div className="product-item__media">
      {!failed ? (
        <img src={product.imagePath} alt={`تصویر ${product.name}`} loading="lazy" decoding="async" onError={() => setFailedPath(product.imagePath)} />
      ) : (
        <span className="product-item__fallback" role="img" aria-label={`تصویر ${product.name} در دسترس نیست`}>
          <strong aria-hidden="true">ر</strong>
          <small aria-hidden="true">تصویر در دسترس نیست</small>
        </span>
      )}
    </div>
  )
}

function ReplaceImageForm({ product, busy, disabled, onSubmit, onCancel }) {
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const lockRef = useRef(false)
  const previewUrl = useObjectUrl(file)

  async function submit(event) {
    event.preventDefault()
    if (lockRef.current || disabled) return

    if (!file || !acceptedImageTypes.includes(file.type) || file.size <= 0 || file.size > maximumImageBytes) {
      setError('تصویر باید JPEG، PNG یا WebP و حداکثر ۵ مگابایت باشد.')
      inputRef.current?.focus()
      return
    }

    lockRef.current = true
    try {
      await onSubmit(file)
    } finally {
      lockRef.current = false
    }
  }

  return (
    <form className="product-replace-form" onSubmit={submit} noValidate aria-busy={busy}>
      <div className="product-replace-form__heading">
        <strong>تصویر جدید برای {product.name}</strong>
        <span>تصویر فعلی فقط پس از ثبت موفق جایگزین می‌شود.</span>
      </div>
      <div className="product-upload product-upload--compact">
        <div className="product-upload__picker">
          <input
            ref={inputRef}
            className="product-file-input"
            id={`replace-product-${product.id}`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError('') }}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={`replace-product-${product.id}-state replace-product-${product.id}-help${error ? ` replace-product-${product.id}-error` : ''}`}
            required
          />
          <label className="product-upload__button" htmlFor={`replace-product-${product.id}`}>انتخاب تصویر جدید</label>
          <p id={`replace-product-${product.id}-state`} className="product-upload__state" aria-live="polite" dir="auto">
            {file?.name ?? 'تصویری انتخاب نشده است.'}
          </p>
        </div>
        <span id={`replace-product-${product.id}-help`} className="product-form__help">JPEG، PNG یا WebP، حداکثر ۵ مگابایت</span>
      </div>
      {previewUrl ? <img className="product-form__preview" src={previewUrl} alt={`پیش‌نمایش تصویر جدید ${product.name}`} /> : null}
      {error ? <span id={`replace-product-${product.id}-error`} className="product-form__error" role="alert">{error}</span> : null}
      <div className="product-form__actions">
        <button type="submit" className="admin-primary-button" disabled={disabled}>{busy ? 'در حال جایگزینی…' : 'جایگزینی تصویر'}</button>
        <button type="button" className="admin-secondary-button" onClick={onCancel} disabled={disabled}>انصراف</button>
      </div>
    </form>
  )
}

function productErrorMessage(error) {
  if (error?.status === 404) return 'محصول یا دسته‌بندی موردنظر پیدا نشد؛ فهرست را دوباره بارگذاری کنید.'
  if (error?.status === 409) return 'این عملیات با وضعیت فعلی محصول قابل انجام نیست.'
  if (error?.status === 413) return 'حجم تصویر بیشتر از ۵ مگابایت است.'
  if (error?.kind === 'network') return 'ارتباط با سرویس محصولات برقرار نشد.'
  return 'انجام عملیات محصول ممکن نشد. دوباره تلاش کنید.'
}

export function ProductManager({
  getSessionEpoch,
  isSessionEpochCurrent,
  onAuthenticationRequired,
  suspended,
}) {
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [loadState, setLoadState] = useState('loading')
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const [notice, setNotice] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [replacingId, setReplacingId] = useState(null)
  const [activeOperations, setActiveOperations] = useState({})
  const mountedRef = useRef(false)
  const loadGenerationRef = useRef(0)
  const mutationVersionRef = useRef(0)
  const operationRef = useRef(new Map())

  useEffect(() => {
    const operations = operationRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
      for (const operation of operations.values()) operation.controller.abort()
      operations.clear()
    }
  }, [])

  useEffect(() => {
    if (suspended) {
      loadGenerationRef.current += 1
      for (const operation of operationRef.current.values()) operation.controller.abort()
      operationRef.current.clear()
      setActiveOperations({})
      setEditingId(null)
      setReplacingId(null)
      setNotice(null)
    }
  }, [suspended])

  useEffect(() => {
    if (suspended) return undefined

    const generation = ++loadGenerationRef.current
    const sessionEpoch = getSessionEpoch()
    const mutationVersion = mutationVersionRef.current
    const controller = new AbortController()
    let ownsRoute = true

    setLoadState((current) => current === 'ready' || current === 'refreshing' ? 'refreshing' : 'loading')
    setNotice(null)

    Promise.all([
      adminCategoriesApi.list({ signal: controller.signal }),
      adminProductsApi.list({ signal: controller.signal }),
    ]).then(
      ([loadedCategories, loadedProducts]) => {
        if (
          !ownsRoute ||
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          !isSessionEpochCurrent(sessionEpoch)
        ) return

        if (mutationVersion !== mutationVersionRef.current) {
          setLoadState('ready')
          return
        }

        let safeCategories

        try {
          safeCategories = sanitizeCategories(loadedCategories)
        } catch {
          setProducts([])
          setCategories([])
          setLoadState('error')
          return
        }

        setCategories(safeCategories)
        setProducts(sortProducts(loadedProducts))
        setLoadState('ready')
      },
      (error) => {
        if (
          !ownsRoute ||
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          !isSessionEpochCurrent(sessionEpoch) ||
          controller.signal.aborted
        ) return

        if (error?.status === 401) {
          setProducts([])
          setCategories([])
          onAuthenticationRequired(sessionEpoch)
          return
        }

        if (mutationVersion !== mutationVersionRef.current) {
          setLoadState('ready')
          return
        }

        setLoadState('error')
      },
    )

    return () => {
      ownsRoute = false
      controller.abort()
    }
  }, [getSessionEpoch, isSessionEpochCurrent, onAuthenticationRequired, reloadAttempt, suspended])

  function beginOperation(key, action) {
    if (suspended || operationRef.current.has(key)) return null
    const context = {
      key,
      action,
      identity: Symbol(action),
      sessionEpoch: getSessionEpoch(),
      controller: new AbortController(),
    }
    operationRef.current.set(key, context)
    setActiveOperations((current) => ({ ...current, [key]: action }))
    setNotice(null)
    return context
  }

  function isOperationCurrent(context) {
    return (
      mountedRef.current &&
      operationRef.current.get(context.key) === context &&
      isSessionEpochCurrent(context.sessionEpoch)
    )
  }

  function finishOperation(context) {
    if (operationRef.current.get(context.key) !== context) return
    operationRef.current.delete(context.key)
    setActiveOperations((current) => {
      const next = { ...current }
      delete next[context.key]
      return next
    })
  }

  function handleError(error, context) {
    if (!isOperationCurrent(context)) return

    if (error?.status === 401) {
      loadGenerationRef.current += 1
      for (const operation of operationRef.current.values()) operation.controller.abort()
      operationRef.current.clear()
      setActiveOperations({})
      setProducts([])
      setCategories([])
      setEditingId(null)
      setReplacingId(null)
      setNotice(null)
      onAuthenticationRequired(context.sessionEpoch)
      return
    }

    setNotice({ type: 'error', message: productErrorMessage(error) })
  }

  async function createProduct(metadata, image) {
    const context = beginOperation('create', 'create')
    if (!context) return false

    try {
      const product = await adminProductsApi.create(metadata, image, { signal: context.controller.signal })
      if (!isOperationCurrent(context)) return false
      mutationVersionRef.current += 1
      setProducts((current) => sortProducts([...current, product]))
      setNotice({ type: 'success', message: 'محصول با تصویر ایجاد شد.' })
      return true
    } catch (error) {
      handleError(error, context)
      return false
    } finally {
      finishOperation(context)
    }
  }

  async function updateProduct(productId, changes) {
    const context = beginOperation(`product:${productId}`, 'update')
    if (!context) return false

    try {
      const product = await adminProductsApi.update(productId, changes, { signal: context.controller.signal })
      if (!isOperationCurrent(context)) return false
      mutationVersionRef.current += 1
      setProducts((current) => sortProducts(current.map((item) => item.id === productId ? product : item)))
      setEditingId(null)
      setNotice({ type: 'success', message: 'اطلاعات محصول به‌روزرسانی شد.' })
      return true
    } catch (error) {
      handleError(error, context)
      return false
    } finally {
      finishOperation(context)
    }
  }

  async function replaceImage(productId, image) {
    const context = beginOperation(`product:${productId}`, 'replace')
    if (!context) return false

    try {
      const product = await adminProductsApi.replaceImage(productId, image, { signal: context.controller.signal })
      if (!isOperationCurrent(context)) return false
      mutationVersionRef.current += 1
      setProducts((current) => current.map((item) => item.id === productId ? product : item))
      setReplacingId(null)
      setNotice({ type: 'success', message: 'تصویر محصول جایگزین شد.' })
      return true
    } catch (error) {
      handleError(error, context)
      return false
    } finally {
      finishOperation(context)
    }
  }

  async function deleteProduct(product) {
    if (!window.confirm(`محصول «${product.name}» و تصویر آن حذف شود؟`)) return
    const context = beginOperation(`product:${product.id}`, 'delete')
    if (!context) return

    try {
      await adminProductsApi.remove(product.id, { signal: context.controller.signal })
      if (!isOperationCurrent(context)) return
      mutationVersionRef.current += 1
      setProducts((current) => current.filter((item) => item.id !== product.id))
      setNotice({ type: 'success', message: 'محصول حذف شد.' })
    } catch (error) {
      handleError(error, context)
    } finally {
      finishOperation(context)
    }
  }

  const dataIsVisible = loadState === 'ready' || loadState === 'refreshing'

  return (
    <section className="product-management" aria-labelledby="product-management-title">
      <div className="admin-section-heading product-management__heading">
        <div className="admin-section-heading__copy">
          <p className="admin-eyebrow">مدیریت منو</p>
          <h1 id="product-management-title">محصولات</h1>
          <p>محصول‌ها، قیمت، وضعیت سفارش و تصویر منوی کافه را از یک نمای منظم مدیریت کنید.</p>
        </div>
        <div className="product-management__refresh">
          <span>همگام‌سازی با آخرین اطلاعات منو</span>
          <button type="button" className="admin-secondary-button" onClick={() => setReloadAttempt((value) => value + 1)} disabled={suspended}>
            بارگذاری دوباره
          </button>
        </div>
      </div>

      {notice ? <p className={`admin-notice admin-notice--${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'} aria-live={notice.type === 'error' ? 'assertive' : 'polite'}>{notice.message}</p> : null}

      {loadState === 'loading' || loadState === 'refreshing' ? (
        <div className={`product-state product-state--${loadState}`} role="status" aria-live="polite">
          <span className="admin-spinner" aria-hidden="true"></span>
          <div><strong>{loadState === 'refreshing' ? 'در حال به‌روزرسانی منو' : 'در حال آماده‌سازی محصولات'}</strong><p>{loadState === 'refreshing' ? 'آخرین محصول‌ها و دسته‌بندی‌ها دریافت می‌شوند…' : 'محصولات و دسته‌بندی‌ها در حال دریافت‌اند…'}</p></div>
        </div>
      ) : null}
      {loadState === 'error' ? (
        <div className="product-state product-state--error" role="alert">
          <span className="product-state__symbol" aria-hidden="true">!</span>
          <div><strong>دریافت اطلاعات مدیریت محصولات ممکن نشد.</strong><p>اتصال را بررسی کنید و دوباره تلاش کنید.</p></div>
          <button type="button" className="admin-secondary-button" onClick={() => setReloadAttempt((value) => value + 1)}>تلاش دوباره</button>
        </div>
      ) : null}

      {dataIsVisible && categories.length === 0 ? (
        <div className="product-state product-state--empty" role="status">
          <span className="product-state__symbol" aria-hidden="true">۱</span>
          <div><strong>ابتدا یک دسته‌بندی بسازید</strong><p>هر محصول برای نمایش درست در منو باید به یک دسته‌بندی متصل باشد.</p></div>
          <a className="admin-secondary-button" href="/admin/categories">رفتن به دسته‌بندی‌ها</a>
        </div>
      ) : null}

      {dataIsVisible && categories.length > 0 ? (
        <section className="admin-surface product-editor" aria-labelledby="create-product-title">
          <div className="admin-surface__heading product-editor__heading"><div><p className="admin-surface__index" aria-hidden="true">۰۱</p><h2 id="create-product-title">ایجاد محصول</h2></div><p>اطلاعات پایه، تصویر و وضعیت انتشار را در یک فرم جمع‌وجور تکمیل کنید.</p></div>
          <ProductForm categories={categories} busy={activeOperations.create === 'create'} disabled={suspended || Boolean(activeOperations.create)} onSubmit={createProduct} />
        </section>
      ) : null}

      {dataIsVisible ? (
        <section className="admin-surface product-catalog" aria-labelledby="product-list-title">
          <div className="category-list-heading"><div><p className="admin-surface__index" aria-hidden="true">۰۲</p><h2 id="product-list-title">فهرست محصولات</h2></div><span className="category-list-heading__count">{products.length} مورد</span></div>
          {products.length === 0 ? <div className="product-empty-state" role="status"><span className="product-empty-state__mark" aria-hidden="true">＋</span><div><h3>هنوز محصولی ایجاد نشده است.</h3><p>از فرم بالا شروع کنید؛ نخستین محصول پس از ثبت در همین بخش نمایش داده می‌شود.</p></div></div> : null}
          {products.length > 0 ? (
            <ul className="product-list">
              {products.map((product) => {
                const operation = activeOperations[`product:${product.id}`]
                const busy = Boolean(operation)
                return (
                  <li key={product.id} className={`product-item${editingId === product.id || replacingId === product.id ? ' product-item--expanded' : ''}`} aria-busy={busy}>
                    <div className="product-item__summary">
                      <ProductImage product={product} />
                      <div className="product-item__details">
                        <div className="product-item__title"><span>{product.categoryName}</span><h3>{product.name}</h3></div>
                        <p className="product-item__price">{formatTomanPrice(product.price)} تومان</p>
                        {product.description ? <p>{product.description}</p> : null}
                        <div className="product-item__statuses" aria-label="وضعیت‌های محصول">
                          <span className={`product-status-badge product-status-badge--${product.isVisible ? 'positive' : 'neutral'}`}>{product.isVisible ? 'نمایش در منو' : 'مخفی از منو'}</span>
                          <span className={`product-status-badge product-status-badge--${product.isAvailable ? 'positive' : 'warning'}`}>{product.isAvailable ? 'موجود' : 'ناموجود'}</span>
                        </div>
                        <p className="product-item__order">ترتیب نمایش <strong>{product.sortOrder}</strong></p>
                      </div>
                      <div className="product-item__actions" aria-label={`عملیات محصول ${product.name}`}>
                        <button type="button" className="admin-secondary-button" onClick={() => { setEditingId(product.id); setReplacingId(null) }} disabled={suspended || busy || editingId !== null || replacingId !== null} aria-label={`ویرایش محصول ${product.name}`}>ویرایش</button>
                        <button type="button" className="admin-secondary-button" onClick={() => { setReplacingId(product.id); setEditingId(null) }} disabled={suspended || busy || editingId !== null || replacingId !== null} aria-label={`جایگزینی تصویر محصول ${product.name}`}>جایگزینی تصویر</button>
                        <button type="button" className="admin-danger-button" onClick={() => deleteProduct(product)} disabled={suspended || busy || editingId !== null || replacingId !== null} aria-label={`حذف محصول ${product.name}`}>{operation === 'delete' ? 'در حال حذف…' : 'حذف'}</button>
                      </div>
                    </div>
                    {editingId === product.id ? <div className="product-item__editor"><ProductForm categories={categories} initialProduct={product} busy={operation === 'update'} disabled={suspended || busy} onSubmit={(changes) => updateProduct(product.id, changes)} onCancel={() => setEditingId(null)} /></div> : null}
                    {replacingId === product.id ? <div className="product-item__editor"><ReplaceImageForm product={product} busy={operation === 'replace'} disabled={suspended || busy} onSubmit={(file) => replaceImage(product.id, file)} onCancel={() => setReplacingId(null)} /></div> : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
    </section>
  )
}
