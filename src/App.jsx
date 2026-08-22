import { useCallback, useEffect, useRef, useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import heroImg from './assets/hero.png'
import { AdminPanel } from './admin/AdminPanel.jsx'
import { adminAuthApi } from './api/adminAuth.js'
import {
  adminRouteKind,
  adminAuthStatus,
  bootstrapAdminAuth,
  getAdminRedirect,
  resolveAdminRoute,
} from './admin/authState.js'
import './App.css'

function PublicHome() {
  const [count, setCount] = useState(0)

  return (
    <>
      <section id="center">
        <div className="hero">
          <img src={heroImg} className="base" width="170" height="179" alt="" />
          <img src={reactLogo} className="framework" alt="React logo" />
          <img src={viteLogo} className="vite" alt="Vite logo" />
        </div>
        <div>
          <h1>Get started</h1>
          <p>
            Edit <code>src/App.jsx</code> and save to test <code>HMR</code>
          </p>
        </div>
        <button
          type="button"
          className="counter"
          onClick={() => setCount((currentCount) => currentCount + 1)}
        >
          Count is {count}
        </button>
      </section>

      <div className="ticks"></div>

      <section id="next-steps">
        <div id="docs">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#documentation-icon"></use>
          </svg>
          <h2>Documentation</h2>
          <p>Your questions, answered</p>
          <ul>
            <li>
              <a href="https://vite.dev/" target="_blank">
                <img className="logo" src={viteLogo} alt="" />
                Explore Vite
              </a>
            </li>
            <li>
              <a href="https://react.dev/" target="_blank">
                <img className="button-icon" src={reactLogo} alt="" />
                Learn more
              </a>
            </li>
          </ul>
        </div>
        <div id="social">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#social-icon"></use>
          </svg>
          <h2>Connect with us</h2>
          <p>Join the Vite community</p>
          <ul>
            <li>
              <a href="https://github.com/vitejs/vite" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#github-icon"></use>
                </svg>
                GitHub
              </a>
            </li>
            <li>
              <a href="https://chat.vite.dev/" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#discord-icon"></use>
                </svg>
                Discord
              </a>
            </li>
            <li>
              <a href="https://x.com/vite_js" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#x-icon"></use>
                </svg>
                X.com
              </a>
            </li>
            <li>
              <a href="https://bsky.app/profile/vite.dev" target="_blank">
                <svg className="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#bluesky-icon"></use>
                </svg>
                Bluesky
              </a>
            </li>
          </ul>
        </div>
      </section>

      <div className="ticks"></div>
      <section id="spacer"></section>
    </>
  )
}

function AdminLoading({ message = 'در حال بررسی نشست مدیریت…' }) {
  return (
    <main className="admin-page admin-page--state" dir="rtl" lang="fa">
      <section
        className="admin-card admin-card--centered admin-state-card"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="admin-brand-mark" aria-hidden="true">
          R
        </span>
        <div className="admin-spinner" aria-hidden="true"></div>
        <p className="admin-state-card__title">{message}</p>
        <p className="admin-muted admin-state-card__hint">چند لحظه منتظر بمانید.</p>
      </section>
    </main>
  )
}

const adminUsernameRequiredMessage = 'نام کاربری را وارد کنید.'
const adminPasswordRequiredMessage = 'رمز عبور را وارد کنید.'

function AdminLogin({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [requiredErrors, setRequiredErrors] = useState({ username: '', password: '' })
  const [hasCredentialError, setHasCredentialError] = useState(false)
  const submitLockRef = useRef(false)
  const isMountedRef = useRef(true)
  const usernameInputRef = useRef(null)
  const passwordInputRef = useRef(null)
  const errorRef = useRef(null)
  const shouldFocusErrorRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (errorMessage && shouldFocusErrorRef.current) {
      errorRef.current?.focus()
      shouldFocusErrorRef.current = false
    }
  }, [errorMessage])

  function clearGlobalError(nextValues = null) {
    const hadGlobalError = Boolean(errorMessage || hasCredentialError)

    shouldFocusErrorRef.current = false
    setErrorMessage('')
    setHasCredentialError(false)

    if (hadGlobalError && nextValues) {
      setRequiredErrors({
        username: nextValues.username.trim() ? '' : adminUsernameRequiredMessage,
        password: nextValues.password ? '' : adminPasswordRequiredMessage,
      })
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    if (submitLockRef.current) {
      return
    }

    const normalizedUsername = username.trim()
    const submittedPassword = password

    if (!normalizedUsername || !submittedPassword) {
      const nextRequiredErrors = {
        username: normalizedUsername ? '' : adminUsernameRequiredMessage,
        password: submittedPassword ? '' : adminPasswordRequiredMessage,
      }

      setRequiredErrors(nextRequiredErrors)
      clearGlobalError()

      if (nextRequiredErrors.username) {
        usernameInputRef.current?.focus()
      } else {
        passwordInputRef.current?.focus()
      }

      return
    }

    submitLockRef.current = true
    setIsSubmitting(true)
    clearGlobalError()
    setRequiredErrors({ username: '', password: '' })
    setPassword('')

    try {
      await onLogin(normalizedUsername, submittedPassword)
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }

      shouldFocusErrorRef.current = true

      if (error?.status === 401) {
        setHasCredentialError(true)
        setErrorMessage('نام کاربری یا رمز عبور نادرست است.')
      } else if (error?.status === 429) {
        setHasCredentialError(false)
        setErrorMessage('تعداد تلاش‌های ورود بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.')
      } else if (error?.kind === 'network') {
        setHasCredentialError(false)
        setErrorMessage('ارتباط با سرور برقرار نشد. اتصال خود را بررسی و دوباره تلاش کنید.')
      } else {
        setHasCredentialError(false)
        setErrorMessage('ورود در حال حاضر ممکن نیست. دوباره تلاش کنید.')
      }
    } finally {
      if (isMountedRef.current) {
        submitLockRef.current = false
        setIsSubmitting(false)
      }
    }
  }

  const usernameErrorId = 'admin-username-error'
  const passwordErrorId = 'admin-password-error'
  const usernameInvalid = Boolean(requiredErrors.username || hasCredentialError)
  const passwordInvalid = Boolean(requiredErrors.password || hasCredentialError)
  const usernameDescription = requiredErrors.username
    ? `admin-login-help ${usernameErrorId}`
    : hasCredentialError
      ? 'admin-login-help admin-login-error'
      : 'admin-login-help'
  const passwordDescription = requiredErrors.password
    ? `admin-login-help ${passwordErrorId}`
    : hasCredentialError
      ? 'admin-login-help admin-login-error'
      : 'admin-login-help'

  return (
    <main className="admin-page admin-page--login" dir="rtl" lang="fa">
      <section className="admin-card admin-login-card" aria-labelledby="admin-login-title">
        <header className="admin-login-card__header">
          <span className="admin-brand-mark" aria-hidden="true">
            R
          </span>
          <div>
            <p className="admin-eyebrow" lang="en" dir="ltr">
              Riona Café
            </p>
            <p className="admin-login-card__kicker">فضای مدیریت منو</p>
          </div>
        </header>

        <div className="admin-login-card__intro">
          <h1 id="admin-login-title">ورود به پنل مدیریت</h1>
          <p className="admin-muted" id="admin-login-help">
            برای مدیریت منوی کافه، نام کاربری و رمز عبور مدیر را وارد کنید.
          </p>
        </div>

        <form
          className="admin-form"
          onSubmit={handleSubmit}
          noValidate
          aria-busy={isSubmitting}
        >
          <div className="admin-form__field">
            <label htmlFor="admin-username">نام کاربری</label>
            <input
              ref={usernameInputRef}
              id="admin-username"
              name="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => {
                const nextUsername = event.target.value
                setUsername(nextUsername)

                if (requiredErrors.username && nextUsername.trim()) {
                  setRequiredErrors((current) => ({ ...current, username: '' }))
                }

                clearGlobalError({ username: nextUsername, password })
              }}
              disabled={isSubmitting}
              aria-invalid={usernameInvalid}
              aria-describedby={usernameDescription}
              autoFocus
              required
            />
            {requiredErrors.username ? (
              <span className="admin-error" id={usernameErrorId} role="alert">
                {requiredErrors.username}
              </span>
            ) : null}
          </div>

          <div className="admin-form__field">
            <label htmlFor="admin-password">رمز عبور</label>
            <input
              ref={passwordInputRef}
              id="admin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                const nextPassword = event.target.value
                setPassword(nextPassword)

                if (requiredErrors.password && nextPassword) {
                  setRequiredErrors((current) => ({ ...current, password: '' }))
                }

                clearGlobalError({ username, password: nextPassword })
              }}
              disabled={isSubmitting}
              aria-invalid={passwordInvalid}
              aria-describedby={passwordDescription}
              required
            />
            {requiredErrors.password ? (
              <span className="admin-error" id={passwordErrorId} role="alert">
                {requiredErrors.password}
              </span>
            ) : null}
          </div>

          {errorMessage ? (
            <p
              ref={errorRef}
              id="admin-login-error"
              className="admin-error"
              role="alert"
              tabIndex="-1"
            >
              {errorMessage}
            </p>
          ) : null}

          <button className="admin-primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'در حال ورود…' : 'ورود'}
          </button>
        </form>

        <p className="admin-login-card__footer">دسترسی این بخش فقط برای مدیران کافه است.</p>
      </section>
    </main>
  )
}

