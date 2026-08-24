import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import { createServer as createViteServer } from 'vite'

import viteConfig from '../vite.config.js'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const viteCacheDirectory = await mkdtemp(join(tmpdir(), 'riona-admin-app-test-'))
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/admin',
})
const originalGlobals = new Map()

function installGlobal(name, value) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

installGlobal('window', dom.window)
installGlobal('document', dom.window.document)
installGlobal('navigator', dom.window.navigator)
installGlobal('HTMLElement', dom.window.HTMLElement)
installGlobal('HTMLInputElement', dom.window.HTMLInputElement)
installGlobal('Event', dom.window.Event)
installGlobal('MouseEvent', dom.window.MouseEvent)
installGlobal('Node', dom.window.Node)
installGlobal('MutationObserver', dom.window.MutationObserver)
installGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
installGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const originalFetch = globalThis.fetch
let fetchHandler = null

globalThis.fetch = (...argumentsList) => fetchHandler(...argumentsList)

const viteServer = await createViteServer({
  root: projectRoot,
  cacheDir: viteCacheDirectory,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
})
const [{ default: App }, { act, createElement, StrictMode }, { createRoot }] = await Promise.all([
  viteServer.ssrLoadModule('/src/App.jsx'),
  import('react'),
  import('react-dom/client'),
])

let activeRoot = null

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createControlledResponse() {
  let resolveResponse
  let rejectResponse
  const response = new Promise((resolvePromise, rejectPromise) => {
    resolveResponse = resolvePromise
    rejectResponse = rejectPromise
  })

  return { response, resolveResponse, rejectResponse }
}

async function settle() {
  for (let cycle = 0; cycle < 4; cycle += 1) {
    await act(() => new Promise((resolveCycle) => setTimeout(resolveCycle, 0)))
  }
}

async function unmountApp() {
  if (!activeRoot) {
    return
  }

  await act(() => activeRoot.unmount())
  activeRoot = null
}

async function mountApp(pathname, handler, { settleAfterRender = true, strict = false } = {}) {
  await unmountApp()
  dom.window.history.replaceState({}, '', pathname)
  fetchHandler = handler
  const container = dom.window.document.getElementById('root')
  activeRoot = createRoot(container)

  await act(() =>
    activeRoot.render(
      strict ? createElement(StrictMode, null, createElement(App)) : createElement(App),
    ),
  )

  if (settleAfterRender) {
    await settle()
  }

  return container
}

async function setInputValue(input, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  ).set

  await act(() => {
    valueSetter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

async function travelHistory(direction) {
  const navigationCompleted = new Promise((resolveNavigation) => {
    dom.window.addEventListener('popstate', resolveNavigation, { once: true })
  })

  dom.window.history[direction]()
  await act(async () => navigationCompleted)
  await settle()
}

function listenOnEphemeralPort(server) {
  return new Promise((resolveListen, rejectListen) => {
    function handleError(error) {
      server.off('listening', handleListening)
      rejectListen(error)
    }

    function handleListening() {
      server.off('error', handleError)
      resolveListen(server.address())
    }

    server.once('error', handleError)
    server.once('listening', handleListening)
    server.listen(0, '127.0.0.1')
  })
}

async function closeHttpServer(server) {
  if (!server?.listening) {
    return
  }

  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error)
      } else {
        resolveClose()
      }
    })
    server.closeIdleConnections?.()
  })
}

async function collectCleanupErrors(cleanupSteps) {
  const cleanupErrors = []

  for (const cleanup of cleanupSteps) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  return cleanupErrors
}

function readCssDeclaration(css, selector, property) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rules = [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'g'))]

  assert.notEqual(rules.length, 0, `Missing production CSS rule: ${selector}`)

  const declaration = rules
    .map((rule) => rule[1].match(new RegExp(`${property}\\s*:\\s*([^;]+);`)))
    .find(Boolean)
  assert.notEqual(declaration, null, `Missing ${property} declaration in ${selector}`)
  assert.notEqual(declaration, undefined, `Missing ${property} declaration in ${selector}`)

  return declaration[1].trim()
}

function relativeLuminance(hexColor) {
  const channels = hexColor
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(firstColor, secondColor) {
  const luminances = [relativeLuminance(firstColor), relativeLuminance(secondColor)].sort(
    (first, second) => second - first,
  )

  return (luminances[0] + 0.05) / (luminances[1] + 0.05)
}

test.after(async () => {
  await unmountApp()
  await viteServer.close()
  globalThis.fetch = originalFetch
  dom.window.close()
  await rm(viteCacheDirectory, { recursive: true, force: true })

  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      delete globalThis[name]
    }
  }
})

test('keeps admin help contrast and Vazirmatn weights production-safe', async () => {
  const [adminCss, publicCss] = await Promise.all([
    readFile(join(projectRoot, 'src', 'App.css'), 'utf8'),
    readFile(join(projectRoot, 'src', 'index.css'), 'utf8'),
  ])
  const helpColor = readCssDeclaration(
    adminCss,
    '.admin-panel .category-form__help',
    'color',
  )
  const adminSurface = adminCss.match(/--admin-surface:\s*(#[0-9a-f]{6})\s*;/i)

  assert.notEqual(adminSurface, null, 'Missing the production Admin surface color')

  const helpBackgrounds = new Map([
    ['create form', adminSurface[1]],
    [
      'visibility control',
      readCssDeclaration(adminCss, '.admin-panel .category-form__visibility', 'background'),
    ],
    [
      'edit form',
      readCssDeclaration(adminCss, '.admin-panel .category-item__editor', 'background'),
    ],
  ])

  for (const [context, backgroundColor] of helpBackgrounds) {
    const ratio = contrastRatio(helpColor, backgroundColor)
    assert.ok(
      ratio >= 4.5,
      `${context} help contrast must be at least 4.5:1; received ${ratio}`,
    )
  }

  const vazirmatnImports = [...adminCss.matchAll(
    /^@import\s+['"]@fontsource\/vazirmatn\/(\d+)\.css['"];/gm,
  )].map((match) => Number(match[1]))
  const declaredNumericWeights = [...adminCss.matchAll(/font-weight:\s*(\d+)\s*;/g)].map(
    (match) => Number(match[1]),
  )

  assert.deepEqual(vazirmatnImports, [400, 600, 700])
  assert.equal(declaredNumericWeights.every((weight) => [600, 700].includes(weight)), true)
  assert.doesNotMatch(adminCss, /@fontsource\/vazirmatn\/500\.css/)
  assert.doesNotMatch(adminCss, /font-weight:\s*800\b/)
  assert.match(
    adminCss,
    /\.admin-page\s*,\s*\.admin-panel\s*\{[^}]*font-family:\s*Vazirmatn,/s,
  )
  assert.doesNotMatch(publicCss, /Vazirmatn/i)
})

test('uses the real Vite proxy matcher only for boundary-safe API and upload paths', async () => {
  const apiContext = '^/api(?:/|\\?|$)'
  const uploadsContext = '^/uploads(?:/|\\?|$)'
  const apiProxy = viteConfig.server.proxy[apiContext]
  const uploadsProxy = viteConfig.server.proxy[uploadsContext]

  assert.equal(apiProxy.target, 'http://localhost:3000')
  assert.equal(uploadsProxy.target, apiProxy.target)
  assert.equal(apiProxy.changeOrigin, true)
  assert.equal(uploadsProxy.changeOrigin, true)
  assert.equal('rewrite' in apiProxy, false)
  assert.equal('rewrite' in uploadsProxy, false)
  assert.deepEqual(viteConfig.preview?.proxy, {})

  const backendRequests = []
  const backendServer = createHttpServer((request, response) => {
    backendRequests.push({ host: request.headers.host, url: request.url })
    response.writeHead(204)
    response.end()
  })
  const runtimeCacheDirectory = await mkdtemp(join(tmpdir(), 'riona-vite-proxy-test-'))
  let runtimeViteServer = null
  let frontendServer = null
  let probeError = null

  try {
    const backendAddress = await listenOnEphemeralPort(backendServer)
    const isolatedTarget = `http://127.0.0.1:${backendAddress.port}`
    const isolatedProxy = Object.fromEntries(
      Object.entries(viteConfig.server.proxy).map(([context, options]) => [
        context,
        { ...options, target: isolatedTarget },
      ]),
    )

    runtimeViteServer = await createViteServer({
      appType: 'custom',
      cacheDir: runtimeCacheDirectory,
      configFile: false,
      logLevel: 'silent',
      root: projectRoot,
      server: { middlewareMode: true, proxy: isolatedProxy },
    })
    frontendServer = createHttpServer((request, response) => {
      runtimeViteServer.middlewares(request, response, () => {
        response.writeHead(404)
        response.end('frontend route')
      })
    })
    const frontendAddress = await listenOnEphemeralPort(frontendServer)
    const frontendOrigin = `http://127.0.0.1:${frontendAddress.port}`
    const cases = [
      { path: '/api', proxied: true },
      { path: '/api?probe=1', proxied: true },
      { path: '/api/', proxied: true },
      { path: '/api/admin/auth/me', proxied: true },
      { path: '/uploads', proxied: true },
      { path: '/uploads/', proxied: true },
      { path: '/uploads/example.webp?download=1', proxied: true },
      { path: '/apiary', proxied: false },
      { path: '/api-backup', proxied: false },
      { path: '/uploads-backup/example.webp', proxied: false },
      { path: '/assets/example.js', proxied: false },
      { path: '/src/App.jsx', proxied: false },
      { path: '/favicon.svg', proxied: false },
    ]

    for (const probe of cases) {
      const requestCountBefore = backendRequests.length
      const response = await originalFetch(`${frontendOrigin}${probe.path}`)
      await response.arrayBuffer()

      assert.equal(
        backendRequests.length,
        requestCountBefore + (probe.proxied ? 1 : 0),
        `Unexpected proxy decision for ${probe.path}`,
      )

      if (probe.proxied) {
        const forwardedRequest = backendRequests.at(-1)
        assert.equal(response.status, 204)
        assert.equal(forwardedRequest.url, probe.path)
        assert.equal(forwardedRequest.host, `127.0.0.1:${backendAddress.port}`)
      }
    }
  } catch (error) {
    probeError = error
  }

  const cleanupErrors = await collectCleanupErrors([
    () => closeHttpServer(frontendServer),
    () => runtimeViteServer?.close(),
    () => closeHttpServer(backendServer),
    () =>
      rm(runtimeCacheDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      }),
  ])

  if (probeError && cleanupErrors.length === 0) {
    throw probeError
  }

  if (probeError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(probeError ? [probeError] : []), ...cleanupErrors],
      probeError ? 'Vite proxy probe and cleanup failed' : 'Vite proxy probe cleanup failed',
    )
  }
})

