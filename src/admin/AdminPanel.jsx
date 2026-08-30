import { useEffect, useRef, useState } from 'react'

import {
  adminCategoriesApi,
  categoryImageAccept,
  validateCategoryImageFile,
} from '../api/adminCategories.js'
import { ProductManager } from './ProductManager.jsx'

const maximumCategoryNameCharacters = 100
const maximumSortOrder = 4_294_967_295

function sortCategories(categories) {
  return [...categories].sort(
    (first, second) =>
      first.sortOrder - second.sortOrder ||
      (BigInt(first.id) < BigInt(second.id) ? -1 : BigInt(first.id) > BigInt(second.id) ? 1 : 0),
  )
}

function categoryErrorMessage(error) {
  if (error?.status === 409 && error.message === 'A category with this name already exists') {
    return 'دسته‌بندی دیگری با این نام وجود دارد.'
  }

  if (error?.status === 409 && error.message === 'A category with menu items cannot be deleted') {
    return 'این دسته‌بندی دارای محصول است و نمی‌توان آن را حذف کرد.'
  }

  if (error?.status === 404) {
    return 'دسته‌بندی موردنظر پیدا نشد. فهرست را دوباره بارگذاری کنید.'
  }

  return 'انجام عملیات ممکن نشد. دوباره تلاش کنید.'
}

function categoryImageErrorMessage(error) {
  if (error?.status === 413) {
    return 'حجم تصویر بیشتر از ۵ مگابایت است.'
  }

  if (error?.status === 400) {
    return 'تصویر باید یک فایل معتبر JPEG، PNG یا WebP باشد.'
  }

  if (error?.status === 404) {
    return 'دسته‌بندی برای ثبت تصویر پیدا نشد.'
  }

  return 'بارگذاری تصویر ممکن نشد.'
}

function validateForm(name, sortOrder) {
  const normalizedName = name.trim()

  if (!normalizedName) {
    return { error: 'نام دسته‌بندی را وارد کنید.', field: 'name' }
  }

  if (Array.from(normalizedName).length > maximumCategoryNameCharacters) {
    return {
      error: `نام دسته‌بندی نباید بیشتر از ${maximumCategoryNameCharacters} نویسه باشد.`,
      field: 'name',
    }
  }

  if (!/^\d+$/.test(sortOrder)) {
    return { error: 'ترتیب نمایش باید یک عدد صحیح نامنفی باشد.', field: 'sortOrder' }
  }

  const normalizedSortOrder = Number(sortOrder)

  if (!Number.isSafeInteger(normalizedSortOrder) || normalizedSortOrder > maximumSortOrder) {
    return { error: 'ترتیب نمایش خارج از محدودهٔ مجاز است.', field: 'sortOrder' }
  }

  return { name: normalizedName, sortOrder: normalizedSortOrder }
}