function AdminBootstrapError({ onRetry }) {
  return (
    <main className="admin-page admin-page--state" dir="rtl" lang="fa">
      <section
        className="admin-card admin-card--centered admin-state-card"
        role="alert"
        aria-labelledby="admin-bootstrap-error-title"
      >
        <span className="admin-state-card__symbol admin-state-card__symbol--error" aria-hidden="true">
          !
        </span>
        <p className="admin-eyebrow">خطای ارتباط</p>
        <h1 id="admin-bootstrap-error-title">پنل مدیریت در دسترس نیست</h1>
        <p className="admin-muted">بررسی نشست مدیریت انجام نشد. اتصال خود را بررسی کنید.</p>
        <button className="admin-primary-button" type="button" onClick={onRetry}>
          تلاش دوباره
        </button>
      </section>
    </main>
  )
}

function AdminNotFound() {
  return (
    <main
      className="admin-page admin-page--state"
      dir="rtl"
      lang="fa"
      data-route-status="404"
    >
      <section
        className="admin-card admin-card--centered admin-state-card"
        aria-labelledby="admin-not-found-title"
      >
        <span className="admin-brand-mark" aria-hidden="true">
          R
        </span>
        <p className="admin-eyebrow">خطای 404</p>
        <h1 id="admin-not-found-title">صفحهٔ مدیریت پیدا نشد</h1>
        <p className="admin-muted">مسیر درخواستی در پنل مدیریت وجود ندارد.</p>
        <a className="admin-primary-button admin-state-card__link" href="/admin">
          بازگشت به پنل مدیریت
        </a>
      </section>
    </main>
  )
}