test('shows loading while current-admin bootstrap is pending', async () => {
  let resolveRequest
  const pendingResponse = new Promise((resolveResponse) => {
    resolveRequest = resolveResponse
  })
  const container = await mountApp('/admin', () => pendingResponse, {
    settleAfterRender: false,
  })

  assert.match(container.textContent, /در حال بررسی نشست مدیریت/)
  const loadingStatus = container.querySelector('[role="status"]')
  assert.notEqual(loadingStatus, null)
  assert.equal(loadingStatus.getAttribute('aria-live'), 'polite')
  assert.equal(loadingStatus.getAttribute('aria-atomic'), 'true')
  assert.equal(container.querySelector('.admin-panel'), null)

  resolveRequest(jsonResponse({ success: false, message: 'Authentication required' }, 401))
  await settle()
  assert.equal(dom.window.location.pathname, '/admin/login')
})

test('bootstraps /me and redirects an anonymous admin visitor to login', async () => {
  const requests = []
  const container = await mountApp('/admin', async (path, options) => {
    requests.push({ path, options })
    return jsonResponse({ success: false, message: 'Authentication required' }, 401)
  })

  assert.equal(requests[0].path, '/api/admin/auth/me')
  assert.equal(requests[0].options.credentials, 'include')
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.match(container.textContent, /ورود به پنل مدیریت/)
})

test('does not run admin session bootstrap or wrap the public route', async () => {
  let requestCount = 0
  const container = await mountApp('/', async () => {
    requestCount += 1
    throw new Error('The public route must not call the admin API')
  })

  assert.equal(requestCount, 0)
  assert.match(container.textContent, /Get started/)
  assert.notEqual(container.querySelector('#center'), null)
  assert.notEqual(container.querySelector('#next-steps'), null)
  assert.equal(container.querySelector('.counter')?.getAttribute('type'), 'button')
  assert.equal(container.querySelector('.admin-page'), null)
  assert.equal(container.querySelector('.admin-panel'), null)
})

