import { useCallback, useEffect, useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import heroImg from './assets/hero.png'
import { adminAuthApi } from './api/adminAuth.js'
import {
  adminAuthStatus,
  bootstrapAdminAuth,
  getAdminRedirect,
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

function AdminLoading({ message = 'Checking administrator session…' }) {
  return (
    <main className="admin-page" aria-live="polite">
      <div className="admin-card admin-card--centered">
        <div className="admin-spinner" aria-hidden="true"></div>
        <p>{message}</p>
      </div>
    </main>
  )
}

function AdminLogin({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  async function handleSubmit(event) {
    event.preventDefault()
    const normalizedUsername = username.trim()

    if (!normalizedUsername || !password) {
      setErrorMessage('Username and password are required.')
      return
    }

    setIsSubmitting(true)
    setErrorMessage('')

    try {
      await onLogin(normalizedUsername, password)
    } catch (error) {
      setErrorMessage(
        error?.status === 401
          ? 'Invalid username or password.'
          : 'Login is temporarily unavailable. Please try again.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="admin-page">
      <section className="admin-card" aria-labelledby="admin-login-title">
        <p className="admin-eyebrow">Riona Cafe</p>
        <h1 id="admin-login-title">Admin login</h1>
        <p className="admin-muted">Sign in with your administrator username.</p>

        <form className="admin-form" onSubmit={handleSubmit} noValidate>
          <label htmlFor="admin-username">Username</label>
          <input
            id="admin-username"
            name="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={isSubmitting}
            required
          />

          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={isSubmitting}
            required
          />

          {errorMessage ? (
            <p className="admin-error" role="alert">
              {errorMessage}
            </p>
          ) : null}

          <button className="admin-primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}

function AdminShell({ admin, onLogout }) {
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  async function handleLogout() {
    setIsLoggingOut(true)
    setErrorMessage('')

    try {
      await onLogout()
    } catch {
      setErrorMessage('Logout could not be completed. Please try again.')
      setIsLoggingOut(false)
    }
  }

  return (
    <main className="admin-page">
      <section className="admin-card" aria-labelledby="admin-shell-title">
        <p className="admin-eyebrow">Riona Cafe</p>
        <h1 id="admin-shell-title">Admin</h1>
        <p className="admin-welcome">
          Signed in as <strong>{admin.username}</strong>
        </p>
        <p className="admin-muted">The administration workspace will be added in later slices.</p>

        {errorMessage ? (
          <p className="admin-error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <button
          className="admin-secondary-button"
          type="button"
          onClick={handleLogout}
          disabled={isLoggingOut}
        >
          {isLoggingOut ? 'Signing out…' : 'Logout'}
        </button>
      </section>
    </main>
  )
}

function AdminBootstrapError({ onRetry }) {
  return (
    <main className="admin-page">
      <section className="admin-card admin-card--centered" role="alert">
        <h1>Admin unavailable</h1>
        <p>We could not verify your administrator session.</p>
        <button className="admin-primary-button" type="button" onClick={onRetry}>
          Try again
        </button>
      </section>
    </main>
  )
}

function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const [auth, setAuth] = useState({
    status: adminAuthStatus.loading,
    admin: null,
    error: null,
  })

  const navigate = useCallback((target, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', target)
    setPathname(window.location.pathname)
  }, [])

  useEffect(() => {
    function handlePopState() {
      setPathname(window.location.pathname)
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    let isCurrent = true

    bootstrapAdminAuth(adminAuthApi).then((nextAuth) => {
      if (isCurrent) {
        setAuth(nextAuth)
      }
    })

    return () => {
      isCurrent = false
    }
  }, [bootstrapAttempt])

  const redirectTarget = getAdminRedirect(pathname, auth.status)

  useEffect(() => {
    if (redirectTarget) {
      navigate(redirectTarget, { replace: true })
    }
  }, [navigate, redirectTarget])

  async function handleLogin(username, password) {
    const admin = await adminAuthApi.login(username, password)
    setAuth({ status: adminAuthStatus.authenticated, admin, error: null })
  }

  async function handleLogout() {
    await adminAuthApi.logout()
    setAuth({ status: adminAuthStatus.anonymous, admin: null, error: null })
  }

  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/')

  if (!isAdminPath) {
    return <PublicHome />
  }

  if (auth.status === adminAuthStatus.loading || redirectTarget) {
    return <AdminLoading />
  }

  if (auth.status === adminAuthStatus.error) {
    return <AdminBootstrapError onRetry={() => setBootstrapAttempt((attempt) => attempt + 1)} />
  }

  if (pathname === '/admin/login') {
    return <AdminLogin onLogin={handleLogin} />
  }

  if (pathname === '/admin' && auth.admin) {
    return <AdminShell admin={auth.admin} onLogout={handleLogout} />
  }

  return <AdminLoading message="Admin page not found." />
}

export default App
