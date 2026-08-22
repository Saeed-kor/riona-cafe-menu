import { useEffect, useRef, useState } from 'react'

import { adminCategoriesApi } from '../api/adminCategories.js'

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
    <div className="category-item__media" aria-hidden="true">
      {shouldShowImage ? (
        <img
          src={imagePath}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedImagePath(imagePath)}
        />
      ) : (
        <span>{Array.from(category.name.trim())[0] ?? 'ر'}</span>
      )}
    </div>
  )
}

function CategoryForm({
  formId,
  initialCategory,
  submitLabel,
  busy,
  disabled = busy,
  onSubmit,
  onCancel,
}) {
  const [name, setName] = useState(initialCategory?.name ?? '')
  const [sortOrder, setSortOrder] = useState(String(initialCategory?.sortOrder ?? 0))
  const [isVisible, setIsVisible] = useState(initialCategory?.isVisible ?? true)
  const [validationError, setValidationError] = useState(null)
  const submittingRef = useRef(false)
  const nameInputRef = useRef(null)
  const sortOrderInputRef = useRef(null)

  async function handleSubmit(event) {
    event.preventDefault()

    if (submittingRef.current || disabled) {
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
      const succeeded = await onSubmit({
        name: validated.name,
        sortOrder: validated.sortOrder,
        isVisible,
      })

      if (succeeded && !initialCategory) {
        setName('')
        setSortOrder('0')
        setIsVisible(true)
      }
    } finally {
      submittingRef.current = false
    }
  }

  const nameErrorId = `${formId}-name-error`
  const nameHelpId = `${formId}-name-help`
  const orderErrorId = `${formId}-order-error`
  const orderHelpId = `${formId}-order-help`
  const nameHasError = validationError?.field === 'name'
  const orderHasError = validationError?.field === 'sortOrder'

  return (
    <form className="category-form" onSubmit={handleSubmit} noValidate aria-busy={busy}>
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

      <div className="category-form__actions">
        <button className="admin-primary-button" type="submit" disabled={disabled}>
          {busy ? 'در حال ذخیره…' : submitLabel}
        </button>
        {onCancel ? (
          <button
            className="admin-secondary-button"
            type="button"
            onClick={onCancel}
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
  const operationLockRef = useRef(null)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (suspended) {
      operationLockRef.current = null
      setOperation(null)
      setEditingId(null)
      setNotice(null)
    }
  }, [suspended])

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
      operationLockRef.current === operationContext.operationName &&
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
      onAuthenticationRequired(operationContext.sessionEpoch)
      return
    }

    setNotice({ type: 'error', message: categoryErrorMessage(error) })
  }

  function beginOperation(operationName) {
    if (operationLockRef.current !== null || suspended) {
      return null
    }

    operationLockRef.current = operationName
    setOperation(operationName)
    setNotice(null)
    return { operationName, sessionEpoch: getSessionEpoch() }
  }

  function finishOperation(operationContext) {
    if (operationLockRef.current === operationContext.operationName) {
      operationLockRef.current = null

      if (isMountedRef.current && isSessionEpochCurrent(operationContext.sessionEpoch)) {
        setOperation(null)
      }
    }
  }

  async function createCategory(values) {
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
      setNotice({ type: 'success', message: 'دسته‌بندی با موفقیت ایجاد شد.' })
      return true
    } catch (error) {
      handleOperationError(error, operationContext)
      return false
    } finally {
      finishOperation(operationContext)
    }
  }

  async function updateCategory(categoryId, values, successMessage) {
    const operationName = `update:${categoryId}`
    const operationContext = beginOperation(operationName)

    if (!operationContext) {
      return false
    }

    try {
      const category = await adminCategoriesApi.update(categoryId, values)

      if (!isOperationCurrent(operationContext)) {
        return false
      }

      setCategories((current) =>
        sortCategories(current.map((item) => (item.id === category.id ? category : item))),
      )
      setEditingId(null)
      setNotice({ type: 'success', message: successMessage })
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
          <p>دسته‌بندی‌های منو، وضعیت نمایش و ترتیب آن‌ها را مدیریت کنید.</p>
        </div>
      </div>

      <section className="admin-surface" aria-labelledby="create-category-title">
        <div className="admin-surface__heading">
          <div>
            <p className="admin-surface__index" aria-hidden="true">
              ۰۱
            </p>
            <h2 id="create-category-title">ایجاد دسته‌بندی</h2>
          </div>
          <p>نام، ترتیب نمایش و وضعیت دسته‌بندی تازه را مشخص کنید.</p>
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

      <section className="admin-surface" aria-labelledby="category-list-title">
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

              return (
                <li
                  className="category-item"
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
                        className="admin-secondary-button"
                        type="button"
                        onClick={() => setEditingId(category.id)}
                        disabled={suspended || operation !== null || editingId !== null}
                        aria-label={`ویرایش دسته‌بندی ${category.name}`}
                      >
                        ویرایش
                      </button>
                      <button
                        className="admin-secondary-button"
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

                  {editingId === category.id ? (
                    <div className="category-item__editor">
                      <CategoryForm
                        formId={`edit-category-${category.id}`}
                        initialCategory={category}
                        submitLabel="ذخیره تغییرات"
                        busy={operation === `update:${category.id}`}
                        disabled={suspended || operation !== null}
                        onSubmit={(values) =>
                          updateCategory(category.id, values, 'دسته‌بندی به‌روزرسانی شد.')
                        }
                        onCancel={() => setEditingId(null)}
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
            <span className="admin-dashboard__status">به‌زودی</span>
          </div>
          <h2>مدیریت محصولات</h2>
          <p>رابط مدیریت محصولات در مرحلهٔ بعد به پنل متصل می‌شود.</p>
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
            <span className="admin-nav-link admin-nav-link--disabled" aria-disabled="true">
              <span className="admin-nav-link__index" aria-hidden="true">
                ۰۳
              </span>
              <span>محصولات</span>
              <small>به‌زودی</small>
            </span>
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
        </div>
      </div>
    </main>
  )
}