test('rechecks the session without flashing protected content when returning from a public route', async () => {
  const pendingRefresh = createControlledResponse()
  let sessionChecks = 0
  const container = await mountApp('/admin', async (path) => {
    assert.equal(path, '/api/admin/auth/me')
    sessionChecks += 1

    if (sessionChecks === 1) {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    return pendingRefresh.response
  })

  assert.notEqual(container.querySelector('.admin-panel'), null)

  await act(() => {
    dom.window.history.pushState({}, '', '/')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  assert.match(container.textContent, /Get started/)

  await act(() => {
    dom.window.history.pushState({}, '', '/admin')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  assert.match(container.textContent, /در حال بررسی نشست مدیریت/)
  assert.equal(container.querySelector('.admin-panel'), null)

  pendingRefresh.resolveResponse(
    jsonResponse({ success: false, message: 'Authentication required' }, 401),
  )
  await settle()

  assert.equal(sessionChecks, 2)
  assert.equal(dom.window.location.pathname, '/admin/login')
})

test('redirects a bootstrapped administrator away from login', async () => {
  const requests = []
  const container = await mountApp('/admin/login', async (path) => {
    requests.push(path)

    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    throw new Error(`Unexpected request while redirecting from login: ${path}`)
  })

  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.textContent, /مدیر: admin/)
  assert.match(container.textContent, /پنل مدیریت کافه ریونا/)
  assert.match(container.textContent, /محصولات/)
  assert.equal(container.querySelector('nav')?.getAttribute('aria-label'), 'ناوبری مدیریت')
  assert.equal(
    container.querySelector('a[aria-current="page"]')?.textContent.replace(/\s+/g, ''),
    '۰۱داشبورد',
  )
  assert.equal(container.querySelector('h1')?.textContent, 'پنل مدیریت کافه ریونا')
  assert.deepEqual(requests, ['/api/admin/auth/me'])
})

test('submits username login and logs the administrator out', async () => {
  const requests = []
  const pendingLogout = createControlledResponse()
  const container = await mountApp('/admin/login', async (path, options) => {
    requests.push({ path, options })

    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: false, message: 'Authentication required' }, 401)
    }

    if (path === '/api/admin/auth/login') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if (path === '/api/admin/auth/logout') {
      return pendingLogout.response
    }

    if (path === '/api/admin/categories') {
      return jsonResponse({ success: true, categories: [] })
    }

    throw new Error(`Unexpected request in App integration test: ${path}`)
  })
  const usernameInput = container.querySelector('input[name="username"]')
  const passwordInput = container.querySelector('input[name="password"]')

  dom.window.localStorage.clear()
  dom.window.sessionStorage.clear()
  assert.equal(usernameInput.labels[0].textContent, 'نام کاربری')
  assert.equal(passwordInput.labels[0].textContent, 'رمز عبور')
  assert.equal(usernameInput.autocomplete, 'username')
  assert.equal(passwordInput.autocomplete, 'current-password')

  await setInputValue(usernameInput, 'admin')
  await setInputValue(passwordInput, 'valid-password')
  await act(() =>
    container
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  const loginRequest = requests.find((request) => request.path.endsWith('/login'))
  assert.deepEqual(JSON.parse(loginRequest.options.body), {
    username: 'admin',
    password: 'valid-password',
  })
  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.textContent, /مدیر: admin/)
  assert.equal(container.querySelector('input[name="password"]'), null)
  assert.equal(dom.window.localStorage.length, 0)
  assert.equal(dom.window.sessionStorage.length, 0)

  const logoutButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'خروج',
  )
  await act(() =>
    logoutButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  )

  assert.equal(logoutButton.disabled, true)
  assert.equal(logoutButton.getAttribute('aria-busy'), 'true')
  assert.equal(logoutButton.getAttribute('aria-label'), 'در حال خروج از پنل مدیریت')
  assert.match(logoutButton.textContent, /در حال خروج/)
  assert.equal(
    requests.filter((request) => request.path === '/api/admin/auth/logout').length,
    1,
  )

  pendingLogout.resolveResponse(jsonResponse({ success: true, message: 'Logged out' }))
  await settle()

  assert.equal(requests.at(-1).path, '/api/admin/auth/logout')
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.match(container.textContent, /ورود به پنل مدیریت/)

  await act(() => {
    dom.window.history.pushState({}, '', '/admin')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.admin-panel'), null)
})

test('keeps login validation field-specific and synchronized with accessible state', async (context) => {
  async function mountLogin(loginResponder = null) {
    const loginRequests = []
    const container = await mountApp('/admin/login', async (path, options) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: false, message: 'Authentication required' }, 401)
      }

      if (path === '/api/admin/auth/login') {
        loginRequests.push({ path, options })

        if (!loginResponder) {
          throw new Error('Invalid required fields must not issue a login request')
        }

        return loginResponder(path, options)
      }

      throw new Error(`Unexpected login-validation request: ${path}`)
    })

    return { container, loginRequests }
  }

  async function submitLogin(container) {
    await act(() => container.querySelector('form').requestSubmit())
    await settle()
  }

  function loginInputs(container) {
    return {
      username: container.querySelector('input[name="username"]'),
      password: container.querySelector('input[name="password"]'),
    }
  }

  await context.test('1) shows both required errors when both fields are empty', async () => {
    const { container, loginRequests } = await mountLogin()
    const inputs = loginInputs(container)

    await submitLogin(container)

    assert.equal(container.querySelector('#admin-username-error')?.textContent, 'نام کاربری را وارد کنید.')
    assert.equal(container.querySelector('#admin-password-error')?.textContent, 'رمز عبور را وارد کنید.')
    assert.equal(container.querySelector('#admin-login-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'true')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')
    assert.equal(inputs.password.value, '')
    assert.equal(loginRequests.length, 0)
  })

  await context.test('2) shows only the username error when username is empty', async () => {
    const { container, loginRequests } = await mountLogin()
    const inputs = loginInputs(container)
    await setInputValue(inputs.password, 'not-persisted')

    await submitLogin(container)

    assert.notEqual(container.querySelector('#admin-username-error'), null)
    assert.equal(container.querySelector('#admin-password-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'true')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.value, 'not-persisted')
    assert.equal(loginRequests.length, 0)
  })

  await context.test('3) shows only the password error when password is empty', async () => {
    const { container, loginRequests } = await mountLogin()
    const inputs = loginInputs(container)
    await setInputValue(inputs.username, 'admin')

    await submitLogin(container)

    assert.equal(container.querySelector('#admin-username-error'), null)
    assert.notEqual(container.querySelector('#admin-password-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')
    assert.equal(loginRequests.length, 0)
  })

  await context.test('4) editing username clears only its required error', async () => {
    const { container } = await mountLogin()
    const inputs = loginInputs(container)
    await submitLogin(container)

    await setInputValue(inputs.username, 'admin')

    assert.equal(container.querySelector('#admin-username-error'), null)
    assert.notEqual(container.querySelector('#admin-password-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')
  })

  await context.test('5) editing password clears only its required error', async () => {
    const { container } = await mountLogin()
    const inputs = loginInputs(container)
    await submitLogin(container)

    await setInputValue(inputs.password, 'secret')

    assert.notEqual(container.querySelector('#admin-username-error'), null)
    assert.equal(container.querySelector('#admin-password-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'true')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'false')
  })

  await context.test('6) aria-invalid follows the currently mounted field errors', async () => {
    const { container } = await mountLogin()
    const inputs = loginInputs(container)
    await submitLogin(container)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'true')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')

    await setInputValue(inputs.username, 'admin')
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')

    await setInputValue(inputs.password, 'secret')
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'false')
  })

  await context.test('7) aria-describedby never retains a removed error id', async () => {
    const { container } = await mountLogin()
    const inputs = loginInputs(container)
    await submitLogin(container)

    assert.equal(inputs.username.getAttribute('aria-describedby'), 'admin-login-help admin-username-error')
    assert.equal(inputs.password.getAttribute('aria-describedby'), 'admin-login-help admin-password-error')

    for (const input of Object.values(inputs)) {
      for (const id of input.getAttribute('aria-describedby').split(' ')) {
        assert.notEqual(container.querySelector(`#${id}`), null)
      }
    }

    await setInputValue(inputs.username, 'admin')
    assert.equal(container.querySelector('#admin-username-error'), null)
    assert.equal(inputs.username.getAttribute('aria-describedby'), 'admin-login-help')
    assert.equal(inputs.password.getAttribute('aria-describedby'), 'admin-login-help admin-password-error')

    await setInputValue(inputs.password, 'secret')
    assert.equal(container.querySelector('#admin-password-error'), null)
    assert.equal(inputs.password.getAttribute('aria-describedby'), 'admin-login-help')
  })

  await context.test('8) editing clears stale global credential and network errors', async () => {
    let result = await mountLogin(async () =>
      jsonResponse({ success: false, message: 'private credential detail' }, 401),
    )
    let inputs = loginInputs(result.container)
    await setInputValue(inputs.username, 'admin')
    await setInputValue(inputs.password, 'wrong-password')
    await submitLogin(result.container)

    assert.notEqual(result.container.querySelector('#admin-login-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'true')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')
    assert.match(inputs.username.getAttribute('aria-describedby'), /admin-login-error/)
    assert.doesNotMatch(result.container.textContent, /private credential detail/)

    await setInputValue(inputs.username, 'admin-2')
    assert.equal(result.container.querySelector('#admin-login-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')
    assert.equal(inputs.username.getAttribute('aria-describedby'), 'admin-login-help')
    assert.equal(
      inputs.password.getAttribute('aria-describedby'),
      'admin-login-help admin-password-error',
    )
    assert.equal(
      result.container.querySelector('#admin-password-error')?.textContent,
      'رمز عبور را وارد کنید.',
    )

    result = await mountLogin(async () => {
      throw new TypeError('private network detail')
    })
    inputs = loginInputs(result.container)
    await setInputValue(inputs.username, 'admin')
    await setInputValue(inputs.password, 'not-persisted')
    await submitLogin(result.container)
    assert.equal(
      result.container.querySelector('#admin-login-error')?.textContent,
      'ارتباط با سرور برقرار نشد. اتصال خود را بررسی و دوباره تلاش کنید.',
    )
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.username.getAttribute('aria-describedby'), 'admin-login-help')
    assert.equal(inputs.password.getAttribute('aria-describedby'), 'admin-login-help')

    await setInputValue(inputs.password, 'new-password')
    assert.equal(result.container.querySelector('#admin-login-error'), null)
    assert.doesNotMatch(result.container.textContent, /private network detail/)

    result = await mountLogin(async () =>
      jsonResponse({ success: false, message: 'private protocol detail' }, 500),
    )
    inputs = loginInputs(result.container)
    await setInputValue(inputs.username, 'admin')
    await setInputValue(inputs.password, 'not-persisted')
    await submitLogin(result.container)

    assert.equal(
      result.container.querySelector('#admin-login-error')?.textContent,
      'ورود در حال حاضر ممکن نیست. دوباره تلاش کنید.',
    )
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.username.getAttribute('aria-describedby'), 'admin-login-help')
    assert.equal(inputs.password.getAttribute('aria-describedby'), 'admin-login-help')
    assert.equal(inputs.password.value, '')
    assert.doesNotMatch(result.container.textContent, /private protocol detail|not-persisted/)

    await setInputValue(inputs.username, 'admin-2')
    assert.equal(result.container.querySelector('#admin-login-error'), null)
    assert.equal(inputs.username.getAttribute('aria-invalid'), 'false')
    assert.equal(inputs.password.getAttribute('aria-invalid'), 'true')
    assert.equal(
      inputs.password.getAttribute('aria-describedby'),
      'admin-login-help admin-password-error',
    )
  })

  await context.test('9) focuses the first invalid field', async () => {
    let result = await mountLogin()
    let inputs = loginInputs(result.container)
    await submitLogin(result.container)
    assert.equal(dom.window.document.activeElement, inputs.username)

    result = await mountLogin()
    inputs = loginInputs(result.container)
    await setInputValue(inputs.username, 'admin')
    await submitLogin(result.container)
    assert.equal(dom.window.document.activeElement, inputs.password)
  })

  await context.test('10) valid submit keeps the production request and sanitizer contract', async () => {
    const { container, loginRequests } = await mountLogin(async () =>
      jsonResponse({
        success: true,
        admin: {
          id: '9007199254740992',
          username: 'admin',
          token: 'must-not-render',
        },
      }),
    )
    const inputs = loginInputs(container)
    await setInputValue(inputs.username, '  admin  ')
    await setInputValue(inputs.password, 'valid-password')

    await submitLogin(container)

    assert.equal(loginRequests.length, 1)
    assert.equal(loginRequests[0].path, '/api/admin/auth/login')
    assert.equal(loginRequests[0].options.method, 'POST')
    assert.equal(loginRequests[0].options.credentials, 'include')
    assert.deepEqual(JSON.parse(loginRequests[0].options.body), {
      username: 'admin',
      password: 'valid-password',
    })
    assert.equal(dom.window.location.pathname, '/admin')
    assert.match(container.textContent, /مدیر: admin/)
    assert.doesNotMatch(container.textContent, /must-not-render|valid-password/)
    assert.equal(dom.window.localStorage.length, 0)
    assert.equal(dom.window.sessionStorage.length, 0)
  })
})

test('shows bootstrap and login failures without granting admin access', async (context) => {
  await context.test('bootstrap failure', async () => {
    const container = await mountApp('/admin', async () =>
      jsonResponse({ success: false, message: 'Service unavailable' }, 503),
    )

    assert.equal(dom.window.location.pathname, '/admin')
    assert.match(container.textContent, /پنل مدیریت در دسترس نیست/)
    const alert = container.querySelector('[role="alert"]')
    assert.equal(alert?.querySelector('h1')?.textContent, 'پنل مدیریت در دسترس نیست')
    assert.equal(alert?.getAttribute('aria-labelledby'), 'admin-bootstrap-error-title')
  })

  await context.test('login failure', async () => {
    const container = await mountApp('/admin/login', async (path) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: false, message: 'Authentication required' }, 401)
      }

      return jsonResponse({ success: false, message: 'SQLSTATE private backend detail' }, 401)
    })

    await setInputValue(container.querySelector('input[name="username"]'), 'admin')
    await setInputValue(container.querySelector('input[name="password"]'), 'wrong-password')
    await act(() =>
      container
        .querySelector('form')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    )
    await settle()

    assert.equal(dom.window.location.pathname, '/admin/login')
    assert.match(container.textContent, /نام کاربری یا رمز عبور نادرست است/)
    assert.doesNotMatch(container.textContent, /SQLSTATE/)
    assert.equal(container.querySelector('input[name="password"]').value, '')
    const credentialError = container.querySelector('#admin-login-error')
    assert.equal(credentialError?.getAttribute('role'), 'alert')
    assert.equal(dom.window.document.activeElement, credentialError)
    assert.equal(container.querySelector('input[name="username"]').getAttribute('aria-invalid'), 'true')
    assert.match(
      container.querySelector('input[name="password"]').getAttribute('aria-describedby'),
      /admin-login-error/,
    )
  })

  await context.test('login network failure', async () => {
    const container = await mountApp('/admin/login', async (path) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: false, message: 'Authentication required' }, 401)
      }

      throw new TypeError('private connection detail')
    })

    await setInputValue(container.querySelector('input[name="username"]'), 'admin')
    await setInputValue(container.querySelector('input[name="password"]'), 'not-logged')
    await act(() => container.querySelector('form').requestSubmit())
    await settle()

    assert.equal(dom.window.location.pathname, '/admin/login')
    assert.match(container.querySelector('[role="alert"]').textContent, /ارتباط با سرور برقرار نشد/)
    assert.doesNotMatch(container.textContent, /private connection detail|not-logged/)
    assert.equal(container.querySelector('input[name="password"]').value, '')
  })
})