function App() {
  const initialPathname = window.location.pathname
  const [pathname, setPathname] = useState(initialPathname)
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const [logoutState, setLogoutState] = useState({
    pending: false,
    navigationVersion: null,
  })
  const [auth, setAuth] = useState({
    status: adminAuthStatus.checking,
    admin: null,
    error: null,
  })
  const pathnameRef = useRef(initialPathname)
  const navigationVersionRef = useRef(0)
  const authEpochRef = useRef(0)
  const activeAuthOperationRef = useRef(null)
  const isMountedRef = useRef(false)
  const route = resolveAdminRoute(pathname)
  const isKnownAdminRoute =
    route.kind === adminRouteKind.login || route.kind === adminRouteKind.protected

  const invalidateAuthOperations = useCallback(({ preserveLogout = false } = {}) => {
    const activeOperation = activeAuthOperationRef.current

    if (preserveLogout && activeOperation?.type === 'logout') {
      return authEpochRef.current
    }

    authEpochRef.current += 1
    activeOperation?.controller.abort()
    activeAuthOperationRef.current = null
    return authEpochRef.current
  }, [])

  const beginAuthOperation = useCallback(
    (type) => {
      const epoch = invalidateAuthOperations()
      const operation = { type, epoch, controller: new AbortController() }
      activeAuthOperationRef.current = operation
      return operation
    },
    [invalidateAuthOperations],
  )

  const isAuthOperationCurrent = useCallback(
    (operation) =>
      isMountedRef.current &&
      authEpochRef.current === operation.epoch &&
      activeAuthOperationRef.current === operation,
    [],
  )

  const finishAuthOperation = useCallback((operation) => {
    if (activeAuthOperationRef.current === operation) {
      activeAuthOperationRef.current = null
    }
  }, [])

  const getSessionEpoch = useCallback(() => authEpochRef.current, [])
  const isSessionEpochCurrent = useCallback(
    (epoch) => isMountedRef.current && authEpochRef.current === epoch,
    [],
  )

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
      invalidateAuthOperations()
    }
  }, [invalidateAuthOperations])

  const navigate = useCallback(
    (target, { replace = false } = {}) => {
      const nextUrl = new URL(target, window.location.href)
      const previousRoute = resolveAdminRoute(pathnameRef.current)
      const nextRoute = resolveAdminRoute(nextUrl.pathname)
      const nextIsKnownAdminRoute =
        nextRoute.kind === adminRouteKind.login || nextRoute.kind === adminRouteKind.protected
      const previousWasKnownAdminRoute =
        previousRoute.kind === adminRouteKind.login ||
        previousRoute.kind === adminRouteKind.protected
      const activeAuthOperation = activeAuthOperationRef.current
      const hasPendingLogout = activeAuthOperation?.type === 'logout'
      const canKeepBootstrap =
        activeAuthOperation?.type === 'bootstrap' &&
        previousWasKnownAdminRoute &&
        nextIsKnownAdminRoute

      if (!canKeepBootstrap) {
        invalidateAuthOperations({ preserveLogout: true })
      }
      navigationVersionRef.current += 1

      if (nextIsKnownAdminRoute && !previousWasKnownAdminRoute && !hasPendingLogout) {
        setAuth({ status: adminAuthStatus.checking, admin: null, error: null })
      }

      window.history[replace ? 'replaceState' : 'pushState']({}, '', target)
      pathnameRef.current = window.location.pathname
      setPathname(window.location.pathname)
    },
    [invalidateAuthOperations],
  )

  useEffect(() => {
    function handlePopState() {
      const nextPathname = window.location.pathname
      const previousRoute = resolveAdminRoute(pathnameRef.current)
      const nextRoute = resolveAdminRoute(nextPathname)
      const nextIsKnownAdminRoute =
        nextRoute.kind === adminRouteKind.login || nextRoute.kind === adminRouteKind.protected
      const previousWasKnownAdminRoute =
        previousRoute.kind === adminRouteKind.login ||
        previousRoute.kind === adminRouteKind.protected
      const activeAuthOperation = activeAuthOperationRef.current
      const hasPendingLogout = activeAuthOperation?.type === 'logout'
      const canKeepBootstrap =
        activeAuthOperation?.type === 'bootstrap' &&
        previousWasKnownAdminRoute &&
        nextIsKnownAdminRoute

      if (!canKeepBootstrap) {
        invalidateAuthOperations({ preserveLogout: true })
      }
      navigationVersionRef.current += 1

      if (nextIsKnownAdminRoute && !previousWasKnownAdminRoute && !hasPendingLogout) {
        setAuth({ status: adminAuthStatus.checking, admin: null, error: null })
      }

      pathnameRef.current = nextPathname
      setPathname(nextPathname)
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [invalidateAuthOperations])

  useEffect(() => {
    if (route.kind !== adminRouteKind.canonical) {
      return
    }

    const hasPendingLogout = activeAuthOperationRef.current?.type === 'logout'
    const canonicalLocation = `${route.canonicalPath}${window.location.search}${window.location.hash}`

    invalidateAuthOperations({ preserveLogout: true })
    navigationVersionRef.current += 1

    if (!hasPendingLogout) {
      setAuth({ status: adminAuthStatus.checking, admin: null, error: null })
    }

    window.history.replaceState(window.history.state, '', canonicalLocation)
    pathnameRef.current = window.location.pathname
    setPathname(window.location.pathname)
  }, [invalidateAuthOperations, route.canonicalPath, route.kind])

  useEffect(() => {
    if (!isKnownAdminRoute || activeAuthOperationRef.current?.type === 'logout') {
      return undefined
    }

    const operation = beginAuthOperation('bootstrap')

    setAuth({ status: adminAuthStatus.checking, admin: null, error: null })

    bootstrapAdminAuth(adminAuthApi, { signal: operation.controller.signal }).then(
      (nextAuth) => {
        if (!isAuthOperationCurrent(operation)) {
          return
        }

        setAuth(nextAuth)
        finishAuthOperation(operation)
      },
    )

    return () => {
      if (isAuthOperationCurrent(operation)) {
        invalidateAuthOperations()
      } else {
        operation.controller.abort()
      }
    }
  }, [
    beginAuthOperation,
    bootstrapAttempt,
    finishAuthOperation,
    invalidateAuthOperations,
    isAuthOperationCurrent,
    isKnownAdminRoute,
  ])

  const redirectTarget = getAdminRedirect(pathname, auth.status)

  useEffect(() => {
    if (redirectTarget && !logoutState.pending) {
      navigate(redirectTarget, { replace: true })
    }
  }, [logoutState.pending, navigate, redirectTarget])

  async function handleLogin(username, password) {
    const operation = beginAuthOperation('login')

    try {
      const admin = await adminAuthApi.login(username, password, {
        signal: operation.controller.signal,
      })

      if (!isAuthOperationCurrent(operation)) {
        return false
      }

      setAuth({ status: adminAuthStatus.authenticated, admin, error: null })
      return true
    } catch (error) {
      if (!isAuthOperationCurrent(operation)) {
        return false
      }

      throw error
    } finally {
      finishAuthOperation(operation)
    }
  }

  async function handleLogout() {
    const operation = beginAuthOperation('logout')
    setLogoutState({
      pending: true,
      navigationVersion: navigationVersionRef.current,
    })

    try {
      await adminAuthApi.logout({ signal: operation.controller.signal })

      if (!isAuthOperationCurrent(operation)) {
        return false
      }

      setAuth({ status: adminAuthStatus.unauthenticated, admin: null, error: null })
      return true
    } catch (error) {
      if (!isAuthOperationCurrent(operation)) {
        return false
      }

      if (error?.status === 401) {
        setAuth({ status: adminAuthStatus.unauthenticated, admin: null, error: null })
        return true
      }

      throw error
    } finally {
      if (isAuthOperationCurrent(operation)) {
        setLogoutState({ pending: false, navigationVersion: null })
      }

      finishAuthOperation(operation)
    }
  }

  const handleAuthenticationRequired = useCallback(
    (sessionEpoch) => {
      if (!isSessionEpochCurrent(sessionEpoch)) {
        return false
      }

      invalidateAuthOperations()
      setAuth({ status: adminAuthStatus.unauthenticated, admin: null, error: null })
      return true
    },
    [invalidateAuthOperations, isSessionEpochCurrent],
  )

  if (route.kind === adminRouteKind.public) {
    return <PublicHome />
  }

  if (route.kind === adminRouteKind.canonical) {
    return <AdminLoading />
  }

  if (route.kind === adminRouteKind.notFound) {
    return <AdminNotFound />
  }

  const logoutMovedAway =
    logoutState.pending && logoutState.navigationVersion !== navigationVersionRef.current

  if (auth.status === adminAuthStatus.checking || redirectTarget || logoutMovedAway) {
    return <AdminLoading />
  }

  if (auth.status === adminAuthStatus.error) {
    return (
      <AdminBootstrapError
        onRetry={() => {
          invalidateAuthOperations()
          setAuth({ status: adminAuthStatus.checking, admin: null, error: null })
          setBootstrapAttempt((attempt) => attempt + 1)
        }}
      />
    )
  }

  if (pathname === '/admin/login') {
    return <AdminLogin onLogin={handleLogin} />
  }

  if ((pathname === '/admin' || pathname === '/admin/categories') && auth.admin) {
    return (
      <AdminPanel
        admin={auth.admin}
        pathname={pathname}
        onLogout={handleLogout}
        onAuthenticationRequired={handleAuthenticationRequired}
        getSessionEpoch={getSessionEpoch}
        isSessionEpochCurrent={isSessionEpochCurrent}
      />
    )
  }

  return <AdminNotFound />
}

export default App
