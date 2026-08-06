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
    return { error: 'نام دسته‌بندی را وارد کنید.' }
  }

  if (Array.from(normalizedName).length > maximumCategoryNameCharacters) {
    return { error: `نام دسته‌بندی نباید بیشتر از ${maximumCategoryNameCharacters} نویسه باشد.` }
  }

  if (!/^\d+$/.test(sortOrder)) {
    return { error: 'ترتیب نمایش باید یک عدد صحیح نامنفی باشد.' }
  }

  const normalizedSortOrder = Number(sortOrder)

  if (!Number.isSafeInteger(normalizedSortOrder) || normalizedSortOrder > maximumSortOrder) {
    return { error: 'ترتیب نمایش خارج از محدودهٔ مجاز است.' }
  }

  return { name: normalizedName, sortOrder: normalizedSortOrder }
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
  const [validationError, setValidationError] = useState('')
  const submittingRef = useRef(false)

  async function handleSubmit(event) {
    event.preventDefault()

    if (submittingRef.current || disabled) {
      return
    }

    const validated = validateForm(name, sortOrder)

    if (validated.error) {
      setValidationError(validated.error)
      return
    }

    setValidationError('')
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

  return (
    <form className="category-form" onSubmit={handleSubmit} noValidate>
      <div className="category-form__field category-form__field--name">
        <label htmlFor={`${formId}-name`}>نام دسته‌بندی</label>
        <input
          id={`${formId}-name`}
          name="categoryName"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
      </div>

      <div className="category-form__field">
        <label htmlFor={`${formId}-order`}>ترتیب نمایش</label>
        <input
          id={`${formId}-order`}
          name="sortOrder"
          type="number"
          min="0"
          step="1"
          value={sortOrder}
          onChange={(event) => setSortOrder(event.target.value)}
          disabled={disabled}
        />
      </div>

      <label className="category-checkbox" htmlFor={`${formId}-visible`}>
        <input
          id={`${formId}-visible`}
          name="isVisible"
          type="checkbox"
          checked={isVisible}
          onChange={(event) => setIsVisible(event.target.checked)}
          disabled={disabled}
        />
        فعال باشد
      </label>

      {validationError ? (
        <p className="admin-notice admin-notice--error category-form__message" role="alert">
          {validationError}
        </p>
      ) : null}

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

function CategoryManager({ onAuthenticationRequired }) {
  const [categories, setCategories] = useState([])
  const [loadState, setLoadState] = useState('loading')
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const [editingId, setEditingId] = useState(null)
  const [operation, setOperation] = useState(null)
  const [notice, setNotice] = useState(null)
  const operationLockRef = useRef(null)

  useEffect(() => {
    let isCurrent = true
    setLoadState('loading')
    setNotice(null)

    adminCategoriesApi
      .list()
      .then((loadedCategories) => {
        if (isCurrent) {
          setCategories(sortCategories(loadedCategories))
          setLoadState('ready')
        }
      })
      .catch((error) => {
        if (!isCurrent) {
          return
        }

        if (error?.status === 401) {
          onAuthenticationRequired()
          return
        }

        setLoadState('error')
      })

    return () => {
      isCurrent = false
    }
  }, [onAuthenticationRequired, reloadAttempt])

  function handleOperationError(error) {
    if (error?.status === 401) {
      onAuthenticationRequired()
      return
    }

    setNotice({ type: 'error', message: categoryErrorMessage(error) })
  }

  function beginOperation(operationName) {
    if (operationLockRef.current !== null) {
      return false
    }

    operationLockRef.current = operationName
    setOperation(operationName)
    setNotice(null)
    return true
  }

  function finishOperation(operationName) {
    if (operationLockRef.current === operationName) {
      operationLockRef.current = null
      setOperation(null)
    }
  }

  async function createCategory(values) {
    const operationName = 'create'

    if (!beginOperation(operationName)) {
      return false
    }

    try {
      const category = await adminCategoriesApi.create(values)
      setCategories((current) => sortCategories([...current, category]))
      setNotice({ type: 'success', message: 'دسته‌بندی با موفقیت ایجاد شد.' })
      return true
    } catch (error) {
      handleOperationError(error)
      return false
    } finally {
      finishOperation(operationName)
    }
  }

  async function updateCategory(categoryId, values, successMessage) {
    const operationName = `update:${categoryId}`

    if (!beginOperation(operationName)) {
      return false
    }

    try {
      const category = await adminCategoriesApi.update(categoryId, values)
      setCategories((current) =>
        sortCategories(current.map((item) => (item.id === category.id ? category : item))),
      )
      setEditingId(null)
      setNotice({ type: 'success', message: successMessage })
      return true
    } catch (error) {
      handleOperationError(error)
      return false
    } finally {
      finishOperation(operationName)
    }
  }

  async function deleteCategory(category) {
    const operationName = `delete:${category.id}`

    if (!beginOperation(operationName)) {
      return
    }

    try {
      if (!window.confirm(`دسته‌بندی «${category.name}» حذف شود؟`)) {
        return
      }

      await adminCategoriesApi.remove(category.id)
      setCategories((current) => current.filter((item) => item.id !== category.id))
      setNotice({ type: 'success', message: 'دسته‌بندی حذف شد.' })
    } catch (error) {
      handleOperationError(error)
    } finally {
      finishOperation(operationName)
    }
  }

  return (
    <section className="category-management" aria-labelledby="category-management-title">
      <div className="admin-section-heading">
        <div>
          <p className="admin-eyebrow">مدیریت منو</p>
          <h1 id="category-management-title">دسته‌بندی‌ها</h1>
          <p>دسته‌بندی‌های منو، وضعیت نمایش و ترتیب آن‌ها را مدیریت کنید.</p>
        </div>
      </div>

      <section className="admin-surface" aria-labelledby="create-category-title">
        <h2 id="create-category-title">ایجاد دسته‌بندی</h2>
        <CategoryForm
          formId="create-category"
          submitLabel="ایجاد دسته‌بندی"
          busy={operation === 'create'}
          disabled={operation !== null || loadState !== 'ready'}
          onSubmit={createCategory}
        />
      </section>

      {notice ? (
        <p
          className={`admin-notice admin-notice--${notice.type}`}
          role={notice.type === 'error' ? 'alert' : 'status'}
        >
          {notice.message}
        </p>
      ) : null}

      <section className="admin-surface" aria-labelledby="category-list-title">
        <div className="category-list-heading">
          <h2 id="category-list-title">فهرست دسته‌بندی‌ها</h2>
          {loadState === 'ready' ? <span>{categories.length} مورد</span> : null}
        </div>

        {loadState === 'loading' ? (
          <div className="admin-inline-state" aria-live="polite">
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
            >
              تلاش دوباره
            </button>
          </div>
        ) : null}

        {loadState === 'ready' && categories.length === 0 ? (
          <div className="admin-inline-state admin-inline-state--empty">
            <p>هنوز دسته‌بندی‌ای ایجاد نشده است.</p>
          </div>
        ) : null}

        {loadState === 'ready' && categories.length > 0 ? (
          <ul className="category-list">
            {categories.map((category) => {
              const isBusy = operation?.endsWith(`:${category.id}`) ?? false

              return (
                <li className="category-item" data-category-id={category.id} key={category.id}>
                  <div className="category-item__summary">
                    <div>
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
                        disabled={operation !== null || editingId !== null}
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
                        disabled={operation !== null || editingId !== null}
                      >
                        {isBusy ? 'در حال ذخیره…' : category.isVisible ? 'غیرفعال‌کردن' : 'فعال‌کردن'}
                      </button>
                      <button
                        className="admin-danger-button"
                        type="button"
                        onClick={() => deleteCategory(category)}
                        disabled={operation !== null || editingId !== null}
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
                        disabled={operation !== null}
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

export function AdminPanel({ admin, onLogout, onAuthenticationRequired }) {
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')

  async function handleLogout() {
    if (isLoggingOut) {
      return
    }

    setIsLoggingOut(true)
    setLogoutError('')

    try {
      await onLogout()
    } catch {
      setLogoutError('خروج از حساب انجام نشد. دوباره تلاش کنید.')
      setIsLoggingOut(false)
    }
  }

  return (
    <main className="admin-panel" dir="rtl" lang="fa">
      <header className="admin-panel__header">
        <div>
          <strong>کافه ریونا</strong>
          <span>پنل مدیریت</span>
        </div>
        <div className="admin-panel__identity">
          <span>
            مدیر: <strong>{admin.username}</strong>
          </span>
          <button
            className="admin-secondary-button"
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
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
            <a className="admin-nav-link admin-nav-link--active" href="/admin/categories" aria-current="page">
              دسته‌بندی‌ها
            </a>
          </nav>
        </aside>
        <div className="admin-panel__content">
          <CategoryManager onAuthenticationRequired={onAuthenticationRequired} />
        </div>
      </div>
    </main>
  )
}