test('retries a failed session bootstrap without exposing protected content', async () => {
  let currentSessionAttempts = 0
  const retrySession = createControlledResponse()
  const container = await mountApp('/admin', async (path) => {
    assert.equal(path, '/api/admin/auth/me')
    currentSessionAttempts += 1

    if (currentSessionAttempts === 1) {
      throw new TypeError('private network address')
    }

    return retrySession.response
  })

  assert.match(container.textContent, /پنل مدیریت در دسترس نیست/)
  assert.equal(container.querySelector('.admin-panel'), null)

  const retryButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'تلاش دوباره',
  )
  await act(() => retryButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.match(container.textContent, /در حال بررسی نشست مدیریت/)

  retrySession.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'admin' } }),
  )
  await settle()

  assert.equal(currentSessionAttempts, 2)
  assert.match(container.textContent, /پنل مدیریت کافه ریونا/)
})

test('coalesces login submissions and clears the password while the request is pending', async () => {
  const pendingLogin = createControlledResponse()
  let loginCalls = 0
  const container = await mountApp('/admin/login', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: false, message: 'Authentication required' }, 401)
    }

    loginCalls += 1
    return pendingLogin.response
  })
  const form = container.querySelector('form')

  await setInputValue(container.querySelector('input[name="username"]'), 'admin')
  await setInputValue(container.querySelector('input[name="password"]'), 'not-persisted')
  await act(() => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })

  assert.equal(loginCalls, 1)
  assert.equal(container.querySelector('input[name="password"]').value, '')
  assert.equal(form.getAttribute('aria-busy'), 'true')
  assert.equal(form.querySelector('button[type="submit"]').disabled, true)

  pendingLogin.resolveResponse(
    jsonResponse({ success: false, message: 'Invalid username or password' }, 401),
  )
  await settle()

  assert.match(container.textContent, /نام کاربری یا رمز عبور نادرست است/)
  assert.equal(form.getAttribute('aria-busy'), 'false')
})

test('supports semantic keyboard form submission and reports rate limiting accessibly', async () => {
  let loginCalls = 0
  const container = await mountApp('/admin/login', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: false, message: 'Authentication required' }, 401)
    }

    loginCalls += 1
    return jsonResponse({ success: false, message: 'Too many login attempts' }, 429)
  })

  await setInputValue(container.querySelector('input[name="username"]'), 'admin')
  await act(() => container.querySelector('form').requestSubmit())

  assert.equal(loginCalls, 0)
  assert.equal(container.querySelector('input[name="username"]').getAttribute('aria-invalid'), 'false')
  assert.equal(container.querySelector('input[name="password"]').getAttribute('aria-invalid'), 'true')
  assert.equal(dom.window.document.activeElement, container.querySelector('input[name="password"]'))

  await setInputValue(container.querySelector('input[name="password"]'), 'secret')
  await act(() => container.querySelector('form').requestSubmit())
  await settle()

  assert.equal(loginCalls, 1)
  const error = container.querySelector('[role="alert"]')
  assert.match(error.textContent, /تعداد تلاش‌های ورود بیش از حد مجاز است/)
})

test('keeps the authenticated shell on logout network failure and handles an expired logout session', async () => {
  let logoutAttempts = 0
  const container = await mountApp('/admin', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if (path === '/api/admin/auth/logout') {
      logoutAttempts += 1

      if (logoutAttempts === 1) {
        throw new TypeError('private network detail')
      }

      return jsonResponse({ success: false, message: 'Authentication required' }, 401)
    }

    throw new Error(`Unexpected logout test request: ${path}`)
  })
  let logoutButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'خروج',
  )

  await act(() => {
    logoutButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    logoutButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle()

  assert.equal(logoutAttempts, 1)
  assert.equal(dom.window.location.pathname, '/admin')
  assert.notEqual(container.querySelector('.admin-panel'), null)
  assert.match(container.textContent, /نشست شما همچنان فعال است/)
  logoutButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'خروج',
  )
  assert.equal(logoutButton.disabled, false)

  await act(() => logoutButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  await settle()

  assert.equal(logoutAttempts, 2)
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.admin-panel'), null)
})

test('renders the Persian RTL admin shell with category loading and empty states', async () => {
  let resolveCategories
  const pendingCategories = new Promise((resolveResponse) => {
    resolveCategories = resolveResponse
  })
  const container = await mountApp('/admin/categories', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    return pendingCategories
  })

  assert.equal(container.querySelector('.admin-panel').getAttribute('dir'), 'rtl')
  assert.match(container.textContent, /پنل مدیریت/)
  assert.match(container.textContent, /در حال دریافت دسته‌بندی‌ها/)
  assert.equal(container.querySelector('h1')?.textContent, 'دسته‌بندی‌ها')
  assert.equal(
    container.querySelector('a[aria-current="page"]')?.getAttribute('href'),
    '/admin/categories',
  )
  assert.equal(container.querySelector('.admin-inline-state')?.getAttribute('role'), 'status')
  assert.equal(container.querySelector('#create-category-name').disabled, true)

  resolveCategories(jsonResponse({ success: true, categories: [] }))
  await settle()

  assert.match(container.textContent, /هنوز دسته‌بندی‌ای ایجاد نشده است/)
  assert.equal(container.querySelector('.admin-inline-state--empty')?.getAttribute('role'), 'status')
  assert.equal(container.querySelector('#create-category-name').disabled, false)
})

test('redirects to login when the category API reports an expired session', async () => {
  const container = await mountApp('/admin/categories', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    return jsonResponse({ success: false, message: 'Authentication required' }, 401)
  })

  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.match(container.textContent, /ورود به پنل مدیریت/)
})