function CategoryImage({ category }) {
  const imagePath =
    typeof category.imagePath === 'string' && category.imagePath.trim().length > 0
      ? category.imagePath
      : null
  const [failedImagePath, setFailedImagePath] = useState(null)
  const shouldShowImage = imagePath !== null && failedImagePath !== imagePath

  return (
    <div
      className="category-item__media"
      role={shouldShowImage ? undefined : 'img'}
      aria-label={
        shouldShowImage
          ? undefined
          : imagePath
            ? `تصویر دسته‌بندی ${category.name} در دسترس نیست`
            : `دسته‌بندی ${category.name} بدون تصویر است`
      }
    >
      {shouldShowImage ? (
        <img
          src={imagePath}
          alt={`تصویر دسته‌بندی ${category.name}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailedImagePath(imagePath)}
        />
      ) : (
        <span aria-hidden="true">{Array.from(category.name.trim())[0] ?? 'ر'}</span>
      )}
    </div>
  )
}

function useObjectUrl(file) {
  const [objectUrl, setObjectUrl] = useState(null)

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setObjectUrl(null)
      return undefined
    }

    const nextObjectUrl = URL.createObjectURL(file)
    setObjectUrl(nextObjectUrl)

    return () => {
      if (typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(nextObjectUrl)
      }
    }
  }, [file])

  return objectUrl
}

function CategoryImagePreview({ source, categoryName, emptyLabel }) {
  const [failedSource, setFailedSource] = useState(null)
  const shouldShowImage = typeof source === 'string' && source !== '' && failedSource !== source

  return (
    <span
      className="category-image-preview"
      role={shouldShowImage ? undefined : 'img'}
      aria-label={shouldShowImage ? undefined : emptyLabel}
    >
      {shouldShowImage ? (
        <img
          src={source}
          alt={`پیش‌نمایش تصویر دسته‌بندی ${categoryName}`}
          onError={() => setFailedSource(source)}
        />
      ) : (
        <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
          <path d="M4 5.75A1.75 1.75 0 0 1 5.75 4h12.5A1.75 1.75 0 0 1 20 5.75v12.5A1.75 1.75 0 0 1 18.25 20H5.75A1.75 1.75 0 0 1 4 18.25V5.75Zm1.5 0v8.7l2.72-2.72a1.75 1.75 0 0 1 2.47 0l1.08 1.08 2.29-2.29a1.75 1.75 0 0 1 2.47 0l1.97 1.97V5.75a.25.25 0 0 0-.25-.25H5.75a.25.25 0 0 0-.25.25Zm13 8.86-3.03-3.03a.25.25 0 0 0-.35 0l-3.35 3.35-2.14-2.14a.25.25 0 0 0-.35 0L5.5 16.57v1.68c0 .14.11.25.25.25h12.5a.25.25 0 0 0 .25-.25v-3.64ZM8.25 7a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z" />
        </svg>
      )}
    </span>
  )
}

function CategoryForm({
  formId,
  initialCategory,
  initialImage = null,
  submitLabel,
  busy,
  disabled = busy,
  onSubmit,
  onCancel,
  onRemoveCurrentImage,
  imageActionBusy = false,
}) {
  const [name, setName] = useState(initialCategory?.name ?? '')
  const [sortOrder, setSortOrder] = useState(String(initialCategory?.sortOrder ?? 0))
  const [isVisible, setIsVisible] = useState(initialCategory?.isVisible ?? true)
  const [image, setImage] = useState(initialImage)
  const [fileInputVersion, setFileInputVersion] = useState(0)
  const [validationError, setValidationError] = useState(null)
  const submittingRef = useRef(false)
  const nameInputRef = useRef(null)
  const sortOrderInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const shouldFocusNameOnMountRef = useRef(Boolean(initialCategory))
  const previewUrl = useObjectUrl(image)
  const currentImagePath =
    typeof initialCategory?.imagePath === 'string' && initialCategory.imagePath.trim() !== ''
      ? initialCategory.imagePath
      : null
  const previousCurrentImagePathRef = useRef(currentImagePath)

  useEffect(() => {
    if (shouldFocusNameOnMountRef.current) {
      nameInputRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    const previousCurrentImagePath = previousCurrentImagePathRef.current
    previousCurrentImagePathRef.current = currentImagePath

    if (previousCurrentImagePath && !currentImagePath) {
      imageInputRef.current?.focus()
    }
  }, [currentImagePath])

  function clearImageSelection() {
    setImage(null)
    setFileInputVersion((version) => version + 1)

    if (validationError?.field === 'image') {
      setValidationError(null)
    }
  }

  function handleImageSelection(event) {
    const nextImage = event.target.files?.[0] ?? null

    if (!nextImage) {
      return
    }

    try {
      validateCategoryImageFile(nextImage)
      setImage(nextImage)

      if (validationError?.field === 'image') {
        setValidationError(null)
      }
    } catch {
      setImage(null)
      setFileInputVersion((version) => version + 1)
      setValidationError({
        field: 'image',
        message: 'تصویر باید فایل معتبر JPEG، PNG یا WebP و حداکثر ۵ مگابایت باشد.',
      })
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    if (submittingRef.current || disabled) {
      return
    }

    if (validationError?.field === 'image') {
      imageInputRef.current?.focus()
      return
    }

    const validated = validateForm(name, sortOrder)

    if (validated.error) {
      setValidationError({ message: validated.error, field: validated.field })

      if (validated.field === 'name') {
        nameInputRef.current?.focus()
      } else {
        sortOrderInputRef.current?.focus()
      }

      return
    }

    setValidationError(null)
    submittingRef.current = true

    try {
      const succeeded = await onSubmit(
        {
          name: validated.name,
          sortOrder: validated.sortOrder,
          isVisible,
        },
        image,
      )

      if (succeeded && !initialCategory) {
        setName('')
        setSortOrder('0')
        setIsVisible(true)
        setImage(null)
        setFileInputVersion((version) => version + 1)
      }
    } finally {
      submittingRef.current = false
    }
  }

  const nameErrorId = `${formId}-name-error`
  const nameHelpId = `${formId}-name-help`
  const orderErrorId = `${formId}-order-error`
  const orderHelpId = `${formId}-order-help`
  const imageErrorId = `${formId}-image-error`
  const imageHelpId = `${formId}-image-help`
  const imageStateId = `${formId}-image-state`
  const nameHasError = validationError?.field === 'name'
  const orderHasError = validationError?.field === 'sortOrder'
  const imageHasError = validationError?.field === 'image'
  const displayedImage = previewUrl ?? currentImagePath
  const displayedCategoryName = name.trim() || initialCategory?.name || 'جدید'

  return (
    <form
      className={`category-form category-form--${initialCategory ? 'edit' : 'create'}`}
      onSubmit={handleSubmit}
      noValidate
      aria-busy={busy || imageActionBusy}
    >
      <div className="category-form__fields">
        <div className="category-form__field category-form__field--name">
          <label htmlFor={`${formId}-name`}>نام دسته‌بندی</label>
          <input
            ref={nameInputRef}
            id={`${formId}-name`}
            name="categoryName"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value)

              if (nameHasError) {
                setValidationError(null)
              }
            }}
            disabled={disabled}
            aria-invalid={nameHasError}
            aria-describedby={`${nameHelpId}${nameHasError ? ` ${nameErrorId}` : ''}`}
            autoComplete="off"
            required
          />
          <span className="category-form__help" id={nameHelpId}>
            حداکثر {maximumCategoryNameCharacters} نویسه
          </span>
          {nameHasError ? (
            <span className="category-form__field-error" id={nameErrorId} role="alert">
              {validationError.message}
            </span>
          ) : null}
        </div>

        <div className="category-form__field">
          <label htmlFor={`${formId}-order`}>ترتیب نمایش</label>
          <input
            ref={sortOrderInputRef}
            id={`${formId}-order`}
            name="sortOrder"
            type="number"
            min="0"
            max={maximumSortOrder}
            step="1"
            inputMode="numeric"
            value={sortOrder}
            onChange={(event) => {
              setSortOrder(event.target.value)

              if (orderHasError) {
                setValidationError(null)
              }
            }}
            disabled={disabled}
            aria-invalid={orderHasError}
            aria-describedby={`${orderHelpId}${orderHasError ? ` ${orderErrorId}` : ''}`}
          />
          <span className="category-form__help" id={orderHelpId}>
            عدد کمتر، نمایش زودتر
          </span>
          {orderHasError ? (
            <span className="category-form__field-error" id={orderErrorId} role="alert">
              {validationError.message}
            </span>
          ) : null}
        </div>

        <div className="category-form__visibility">
          <label className="category-checkbox" htmlFor={`${formId}-visible`}>
            <input
              id={`${formId}-visible`}
              name="isVisible"
              type="checkbox"
              checked={isVisible}
              onChange={(event) => setIsVisible(event.target.checked)}
              disabled={disabled}
            />
            <span>نمایش در منو</span>
          </label>
          <span className="category-form__help">دسته‌بندی برای مشتریان قابل مشاهده باشد.</span>
        </div>
      </div>

      <div className="category-form__image" role="group" aria-labelledby={`${formId}-image-title`}>
        <div className="category-form__image-heading">
          <div>
            <p id={`${formId}-image-title`}>تصویر دسته‌بندی</p>
            <span>{initialCategory ? 'افزودن یا جایگزینی تصویر' : 'اختیاری'}</span>
          </div>
        </div>
        <input
          key={`${formId}-image-${fileInputVersion}`}
          ref={imageInputRef}
          className="category-image-input"
          id={`${formId}-image`}
          name="categoryImage"
          type="file"
          accept={categoryImageAccept}
          onChange={handleImageSelection}
          disabled={disabled}
          aria-invalid={imageHasError}
          aria-describedby={`${imageStateId} ${imageHelpId}${imageHasError ? ` ${imageErrorId}` : ''}`}
        />
        <label className="category-image-picker" htmlFor={`${formId}-image`}>
          <CategoryImagePreview
            source={displayedImage}
            categoryName={displayedCategoryName}
            emptyLabel={`برای دسته‌بندی ${displayedCategoryName} تصویری انتخاب نشده است`}
          />
          <span className="category-image-picker__copy">
            <strong>
              {image ? 'تغییر تصویر انتخاب‌شده' : currentImagePath ? 'جایگزینی تصویر' : 'انتخاب تصویر'}
            </strong>
            <span id={imageStateId} dir={image ? 'auto' : undefined} aria-live="polite">
              {image?.name ?? (currentImagePath ? 'تصویر فعلی دسته‌بندی' : 'تصویری انتخاب نشده است')}
            </span>
          </span>
        </label>

        <span className="category-form__help" id={imageHelpId}>
          JPEG، PNG یا WebP، حداکثر ۵ مگابایت
        </span>
        {imageHasError ? (
          <span className="category-form__field-error" id={imageErrorId} role="alert">
            {validationError.message}
          </span>
        ) : null}

        {imageHasError || image || (currentImagePath && onRemoveCurrentImage) ? (
          <div className="category-form__image-actions">
            {imageHasError || image ? (
              <button
                className="admin-secondary-button"
                type="button"
                onClick={clearImageSelection}
                disabled={disabled}
                aria-label={
                  imageHasError ? 'حذف فایل تصویر نامعتبر' : `حذف تصویر انتخاب‌شده ${image.name}`
                }
              >
                {imageHasError ? 'حذف فایل نامعتبر' : 'حذف انتخاب'}
              </button>
            ) : null}
            {!image && currentImagePath && onRemoveCurrentImage ? (
              <button
                className="admin-danger-button"
                type="button"
                onClick={onRemoveCurrentImage}
                disabled={disabled}
                aria-label={`حذف تصویر فعلی دسته‌بندی ${initialCategory.name}`}
              >
                {imageActionBusy ? 'در حال حذف…' : 'حذف تصویر فعلی'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="category-form__actions">
        <button className="admin-primary-button" type="submit" disabled={disabled}>
          {busy ? 'در حال ذخیره…' : submitLabel}
        </button>
        {onCancel ? (
          <button
            className="admin-secondary-button"
            type="button"
            onClick={() => {
              clearImageSelection()
              setValidationError(null)
              onCancel()
            }}
            disabled={disabled}
          >
            انصراف
          </button>
        ) : null}
      </div>
    </form>
  )
}

function CategoryManager({
  getSessionEpoch,
  isSessionEpochCurrent,
  onAuthenticationRequired,
  suspended,
}) {
  const [categories, setCategories] = useState([])
  const [loadState, setLoadState] = useState('loading')
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const [editingId, setEditingId] = useState(null)
  const [operation, setOperation] = useState(null)
  const [notice, setNotice] = useState(null)
  const [pendingImageRetry, setPendingImageRetry] = useState(null)
  const operationLockRef = useRef(null)
  const isMountedRef = useRef(true)
  const editButtonRefs = useRef(new Map())
  const focusAfterEditorCloseRef = useRef(null)

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (suspended) {
      operationLockRef.current = null
      focusAfterEditorCloseRef.current = null
      setOperation(null)
      setEditingId(null)
      setNotice(null)
      setPendingImageRetry(null)
    }
  }, [suspended])

  useEffect(() => {
    const categoryId = focusAfterEditorCloseRef.current

    if (categoryId === null || editingId !== null || operation !== null) {
      return
    }

    const editButton = editButtonRefs.current.get(categoryId)

    if (editButton && !editButton.disabled) {
      editButton.focus()
      focusAfterEditorCloseRef.current = null
    }
  }, [editingId, operation])

  useEffect(() => {
    if (suspended) {
      return undefined
    }

    let isCurrent = true
    const sessionEpoch = getSessionEpoch()
    setLoadState('loading')
    setNotice(null)

    adminCategoriesApi
      .list()
      .then((loadedCategories) => {
        if (isCurrent && isSessionEpochCurrent(sessionEpoch)) {
          setCategories(sortCategories(loadedCategories))
          setLoadState('ready')
        }
      })
      .catch((error) => {
        if (!isCurrent || !isSessionEpochCurrent(sessionEpoch)) {
          return
        }

        if (error?.status === 401) {
          setCategories([])
          setLoadState('loading')
          onAuthenticationRequired(sessionEpoch)
          return
        }

        setLoadState('error')
      })

    return () => {
      isCurrent = false
    }
  }, [
    getSessionEpoch,
    isSessionEpochCurrent,
    onAuthenticationRequired,
    reloadAttempt,
    suspended,
  ])

  function isOperationCurrent(operationContext) {
    return (
      isMountedRef.current &&
      operationLockRef.current === operationContext &&
      isSessionEpochCurrent(operationContext.sessionEpoch)
    )
  }

  function handleOperationError(error, operationContext) {
    if (!isOperationCurrent(operationContext)) {
      return
    }

    if (error?.status === 401) {
      operationLockRef.current = null
      setCategories([])
      setLoadState('loading')
      setOperation(null)
      setEditingId(null)
      setNotice(null)
      setPendingImageRetry(null)
      onAuthenticationRequired(operationContext.sessionEpoch)
      return
    }

    setNotice({ type: 'error', message: categoryErrorMessage(error) })
  }

  function beginOperation(operationName) {
    if (operationLockRef.current !== null || suspended) {
      return null
    }

    const operationContext = { operationName, sessionEpoch: getSessionEpoch() }
    operationLockRef.current = operationContext
    setOperation(operationName)
    setNotice(null)
    return operationContext
  }

  function finishOperation(operationContext) {
    if (operationLockRef.current === operationContext) {
      operationLockRef.current = null

      if (isMountedRef.current && isSessionEpochCurrent(operationContext.sessionEpoch)) {
        setOperation(null)
      }
    }
  }

  function storeCategory(category) {
    setCategories((current) =>
      sortCategories(current.map((item) => (item.id === category.id ? category : item))),
    )
  }

  function closeEditorAndRestoreFocus(categoryId) {
    focusAfterEditorCloseRef.current = categoryId
    setEditingId(null)
  }

  function cancelEditor(categoryId) {
    setPendingImageRetry((pending) =>
      pending?.categoryId === categoryId ? null : pending,
    )
    closeEditorAndRestoreFocus(categoryId)
  }

  async function createCategory(values, image) {
    const operationName = 'create'
    const operationContext = beginOperation(operationName)

    if (!operationContext) {
      return false
    }

    try {
      const category = await adminCategoriesApi.create(values)

      if (!isOperationCurrent(operationContext)) {
        return false
      }

      setCategories((current) => sortCategories([...current, category]))

      if (image) {
        try {
          const categoryWithImage = await adminCategoriesApi.replaceImage(category.id, image)

          if (!isOperationCurrent(operationContext)) {
            return false
          }

          storeCategory(categoryWithImage)
          setNotice({ type: 'success', message: 'دسته‌بندی و تصویر آن با موفقیت ایجاد شد.' })
          return true
        } catch (error) {
          if (!isOperationCurrent(operationContext)) {
            return false
          }

          if (error?.status === 401) {
            handleOperationError(error, operationContext)
            return false
          }

          setNotice({
            type: 'warning',
            message: `دسته‌بندی ایجاد شد، اما ${categoryImageErrorMessage(error)} تصویر انتخاب‌شده برای تلاش دوباره حفظ شده است.`,
          })
          setPendingImageRetry({ categoryId: category.id, image })
          setEditingId(category.id)
          return true
        }
      }

      setNotice({ type: 'success', message: 'دسته‌بندی با موفقیت ایجاد شد.' })
      return true
    } catch (error) {
      handleOperationError(error, operationContext)
      return false
    } finally {
      finishOperation(operationContext)
    }
  }

  async function updateCategory(categoryId, values, successMessage, image = null) {
    const operationName = `update:${categoryId}`
    const operationContext = beginOperation(operationName)

    if (!operationContext) {
      return false
    }

    try {
      const existingCategory = categories.find((category) => category.id === categoryId)
      const metadataIsUnchanged =
        existingCategory !== undefined &&
        Object.entries(values).every(([field, value]) => existingCategory[field] === value)
      const isImageOnlyRetry =
        image !== null &&
        pendingImageRetry?.categoryId === categoryId &&
        metadataIsUnchanged
      let category = existingCategory

      if (!isImageOnlyRetry) {
        category = await adminCategoriesApi.update(categoryId, values)

        if (!isOperationCurrent(operationContext)) {
          return false
        }

        storeCategory(category)
      }

      if (image) {
        try {
          const categoryWithImage = await adminCategoriesApi.replaceImage(categoryId, image)

          if (!isOperationCurrent(operationContext)) {
            return false
          }

          storeCategory(categoryWithImage)
          setPendingImageRetry((pending) =>
            pending?.categoryId === categoryId ? null : pending,
          )
        } catch (error) {
          if (!isOperationCurrent(operationContext)) {
            return false
          }

          if (error?.status === 401) {
            handleOperationError(error, operationContext)
            return false
          }

          setNotice({
            type: 'warning',
            message: `اطلاعات دسته‌بندی ذخیره شد، اما ${categoryImageErrorMessage(error)} تصویر انتخاب‌شده برای تلاش دوباره حفظ شده است.`,
          })
          setPendingImageRetry({ categoryId, image })
          return false
        }
      }

      setPendingImageRetry((pending) =>
        pending?.categoryId === categoryId ? null : pending,
      )

      if (editingId === categoryId) {
        closeEditorAndRestoreFocus(categoryId)
      }
      setNotice({ type: 'success', message: successMessage })
      return true
    } catch (error) {
      handleOperationError(error, operationContext)
      return false
    } finally {
      finishOperation(operationContext)
    }
  }

  async function removeCategoryImage(category) {
    const operationName = `remove-image:${category.id}`
    const operationContext = beginOperation(operationName)

    if (!operationContext) {
      return false
    }

    try {
      if (!window.confirm(`تصویر فعلی دسته‌بندی «${category.name}» حذف شود؟`)) {
        return false
      }

      const updatedCategory = await adminCategoriesApi.removeImage(category.id)

      if (!isOperationCurrent(operationContext)) {
        return false
      }

      storeCategory(updatedCategory)
      setNotice({ type: 'success', message: 'تصویر دسته‌بندی حذف شد.' })
      return true
    } catch (error) {
      handleOperationError(error, operationContext)
      return false
    } finally {
      finishOperation(operationContext)
    }
  }

  async function deleteCategory(category) {
    const operationName = `delete:${category.id}`
    const operationContext = beginOperation(operationName)

    if (!operationContext) {
      return
    }

    try {
      if (!window.confirm(`دسته‌بندی «${category.name}» حذف شود؟`)) {
        return
      }

      await adminCategoriesApi.remove(category.id)

      if (!isOperationCurrent(operationContext)) {
        return
      }

      setCategories((current) => current.filter((item) => item.id !== category.id))
      setNotice({ type: 'success', message: 'دسته‌بندی حذف شد.' })
    } catch (error) {
      handleOperationError(error, operationContext)
    } finally {
      finishOperation(operationContext)
    }
  }

  return (
    <section className="category-management" aria-labelledby="category-management-title">
      <div className="admin-section-heading">
        <div className="admin-section-heading__copy">
          <p className="admin-eyebrow">مدیریت منو</p>
          <h1 id="category-management-title">دسته‌بندی‌ها</h1>
          <p>دسته‌بندی‌ها، تصویر، وضعیت نمایش و ترتیب حضور آن‌ها در منو را مدیریت کنید.</p>
        </div>
      </div>

      <section
        className="admin-surface category-create-surface"
        aria-labelledby="create-category-title"
      >
        <div className="admin-surface__heading">
          <div>
            <p className="admin-surface__index" aria-hidden="true">
              ۰۱
            </p>
            <h2 id="create-category-title">ایجاد دسته‌بندی</h2>
          </div>
          <p>مشخصات دسته‌بندی را وارد کنید و در صورت نیاز تصویری برای آن انتخاب کنید.</p>
        </div>
        <CategoryForm
          formId="create-category"
          submitLabel="ایجاد دسته‌بندی"
          busy={operation === 'create'}
          disabled={suspended || operation !== null || loadState !== 'ready'}
          onSubmit={createCategory}
        />
      </section>

      {notice ? (
        <p
          className={`admin-notice admin-notice--${notice.type}`}
          role={notice.type === 'error' ? 'alert' : 'status'}
          aria-live={notice.type === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {notice.message}
        </p>
      ) : null}

      <section
        className="admin-surface category-list-surface"
        aria-labelledby="category-list-title"
      >
        <div className="category-list-heading">
          <div>
            <p className="admin-surface__index" aria-hidden="true">
              ۰۲
            </p>
            <h2 id="category-list-title">فهرست دسته‌بندی‌ها</h2>
          </div>
          {loadState === 'ready' ? <span className="category-list-heading__count">{categories.length} مورد</span> : null}
        </div>

        {loadState === 'loading' ? (
          <div className="admin-inline-state" role="status" aria-live="polite" aria-atomic="true">
            <span className="admin-spinner" aria-hidden="true"></span>
            <p>در حال دریافت دسته‌بندی‌ها…</p>
          </div>
        ) : null}

        {loadState === 'error' ? (
          <div className="admin-inline-state" role="alert">
            <p>دریافت دسته‌بندی‌ها ممکن نشد.</p>
            <button
              className="admin-secondary-button"
              type="button"
              onClick={() => setReloadAttempt((attempt) => attempt + 1)}
              disabled={suspended}
            >
              تلاش دوباره
            </button>
          </div>
        ) : null}

        {loadState === 'ready' && categories.length === 0 ? (
          <div
            className="admin-inline-state admin-inline-state--empty"
            role="status"
            aria-live="polite"
          >
            <span className="admin-inline-state__symbol" aria-hidden="true">
              +
            </span>
            <p>هنوز دسته‌بندی‌ای ایجاد نشده است.</p>
            <span>برای شروع، فرم ایجاد دسته‌بندی را تکمیل کنید.</span>
          </div>
        ) : null}

        {loadState === 'ready' && categories.length > 0 ? (
          <ul className="category-list">
            {categories.map((category) => {
              const isBusy = operation?.endsWith(`:${category.id}`) ?? false
              const isEditing = editingId === category.id
              const retryImage =
                pendingImageRetry?.categoryId === category.id
                  ? pendingImageRetry.image
                  : null
              const editorId = `category-editor-${category.id}`
              const editorTitleId = `${editorId}-title`

              return (
                <li
                  className={`category-item${isEditing ? ' category-item--editing' : ''}`}
                  data-category-id={category.id}
                  key={category.id}
                  aria-busy={isBusy}
                >
                  <div className="category-item__summary">
                    <CategoryImage category={category} />

                    <div className="category-item__details">
                      <div className="category-item__title-row">
                        <h3>{category.name}</h3>
                        <span
                          className={`category-status category-status--${category.isVisible ? 'active' : 'inactive'}`}
                        >
                          {category.isVisible ? 'فعال' : 'غیرفعال'}
                        </span>
                      </div>
                      <p>ترتیب نمایش: {category.sortOrder}</p>
                    </div>

                    <div className="category-item__actions">
                      <button
                        ref={(button) => {
                          if (button) {
                            editButtonRefs.current.set(category.id, button)
                          } else {
                            editButtonRefs.current.delete(category.id)
                          }
                        }}
                        className="admin-secondary-button"
                        type="button"
                        onClick={() => setEditingId(category.id)}
                        disabled={suspended || operation !== null || editingId !== null}
                        aria-label={`ویرایش دسته‌بندی ${category.name}`}
                        aria-expanded={isEditing}
                        aria-controls={editorId}
                      >
                        ویرایش
                      </button>
                      <button
                        className={`admin-secondary-button category-visibility-button${
                          category.isVisible ? '' : ' category-visibility-button--inactive'
                        }`}
                        type="button"
                        onClick={() =>
                          updateCategory(
                            category.id,
                            { isVisible: !category.isVisible },
                            'وضعیت دسته‌بندی به‌روزرسانی شد.',
                          )
                        }
                        disabled={suspended || operation !== null || editingId !== null}
                        aria-label={`${category.isVisible ? 'غیرفعال‌کردن' : 'فعال‌کردن'} دسته‌بندی ${category.name}`}
                      >
                        {isBusy ? 'در حال ذخیره…' : category.isVisible ? 'غیرفعال‌کردن' : 'فعال‌کردن'}
                      </button>
                      <button
                        className="admin-danger-button"
                        type="button"
                        onClick={() => deleteCategory(category)}
                        disabled={suspended || operation !== null || editingId !== null}
                        aria-label={`حذف دسته‌بندی ${category.name}`}
                      >
                        {isBusy ? 'در حال پردازش…' : 'حذف'}
                      </button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div
                      className="category-item__editor"
                      id={editorId}
                      role="region"
                      aria-labelledby={editorTitleId}
                    >
                      <div className="category-item__editor-heading">
                        <div>
                          <p className="admin-eyebrow">ویرایش دسته‌بندی</p>
                          <h4 id={editorTitleId}>{category.name}</h4>
                        </div>
                        <span>مشخصات یا تصویر را به‌روز کنید.</span>
                      </div>
                      <CategoryForm
                        formId={`edit-category-${category.id}`}
                        initialCategory={category}
                        initialImage={retryImage}
                        submitLabel="ذخیره تغییرات"
                        busy={operation === `update:${category.id}`}
                        disabled={suspended || operation !== null}
                        onSubmit={(values, image) =>
                          updateCategory(
                            category.id,
                            values,
                            image
                              ? 'دسته‌بندی و تصویر آن به‌روزرسانی شد.'
                              : 'دسته‌بندی به‌روزرسانی شد.',
                            image,
                          )
                        }
                        onRemoveCurrentImage={() => removeCategoryImage(category)}
                        imageActionBusy={operation === `remove-image:${category.id}`}
                        onCancel={() => cancelEditor(category.id)}
                      />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>
    </section>
  )
}

function AdminDashboard({ admin }) {
  return (
    <section className="admin-dashboard" aria-labelledby="admin-dashboard-title">
      <div className="admin-section-heading">
        <div className="admin-section-heading__copy">
          <p className="admin-eyebrow">داشبورد</p>
          <h1 id="admin-dashboard-title">پنل مدیریت کافه ریونا</h1>
          <p>
            خوش آمدید، {admin.displayName ?? admin.username}. زیرساخت مدیریت آماده است و
            بخش‌های داده به‌تدریج تکمیل می‌شوند.
          </p>
        </div>
      </div>

      <div className="admin-dashboard__grid">
        <article className="admin-surface admin-dashboard__card">
          <div className="admin-dashboard__card-heading">
            <span className="admin-dashboard__index" aria-hidden="true">
              ۰۱
            </span>
            <span className="admin-dashboard__status admin-dashboard__status--ready">فعال</span>
          </div>
          <h2>مدیریت دسته‌بندی‌ها</h2>
          <p>مدیریت دسته‌بندی‌های منو در نسخهٔ فعلی پروژه در دسترس است.</p>
          <a className="admin-secondary-button admin-dashboard__link" href="/admin/categories">
            ورود به دسته‌بندی‌ها
          </a>
        </article>

        <article className="admin-surface admin-dashboard__card">
          <div className="admin-dashboard__card-heading">
            <span className="admin-dashboard__index" aria-hidden="true">
              ۰۲
            </span>
            <span className="admin-dashboard__status admin-dashboard__status--ready">فعال</span>
          </div>
          <h2>مدیریت محصولات</h2>
          <p>ایجاد، ویرایش، جایگزینی تصویر و حذف محصولات در دسترس است.</p>
          <a className="admin-secondary-button admin-dashboard__link" href="/admin/products">
            ورود به محصولات
          </a>
        </article>
      </div>
    </section>
  )
}

export function AdminPanel({
  admin,
  getSessionEpoch,
  isSessionEpochCurrent,
  pathname,
  onLogout,
  onAuthenticationRequired,
}) {
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const logoutLockRef = useRef(false)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  async function handleLogout() {
    if (logoutLockRef.current) {
      return
    }

    logoutLockRef.current = true
    setIsLoggingOut(true)
    setLogoutError('')

    try {
      const completed = await onLogout()

      if (completed === false && isMountedRef.current) {
        logoutLockRef.current = false
        setIsLoggingOut(false)
      }
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }

      setLogoutError(
        error?.kind === 'network'
          ? 'ارتباط با سرور برقرار نشد و نشست شما همچنان فعال است.'
          : 'خروج از حساب انجام نشد. دوباره تلاش کنید.',
      )
      logoutLockRef.current = false
      setIsLoggingOut(false)
    }
  }

  return (
    <main className="admin-panel" dir="rtl" lang="fa">
      <header className="admin-panel__header">
        <div className="admin-panel__brand">
          <span className="admin-brand-mark" aria-hidden="true">
            R
          </span>
          <div>
            <strong>کافه ریونا</strong>
            <span>پنل مدیریت منو</span>
          </div>
        </div>
        <div className="admin-panel__identity">
          <span className="admin-panel__user">
            مدیر: <strong>{admin.username}</strong>
          </span>
          <button
            className="admin-secondary-button"
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
            aria-label={isLoggingOut ? 'در حال خروج از پنل مدیریت' : 'خروج از پنل مدیریت'}
          >
            {isLoggingOut ? 'در حال خروج…' : 'خروج'}
          </button>
        </div>
      </header>

      {logoutError ? (
        <p className="admin-notice admin-notice--error admin-panel__logout-error" role="alert">
          {logoutError}
        </p>
      ) : null}

      <div className="admin-panel__body">
        <aside className="admin-panel__sidebar">
          <nav aria-label="ناوبری مدیریت">
            <a
              className={`admin-nav-link${pathname === '/admin' ? ' admin-nav-link--active' : ''}`}
              href="/admin"
              aria-current={pathname === '/admin' ? 'page' : undefined}
            >
              <span className="admin-nav-link__index" aria-hidden="true">
                ۰۱
              </span>
              <span>داشبورد</span>
            </a>
            <a
              className={`admin-nav-link${pathname === '/admin/categories' ? ' admin-nav-link--active' : ''}`}
              href="/admin/categories"
              aria-current={pathname === '/admin/categories' ? 'page' : undefined}
            >
              <span className="admin-nav-link__index" aria-hidden="true">
                ۰۲
              </span>
              <span>دسته‌بندی‌ها</span>
            </a>
            <a
              className={`admin-nav-link${pathname === '/admin/products' ? ' admin-nav-link--active' : ''}`}
              href="/admin/products"
              aria-current={pathname === '/admin/products' ? 'page' : undefined}
            >
              <span className="admin-nav-link__index" aria-hidden="true">
                ۰۳
              </span>
              <span>محصولات</span>
            </a>
          </nav>
        </aside>
        <div className="admin-panel__content">
          {pathname === '/admin' ? <AdminDashboard admin={admin} /> : null}
          {pathname === '/admin/categories' ? (
            <CategoryManager
              getSessionEpoch={getSessionEpoch}
              isSessionEpochCurrent={isSessionEpochCurrent}
              onAuthenticationRequired={onAuthenticationRequired}
              suspended={isLoggingOut}
            />
          ) : null}
          {pathname === '/admin/products' ? (
            <ProductManager
              getSessionEpoch={getSessionEpoch}
              isSessionEpochCurrent={isSessionEpochCurrent}
              onAuthenticationRequired={onAuthenticationRequired}
              suspended={isLoggingOut}
            />
          ) : null}
        </div>
      </div>
    </main>
  )
}