test('manages category create, edit, visibility, order, and confirmed deletion through the UI', async () => {
  const requests = []
  const fixedDate = '2026-08-04T12:00:00.000Z'
  const categories = new Map([
    [
      '2',
      {
        id: '2',
        name: 'دسر',
        imagePath: '/uploads/categories/dessert.webp',
        sortOrder: 2,
        isVisible: true,
        createdAt: fixedDate,
        updatedAt: fixedDate,
      },
    ],
    [
      '1',
      {
        id: '1',
        name: 'قهوه',
        imagePath: null,
        sortOrder: 0,
        isVisible: true,
        createdAt: fixedDate,
        updatedAt: fixedDate,
      },
    ],
  ])
  const container = await mountApp('/admin/categories', async (path, options) => {
    requests.push({ path, options })

    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if (path === '/api/admin/categories' && (options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, categories: [...categories.values()] })
    }

    if (path === '/api/admin/categories' && options.method === 'POST') {
      const body = JSON.parse(options.body)
      const created = { id: '3', ...body, createdAt: fixedDate, updatedAt: fixedDate }
      categories.set(created.id, created)
      return jsonResponse({ success: true, category: created }, 201)
    }

    const categoryId = path.split('/').at(-1)

    if (options.method === 'PATCH') {
      const updated = { ...categories.get(categoryId), ...JSON.parse(options.body), updatedAt: fixedDate }
      categories.set(categoryId, updated)
      return jsonResponse({ success: true, category: updated })
    }

    if (options.method === 'DELETE') {
      categories.delete(categoryId)
      return jsonResponse({ success: true, message: 'Category deleted' })
    }

    throw new Error(`Unexpected request in category UI test: ${path}`)
  })

  assert.deepEqual(
    [...container.querySelectorAll('.category-item h3')].map((heading) => heading.textContent),
    ['قهوه', 'دسر'],
  )
  const dessertImage = container.querySelector('[data-category-id="2"] img')
  assert.equal(dessertImage?.getAttribute('src'), '/uploads/categories/dessert.webp')
  assert.equal(container.querySelector('[data-category-id="1"] img'), null)

  await act(() => dessertImage.dispatchEvent(new dom.window.Event('error')))
  assert.equal(container.querySelector('[data-category-id="2"] img'), null)
  assert.equal(
    container.querySelector('[data-category-id="2"] .category-item__media')?.textContent.trim(),
    'د',
  )

  await setInputValue(container.querySelector('#create-category-name'), ' نوشیدنی سرد ')
  await setInputValue(container.querySelector('#create-category-order'), '1')
  await act(() =>
    container
      .querySelector('#create-category-name')
      .closest('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  const createRequest = requests.find(
    (request) => request.path === '/api/admin/categories' && request.options.method === 'POST',
  )
  assert.deepEqual(JSON.parse(createRequest.options.body), {
    name: 'نوشیدنی سرد',
    sortOrder: 1,
    isVisible: true,
  })
  assert.deepEqual(
    [...container.querySelectorAll('.category-item h3')].map((heading) => heading.textContent),
    ['قهوه', 'نوشیدنی سرد', 'دسر'],
  )

  const createdItem = container.querySelector('[data-category-id="3"]')
  const editButton = [...createdItem.querySelectorAll('button')].find(
    (button) => button.textContent === 'ویرایش',
  )
  assert.equal(editButton.getAttribute('aria-label'), 'ویرایش دسته‌بندی نوشیدنی سرد')
  assert.equal(
    [...createdItem.querySelectorAll('button')].find((button) => button.textContent === 'حذف')
      ?.getAttribute('aria-label'),
    'حذف دسته‌بندی نوشیدنی سرد',
  )
  await act(() => editButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  await setInputValue(container.querySelector('#edit-category-3-name'), 'نوشیدنی خنک')
  await setInputValue(container.querySelector('#edit-category-3-order'), '4')
  await act(() =>
    container
      .querySelector('#edit-category-3-name')
      .closest('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  assert.match(container.querySelector('[data-category-id="3"]').textContent, /نوشیدنی خنک/)
  assert.match(container.querySelector('[data-category-id="3"]').textContent, /ترتیب نمایش: 4/)

  const visibilityButton = [...container.querySelector('[data-category-id="3"]').querySelectorAll('button')].find(
    (button) => button.textContent === 'غیرفعال‌کردن',
  )
  await act(() =>
    visibilityButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  )
  await settle()
  assert.match(container.querySelector('[data-category-id="3"]').textContent, /غیرفعال/)

  const originalConfirm = dom.window.confirm
  let confirmationMessage = ''
  dom.window.confirm = (message) => {
    confirmationMessage = message
    return true
  }

  try {
    const deleteButton = [...container.querySelector('[data-category-id="3"]').querySelectorAll('button')].find(
      (button) => button.textContent === 'حذف',
    )
    await act(() =>
      deleteButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
    )
    await settle()
  } finally {
    dom.window.confirm = originalConfirm
  }

  assert.match(confirmationMessage, /نوشیدنی خنک/)
  assert.equal(container.querySelector('[data-category-id="3"]'), null)
  assert.equal(requests.some((request) => request.options.method === 'DELETE'), true)
})

test('shows category validation and safe API errors without duplicate submission', async () => {
  let createCalls = 0
  let resolveCreate
  const createResponse = new Promise((resolveResponse) => {
    resolveCreate = resolveResponse
  })
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if ((options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, categories: [] })
    }

    createCalls += 1
    return createResponse
  })
  const createForm = container.querySelector('#create-category-name').closest('form')

  await setInputValue(container.querySelector('#create-category-name'), '   ')
  await act(() =>
    createForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  assert.match(container.textContent, /نام دسته‌بندی را وارد کنید/)
  assert.equal(dom.window.document.activeElement, container.querySelector('#create-category-name'))
  assert.equal(container.querySelector('#create-category-name').getAttribute('aria-invalid'), 'true')
  assert.match(
    container.querySelector('#create-category-name').getAttribute('aria-describedby'),
    /create-category-name-error/,
  )
  assert.equal(createCalls, 0)

  await setInputValue(container.querySelector('#create-category-name'), 'چای')
  await act(() => {
    createForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    createForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
  assert.equal(createCalls, 1)
  assert.equal(createForm.querySelector('button[type="submit"]').disabled, true)

  resolveCreate(
    jsonResponse({ success: false, message: 'A category with this name already exists' }, 409),
  )
  await settle()
  assert.match(container.textContent, /دسته‌بندی دیگری با این نام وجود دارد/)
})

test('recovers from a safe category load error and ignores the older list after Retry', async () => {
  const staleCategoryList = createControlledResponse()
  const internalBackendDetail = 'SQL connection detail must stay private'
  let currentAdminRequests = 0
  let categoryListRequests = 0
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      currentAdminRequests += 1
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if (path === '/api/admin/categories' && (options.method ?? 'GET') === 'GET') {
      categoryListRequests += 1

      if (categoryListRequests === 1) {
        return staleCategoryList.response
      }

      if (categoryListRequests === 2) {
        return jsonResponse({ success: false, message: internalBackendDetail }, 500)
      }

      return jsonResponse({
        success: true,
        categories: [{ id: '2', name: 'fresh-category', sortOrder: 0, isVisible: true }],
      })
    }

    throw new Error(`Unexpected category Retry request: ${path}`)
  })

  assert.equal(categoryListRequests, 1)
  assert.notEqual(container.querySelector('.category-management [role="status"]'), null)

  await act(() => {
    dom.window.history.pushState({}, '', '/admin')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()
  await act(() => {
    dom.window.history.pushState({}, '', '/admin/categories')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()

  const loadError = container.querySelector('.category-management [role="alert"]')
  assert.equal(categoryListRequests, 2)
  assert.notEqual(loadError, null)
  assert.match(loadError.textContent, /دریافت دسته‌بندی‌ها ممکن نشد/)
  assert.equal(loadError.textContent.includes(internalBackendDetail), false)
  const retryButton = loadError.querySelector('button')
  assert.notEqual(retryButton, null)
  assert.equal(retryButton.textContent.trim(), 'تلاش دوباره')
  assert.equal(retryButton.disabled, false)

  await act(() => retryButton.click())
  await settle()

  assert.equal(categoryListRequests, 3)
  assert.equal(container.querySelector('.category-management [role="alert"]'), null)
  assert.match(container.textContent, /fresh-category/)
  assert.equal(container.querySelector('#create-category-name').disabled, false)

  staleCategoryList.resolveResponse(
    jsonResponse({
      success: true,
      categories: [{ id: '1', name: 'stale-category', sortOrder: 0, isVisible: true }],
    }),
  )
  await settle()

  assert.match(container.textContent, /fresh-category/)
  assert.doesNotMatch(container.textContent, /stale-category/)
  assert.equal(currentAdminRequests, 1)
  assert.equal(categoryListRequests, 3)
})

test('runs the production category validator at numeric and name boundaries with coherent ARIA', async () => {
  const createBodies = []
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if (path === '/api/admin/categories' && (options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, categories: [] })
    }

    if (path === '/api/admin/categories' && options.method === 'POST') {
      const body = JSON.parse(options.body)
      createBodies.push(body)
      return jsonResponse({
        success: true,
        category: { id: String(createBodies.length), ...body },
      })
    }

    throw new Error(`Unexpected category validation request: ${path}`)
  })
  const nameInput = container.querySelector('#create-category-name')
  const orderInput = container.querySelector('#create-category-order')
  const createForm = nameInput.closest('form')
  assert.equal(nameInput.hasAttribute('maxlength'), false)

  async function submitCreateForm() {
    await act(() =>
      createForm.dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      ),
    )
    await settle()
  }

  async function assertInvalidOrder(value, expectedMessage) {
    await setInputValue(orderInput, value)
    await submitCreateForm()

    assert.equal(createBodies.length, 0)
    assert.equal(orderInput.getAttribute('aria-invalid'), 'true')
    assert.match(orderInput.getAttribute('aria-describedby'), /create-category-order-help/)
    assert.match(orderInput.getAttribute('aria-describedby'), /create-category-order-error/)
    const orderError = container.querySelector('#create-category-order-error')
    assert.equal(orderError?.getAttribute('role'), 'alert')
    assert.equal(orderError?.textContent, expectedMessage)
    assert.equal(nameInput.getAttribute('aria-invalid'), 'false')
    assert.equal(dom.window.document.activeElement, orderInput)

    await setInputValue(orderInput, '0')
    assert.equal(orderInput.getAttribute('aria-invalid'), 'false')
    assert.doesNotMatch(orderInput.getAttribute('aria-describedby'), /create-category-order-error/)
    assert.equal(container.querySelector('#create-category-order-error'), null)
  }

  await setInputValue(nameInput, 'valid-category')
  await assertInvalidOrder('-1', 'ترتیب نمایش باید یک عدد صحیح نامنفی باشد.')
  await assertInvalidOrder('1.5', 'ترتیب نمایش باید یک عدد صحیح نامنفی باشد.')
  await assertInvalidOrder('4294967296', 'ترتیب نمایش خارج از محدودهٔ مجاز است.')

  await setInputValue(orderInput, '4294967295')
  await submitCreateForm()
  assert.deepEqual(createBodies, [
    { name: 'valid-category', sortOrder: 4_294_967_295, isVisible: true },
  ])

  const maximumLengthName = '😀'.repeat(100)
  await setInputValue(nameInput, maximumLengthName)
  assert.equal(Array.from(nameInput.value).length, 100)
  assert.equal(nameInput.value.length, 200)
  await submitCreateForm()
  assert.equal(createBodies.length, 2)
  assert.deepEqual(createBodies[1], {
    name: maximumLengthName,
    sortOrder: 0,
    isVisible: true,
  })

  const overMaximumLengthName = '😀'.repeat(101)
  await setInputValue(nameInput, overMaximumLengthName)
  assert.equal(Array.from(nameInput.value).length, 101)
  assert.equal(nameInput.value.length, 202)
  await submitCreateForm()

  assert.equal(createBodies.length, 2)
  assert.equal(nameInput.getAttribute('aria-invalid'), 'true')
  assert.match(nameInput.getAttribute('aria-describedby'), /create-category-name-help/)
  assert.match(nameInput.getAttribute('aria-describedby'), /create-category-name-error/)
  const nameError = container.querySelector('#create-category-name-error')
  assert.equal(nameError?.getAttribute('role'), 'alert')
  assert.equal(nameError?.textContent, 'نام دسته‌بندی نباید بیشتر از 100 نویسه باشد.')
  assert.equal(orderInput.getAttribute('aria-invalid'), 'false')
  assert.equal(dom.window.document.activeElement, nameInput)
})

test('coalesces rapid visibility actions and releases the lock after success', async () => {
  const firstUpdate = createControlledResponse()
  const mutationRequests = []
  const category = {
    id: '1',
    name: 'قهوه',
    sortOrder: 0,
    isVisible: true,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
  }
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if ((options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, categories: [category] })
    }

    mutationRequests.push({ path, method: options.method, body: JSON.parse(options.body) })

    if (mutationRequests.length === 1) {
      return firstUpdate.response
    }

    return jsonResponse({
      success: true,
      category: { ...category, isVisible: true },
    })
  })
  const visibilityButton = [...container.querySelectorAll('[data-category-id="1"] button')].find(
    (button) => button.textContent === 'غیرفعال‌کردن',
  )

  await act(() => {
    visibilityButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    visibilityButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(mutationRequests, [
    { path: '/api/admin/categories/1', method: 'PATCH', body: { isVisible: false } },
  ])

  firstUpdate.resolveResponse(
    jsonResponse({ success: true, category: { ...category, isVisible: false } }),
  )
  await settle()

  const nextVisibilityButton = [
    ...container.querySelectorAll('[data-category-id="1"] button'),
  ].find((button) => button.textContent === 'فعال‌کردن')
  await act(() =>
    nextVisibilityButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  )
  await settle()

  assert.deepEqual(mutationRequests[1], {
    path: '/api/admin/categories/1',
    method: 'PATCH',
    body: { isVisible: true },
  })
})

test('coalesces rapid confirmed deletes and releases the lock after an API rejection', async () => {
  const firstDelete = createControlledResponse()
  const deleteRequests = []
  const category = {
    id: '1',
    name: 'قهوه',
    sortOrder: 0,
    isVisible: true,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
  }
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if ((options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, categories: [category] })
    }

    deleteRequests.push({ path, method: options.method })

    if (deleteRequests.length === 1) {
      return firstDelete.response
    }

    return jsonResponse({ success: true, message: 'Category deleted' })
  })
  const originalConfirm = dom.window.confirm
  let confirmationCount = 0
  dom.window.confirm = () => {
    confirmationCount += 1
    return true
  }

  try {
    const deleteButton = [...container.querySelectorAll('[data-category-id="1"] button')].find(
      (button) => button.textContent === 'حذف',
    )
    await act(() => {
      deleteButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      deleteButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    assert.deepEqual(deleteRequests, [
      { path: '/api/admin/categories/1', method: 'DELETE' },
    ])
    assert.equal(confirmationCount, 1)

    firstDelete.resolveResponse(
      jsonResponse(
        { success: false, message: 'A category with menu items cannot be deleted' },
        409,
      ),
    )
    await settle()
    assert.notEqual(container.querySelector('[data-category-id="1"]'), null)

    const retryDeleteButton = [
      ...container.querySelectorAll('[data-category-id="1"] button'),
    ].find((button) => button.textContent === 'حذف')
    await act(() =>
      retryDeleteButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
    )
    await settle()

    assert.equal(deleteRequests.length, 2)
    assert.equal(confirmationCount, 2)
    assert.equal(container.querySelector('[data-category-id="1"]'), null)
  } finally {
    dom.window.confirm = originalConfirm
  }
})

test('blocks row actions while a create submission is pending', async () => {
  const pendingCreate = createControlledResponse()
  const mutationRequests = []
  const category = {
    id: '1',
    name: 'قهوه',
    sortOrder: 0,
    isVisible: true,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
  }
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if ((options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, categories: [category] })
    }

    mutationRequests.push({ path, method: options.method })

    if (options.method === 'POST') {
      return pendingCreate.response
    }

    return jsonResponse({
      success: true,
      category: { ...category, isVisible: false },
    })
  })
  await setInputValue(container.querySelector('#create-category-name'), 'چای')
  const createForm = container.querySelector('#create-category-name').closest('form')
  const visibilityButton = [...container.querySelectorAll('[data-category-id="1"] button')].find(
    (button) => button.textContent === 'غیرفعال‌کردن',
  )

  await act(() => {
    createForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    visibilityButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(mutationRequests, [{ path: '/api/admin/categories', method: 'POST' }])

  pendingCreate.resolveResponse(
    jsonResponse(
      {
        success: true,
        category: { ...category, id: '2', name: 'چای' },
      },
      201,
    ),
  )
  await settle()

  const unlockedVisibilityButton = [
    ...container.querySelectorAll('[data-category-id="1"] button'),
  ].find((button) => button.textContent === 'غیرفعال‌کردن')
  await act(() =>
    unlockedVisibilityButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  )
  await settle()

  assert.deepEqual(mutationRequests[1], {
    path: '/api/admin/categories/1',
    method: 'PATCH',
  })
})

test('blocks form submission while a row action is pending and unlocks after failure', async () => {
  const pendingUpdate = createControlledResponse()
  const mutationRequests = []
  const category = {
    id: '1',
    name: 'قهوه',
    sortOrder: 0,
    isVisible: true,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
  }
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if ((options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, categories: [category] })
    }

    mutationRequests.push({ path, method: options.method })

    if (options.method === 'PATCH') {
      return pendingUpdate.response
    }

    return jsonResponse({
      success: true,
      category: { ...category, id: '2', name: 'چای' },
    }, 201)
  })
  await setInputValue(container.querySelector('#create-category-name'), 'چای')
  const createForm = container.querySelector('#create-category-name').closest('form')
  const visibilityButton = [...container.querySelectorAll('[data-category-id="1"] button')].find(
    (button) => button.textContent === 'غیرفعال‌کردن',
  )

  await act(() => {
    visibilityButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    createForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })

  assert.deepEqual(mutationRequests, [
    { path: '/api/admin/categories/1', method: 'PATCH' },
  ])

  pendingUpdate.resolveResponse(
    jsonResponse({ success: false, message: 'The category request could not be completed.' }, 500),
  )
  await settle()

  await act(() =>
    createForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  assert.deepEqual(mutationRequests[1], {
    path: '/api/admin/categories',
    method: 'POST',
  })
})

test('ignores a non-cooperative StrictMode bootstrap after a newer login succeeds', async () => {
  const staleBootstrap = createControlledResponse()
  let currentAdminRequests = 0
  const container = await mountApp(
    '/admin/login',
    async (path) => {
      if (path === '/api/admin/auth/me') {
        currentAdminRequests += 1
        return currentAdminRequests === 1
          ? staleBootstrap.response
          : jsonResponse({ success: false, message: 'Authentication required' }, 401)
      }

      if (path === '/api/admin/auth/login') {
        return jsonResponse({ success: true, admin: { id: '2', username: 'new-admin' } })
      }

      throw new Error(`Unexpected stale-bootstrap login request: ${path}`)
    },
    { strict: true },
  )

  await setInputValue(container.querySelector('input[name="username"]'), 'new-admin')
  await setInputValue(container.querySelector('input[name="password"]'), 'valid-password')
  await act(() =>
    container
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.querySelector('.admin-panel__identity').textContent, /new-admin/)

  staleBootstrap.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'old-admin' } }),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.querySelector('.admin-panel__identity').textContent, /new-admin/)
  assert.doesNotMatch(container.textContent, /old-admin/)
})

test('ignores a non-cooperative StrictMode bootstrap after logout succeeds', async () => {
  const staleBootstrap = createControlledResponse()
  let currentAdminRequests = 0
  const container = await mountApp(
    '/admin',
    async (path) => {
      if (path === '/api/admin/auth/me') {
        currentAdminRequests += 1
        return currentAdminRequests === 1
          ? staleBootstrap.response
          : jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }

      if (path === '/api/admin/auth/logout') {
        return jsonResponse({ success: true, message: 'Logged out' })
      }

      throw new Error(`Unexpected stale-bootstrap logout request: ${path}`)
    },
    { strict: true },
  )

  await act(() => container.querySelector('.admin-panel__identity button').click())
  await settle()
  assert.equal(dom.window.location.pathname, '/admin/login')

  staleBootstrap.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'stale-admin' } }),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.admin-panel'), null)
  assert.doesNotMatch(container.textContent, /stale-admin/)
})

test('ignores a non-cooperative bootstrap after navigation to the public route', async () => {
  const staleBootstrap = createControlledResponse()
  let currentAdminRequests = 0
  const container = await mountApp(
    '/admin',
    async (path) => {
      assert.equal(path, '/api/admin/auth/me')
      currentAdminRequests += 1
      return staleBootstrap.response
    },
    { settleAfterRender: false },
  )
  await settle()
  assert.equal(currentAdminRequests, 1)

  await act(() => {
    dom.window.history.pushState({}, '', '/')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()
  assert.match(container.textContent, /Get started/)

  staleBootstrap.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'stale-admin' } }),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/')
  assert.match(container.textContent, /Get started/)
  assert.equal(container.querySelector('.admin-panel'), null)
})

test('only applies the latest retry when non-cooperative responses resolve out of order', async () => {
  const firstRetry = createControlledResponse()
  let currentAdminRequests = 0
  const container = await mountApp('/admin', async (path) => {
    assert.equal(path, '/api/admin/auth/me')
    currentAdminRequests += 1

    if (currentAdminRequests === 1 || currentAdminRequests === 3) {
      return jsonResponse({ success: false, message: 'Unavailable' }, 500)
    }

    if (currentAdminRequests === 2) {
      return firstRetry.response
    }

    return jsonResponse({ success: true, admin: { id: '2', username: 'latest-admin' } })
  })

  await act(() => container.querySelector('.admin-primary-button').click())
  await settle()
  assert.equal(currentAdminRequests, 2)

  await act(() => {
    dom.window.history.pushState({}, '', '/')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await act(() => {
    dom.window.history.pushState({}, '', '/admin')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()
  assert.equal(currentAdminRequests, 3)

  await act(() => container.querySelector('.admin-primary-button').click())
  await settle()
  assert.equal(currentAdminRequests, 4)
  assert.match(container.querySelector('.admin-panel__identity').textContent, /latest-admin/)

  firstRetry.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'stale-retry-admin' } }),
  )
  await settle()

  assert.match(container.querySelector('.admin-panel__identity').textContent, /latest-admin/)
  assert.doesNotMatch(container.textContent, /stale-retry-admin/)
})

test('only applies the latest login and ignores the first response after its form unmounts', async () => {
  const firstLogin = createControlledResponse()
  let currentAdminRequests = 0
  let loginRequests = 0
  const container = await mountApp('/admin/login', async (path) => {
    if (path === '/api/admin/auth/me') {
      currentAdminRequests += 1
      return jsonResponse({ success: false, message: 'Authentication required' }, 401)
    }

    if (path === '/api/admin/auth/login') {
      loginRequests += 1
      return loginRequests === 1
        ? firstLogin.response
        : jsonResponse({ success: true, admin: { id: '2', username: 'latest-admin' } })
    }

    throw new Error(`Unexpected two-login request: ${path}`)
  })

  await setInputValue(container.querySelector('input[name="username"]'), 'first-admin')
  await setInputValue(container.querySelector('input[name="password"]'), 'first-password')
  await act(() =>
    container
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  await act(() => {
    dom.window.history.pushState({}, '', '/')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await act(() => {
    dom.window.history.pushState({}, '', '/admin/login')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()

  await setInputValue(container.querySelector('input[name="username"]'), 'latest-admin')
  await setInputValue(container.querySelector('input[name="password"]'), 'latest-password')
  await act(() =>
    container
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  assert.equal(loginRequests, 2)
  assert.equal(currentAdminRequests, 2)
  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.querySelector('.admin-panel__identity').textContent, /latest-admin/)

  firstLogin.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'first-admin' } }),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.querySelector('.admin-panel__identity').textContent, /latest-admin/)
  assert.doesNotMatch(container.textContent, /first-admin/)
})

test('ignores a delayed category success after logout', async () => {
  const staleCategoryUpdate = createControlledResponse()
  let categoryUpdateRequests = 0
  const container = await mountApp('/admin/categories', async (path, options) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if (path === '/api/admin/categories' && (options.method ?? 'GET') === 'GET') {
      return jsonResponse({
        success: true,
        categories: [{ id: '1', name: 'قهوه', sortOrder: 0, isVisible: true }],
      })
    }

    if (path === '/api/admin/categories/1' && options.method === 'PATCH') {
      categoryUpdateRequests += 1
      return staleCategoryUpdate.response
    }

    if (path === '/api/admin/auth/logout') {
      return jsonResponse({ success: true, message: 'Logged out' })
    }

    throw new Error(`Unexpected stale-category logout request: ${path}`)
  })

  const rowButtons = container.querySelectorAll('.category-item__actions button')
  await act(() => rowButtons[1].click())
  await settle()
  assert.equal(categoryUpdateRequests, 1)

  await act(() => container.querySelector('.admin-panel__identity button').click())
  await settle()
  assert.equal(dom.window.location.pathname, '/admin/login')

  staleCategoryUpdate.resolveResponse(
    jsonResponse({
      success: true,
      category: { id: '1', name: 'stale-category', sortOrder: 0, isVisible: false },
    }),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.category-management'), null)
  assert.doesNotMatch(container.textContent, /stale-category/)
})

test('keeps a category 401 authoritative over an older non-cooperative auth response', async () => {
  const staleBootstrap = createControlledResponse()
  const expiredCategoryUpdate = createControlledResponse()
  let currentAdminRequests = 0
  const container = await mountApp(
    '/admin/categories',
    async (path, options) => {
      if (path === '/api/admin/auth/me') {
        currentAdminRequests += 1
        return currentAdminRequests === 1
          ? staleBootstrap.response
          : jsonResponse({ success: true, admin: { id: '2', username: 'current-admin' } })
      }

      if (path === '/api/admin/categories' && (options.method ?? 'GET') === 'GET') {
        return jsonResponse({
          success: true,
          categories: [{ id: '1', name: 'قهوه', sortOrder: 0, isVisible: true }],
        })
      }

      if (path === '/api/admin/categories/1' && options.method === 'PATCH') {
        return expiredCategoryUpdate.response
      }

      throw new Error(`Unexpected expired-category request: ${path}`)
    },
    { strict: true },
  )

  const rowButtons = container.querySelectorAll('.category-item__actions button')
  await act(() => rowButtons[1].click())
  await settle()

  expiredCategoryUpdate.resolveResponse(
    jsonResponse({ success: false, message: 'Authentication required' }, 401),
  )
  await settle()
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.category-management'), null)

  staleBootstrap.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'stale-admin' } }),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.admin-panel'), null)
  assert.doesNotMatch(container.textContent, /stale-admin/)
})

test('keeps Back and Forward fail-closed while a non-cooperative bootstrap is pending', async () => {
  const staleBootstrap = createControlledResponse()
  let currentAdminRequests = 0
  const container = await mountApp('/', async (path) => {
    assert.equal(path, '/api/admin/auth/me')
    currentAdminRequests += 1
    return currentAdminRequests === 1
      ? staleBootstrap.response
      : jsonResponse({ success: false, message: 'Authentication required' }, 401)
  })

  await act(() => {
    dom.window.history.pushState({}, '', '/admin')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()
  assert.equal(currentAdminRequests, 1)
  assert.equal(container.querySelector('.admin-panel'), null)

  await travelHistory('back')
  assert.equal(dom.window.location.pathname, '/')
  assert.match(container.textContent, /Get started/)

  staleBootstrap.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'stale-admin' } }),
  )
  await settle()
  assert.match(container.textContent, /Get started/)
  assert.doesNotMatch(container.textContent, /stale-admin/)

  await travelHistory('forward')
  assert.equal(currentAdminRequests, 2)
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.admin-panel'), null)
})

test('keeps one valid bootstrap across navigation between protected Admin routes', async () => {
  const pendingBootstrap = createControlledResponse()
  let currentAdminRequests = 0
  let categoryRequests = 0
  const container = await mountApp(
    '/admin',
    async (path) => {
      if (path === '/api/admin/auth/me') {
        currentAdminRequests += 1
        return pendingBootstrap.response
      }

      if (path === '/api/admin/categories') {
        categoryRequests += 1
        return jsonResponse({ success: true, categories: [] })
      }

      throw new Error(`Unexpected protected-route bootstrap request: ${path}`)
    },
    { settleAfterRender: false },
  )
  await settle()

  await act(() => {
    dom.window.history.pushState({}, '', '/admin/categories')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()

  assert.equal(currentAdminRequests, 1)
  assert.notEqual(container.querySelector('.admin-spinner'), null)
  assert.equal(container.querySelector('.admin-panel'), null)

  pendingBootstrap.resolveResponse(
    jsonResponse({ success: true, admin: { id: '1', username: 'admin' } }),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin/categories')
  assert.equal(currentAdminRequests, 1)
  assert.equal(categoryRequests, 1)
  assert.notEqual(container.querySelector('.category-management'), null)
  assert.equal(container.querySelector('.admin-spinner'), null)
})

test('canonicalizes every known trailing slash exactly once without losing search or hash', async (context) => {
  const cases = [
    {
      canonicalPath: '/admin',
      source: '/admin/?section=summary#status',
      search: '?section=summary',
      hash: '#status',
    },
    {
      canonicalPath: '/admin/login',
      source: '/admin/login/?return=panel#credentials',
      search: '?return=panel',
      hash: '#credentials',
    },
    {
      canonicalPath: '/admin/categories',
      source: '/admin/categories/?sort=manual#category-list',
      search: '?sort=manual',
      hash: '#category-list',
    },
    {
      canonicalPath: '/admin/products',
      source: '/admin/products/?sort=manual#product-list',
      search: '?sort=manual',
      hash: '#product-list',
    },
  ]

  for (const routeCase of cases) {
    await context.test(routeCase.source, async () => {
      const pendingBootstrap = createControlledResponse()
      const canonicalLocation = `${routeCase.canonicalPath}${routeCase.search}${routeCase.hash}`
      const replaceStateCalls = []
      const originalReplaceState = dom.window.history.replaceState
      let currentAdminRequests = 0
      let container

      dom.window.history.replaceState = function replaceState(state, unused, url) {
        replaceStateCalls.push(String(url))
        return originalReplaceState.call(this, state, unused, url)
      }

      try {
        const historyLengthBefore = dom.window.history.length
        container = await mountApp(routeCase.source, async (path) => {
          assert.equal(path, '/api/admin/auth/me')
          currentAdminRequests += 1
          return pendingBootstrap.response
        })

        assert.equal(dom.window.location.pathname, routeCase.canonicalPath)
        assert.equal(dom.window.location.search, routeCase.search)
        assert.equal(dom.window.location.hash, routeCase.hash)
        assert.equal(dom.window.history.length, historyLengthBefore)
        assert.equal(currentAdminRequests, 1)
        assert.equal(replaceStateCalls.length, 2)
        assert.equal(
          replaceStateCalls.filter((location) => location === canonicalLocation).length,
          1,
        )
        assert.notEqual(container.querySelector('.admin-spinner'), null)
        assert.equal(container.querySelector('.admin-panel'), null)
        assert.equal(container.querySelector('.category-management'), null)

        await settle()
        assert.equal(currentAdminRequests, 1)
        assert.equal(replaceStateCalls.length, 2)
        assert.equal(
          replaceStateCalls.filter((location) => location === canonicalLocation).length,
          1,
        )

        pendingBootstrap.resolveResponse(
          jsonResponse({ success: false, message: 'Authentication required' }, 401),
        )
        await settle()
        assert.equal(currentAdminRequests, 1)
      } finally {
        dom.window.history.replaceState = originalReplaceState
        pendingBootstrap.resolveResponse(
          jsonResponse({ success: false, message: 'Authentication required' }, 401),
        )
        await settle()
      }
    })
  }
})

test('renders stable Admin 404 pages without auth requests or protected content', async (context) => {
  for (const pathname of [
    '/admin/unknown',
    '/admin/login-extra',
    '/admin/categories-extra',
    '/admin/products-extra',
  ]) {
    await context.test(pathname, async () => {
      let requestCount = 0
      const container = await mountApp(pathname, async () => {
        requestCount += 1
        throw new Error('An unknown Admin route must not call the API')
      })

      assert.equal(requestCount, 0)
      assert.equal(dom.window.location.pathname, pathname)
      assert.notEqual(container.querySelector('[data-route-status="404"]'), null)
      assert.equal(container.querySelector('h1')?.textContent, 'صفحهٔ مدیریت پیدا نشد')
      assert.equal(
        container.querySelector('a[href="/admin"]')?.textContent.trim(),
        'بازگشت به پنل مدیریت',
      )
      assert.equal(container.querySelector('.admin-spinner'), null)
      assert.equal(container.querySelector('.admin-panel'), null)
      assert.equal(container.querySelector('.category-management'), null)
      assert.equal(container.querySelector('form'), null)
    })
  }

  await context.test('/administrator remains public', async () => {
    let requestCount = 0
    const container = await mountApp('/administrator', async () => {
      requestCount += 1
      throw new Error('A public route must not call the Admin API')
    })

    assert.equal(requestCount, 0)
    assert.match(container.textContent, /Get started/)
    assert.equal(container.querySelector('[data-route-status="404"]'), null)
  })
})

test('updates the UI across Back and Forward between Admin 404 and a valid route', async () => {
  let currentAdminRequests = 0
  const container = await mountApp('/admin/unknown', async (path) => {
    assert.equal(path, '/api/admin/auth/me')
    currentAdminRequests += 1
    return jsonResponse({ success: false, message: 'Authentication required' }, 401)
  })
  assert.notEqual(container.querySelector('[data-route-status="404"]'), null)

  await act(() => {
    dom.window.history.pushState({}, '', '/admin')
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()
  assert.equal(currentAdminRequests, 1)
  assert.equal(dom.window.location.pathname, '/admin/login')

  await travelHistory('back')
  assert.equal(dom.window.location.pathname, '/admin/unknown')
  assert.notEqual(container.querySelector('[data-route-status="404"]'), null)

  await travelHistory('forward')
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(currentAdminRequests, 2)
  assert.notEqual(container.querySelector('form'), null)
})

test('treats a malformed successful admin response as an error without protected content', async () => {
  const container = await mountApp('/admin', async (path) => {
    assert.equal(path, '/api/admin/auth/me')
    return jsonResponse({
      success: true,
      admin: { id: '01', username: 'admin', password_hash: 'must-not-render' },
    })
  })

  assert.equal(dom.window.location.pathname, '/admin')
  assert.equal(container.querySelector('.admin-panel'), null)
  assert.equal(container.querySelector('.category-management'), null)
  assert.match(container.textContent, /پنل مدیریت در دسترس نیست/)
  assert.doesNotMatch(container.textContent, /must-not-render/)
})

test('rejects a malformed successful login without authenticating or exposing response fields', async () => {
  const container = await mountApp('/admin/login', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: false, message: 'Authentication required' }, 401)
    }

    if (path === '/api/admin/auth/login') {
      return jsonResponse({
        success: true,
        admin: { id: '01', username: 'admin', token: 'must-not-render' },
      })
    }

    throw new Error(`Unexpected malformed-login request: ${path}`)
  })

  await setInputValue(container.querySelector('input[name="username"]'), 'admin')
  await setInputValue(container.querySelector('input[name="password"]'), 'valid-password')
  await act(() =>
    container
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  )
  await settle()

  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.equal(container.querySelector('.admin-panel'), null)
  assert.equal(container.querySelector('.category-management'), null)
  assert.notEqual(container.querySelector('[role="alert"]'), null)
  assert.doesNotMatch(container.textContent, /must-not-render/)
})
