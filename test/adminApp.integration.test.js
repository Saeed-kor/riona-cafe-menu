import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import { createServer as createViteServer } from 'vite'

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
const [{ default: App }, { act, createElement }, { createRoot }] = await Promise.all([
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

async function mountApp(pathname, handler, { settleAfterRender = true } = {}) {
  await unmountApp()
  dom.window.history.replaceState({}, '', pathname)
  fetchHandler = handler
  const container = dom.window.document.getElementById('root')
  activeRoot = createRoot(container)

  await act(() => activeRoot.render(createElement(App)))

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

test('shows loading while current-admin bootstrap is pending', async () => {
  let resolveRequest
  const pendingResponse = new Promise((resolveResponse) => {
    resolveRequest = resolveResponse
  })
  const container = await mountApp('/admin', () => pendingResponse, {
    settleAfterRender: false,
  })

  assert.match(container.textContent, /Checking administrator session/)

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
  assert.match(container.textContent, /Admin login/)
})

test('redirects a bootstrapped administrator away from login', async () => {
  const container = await mountApp('/admin/login', async () =>
    jsonResponse({ success: true, admin: { id: '1', username: 'admin' } }),
  )

  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.textContent, /Signed in as admin/)
})

test('submits username login and logs the administrator out', async () => {
  const requests = []
  const container = await mountApp('/admin/login', async (path, options) => {
    requests.push({ path, options })

    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: false, message: 'Authentication required' }, 401)
    }

    if (path === '/api/admin/auth/login') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    if (path === '/api/admin/auth/logout') {
      return jsonResponse({ success: true, message: 'Logged out' })
    }

    throw new Error(`Unexpected request in App integration test: ${path}`)
  })
  const usernameInput = container.querySelector('input[name="username"]')
  const passwordInput = container.querySelector('input[name="password"]')

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
  assert.match(container.textContent, /Signed in as admin/)

  const logoutButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Logout',
  )
  await act(() =>
    logoutButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  )
  await settle()

  assert.equal(requests.at(-1).path, '/api/admin/auth/logout')
  assert.equal(dom.window.location.pathname, '/admin/login')
  assert.match(container.textContent, /Admin login/)
})

test('shows bootstrap and login failures without granting admin access', async (context) => {
  await context.test('bootstrap failure', async () => {
    const container = await mountApp('/admin', async () =>
      jsonResponse({ success: false, message: 'Service unavailable' }, 503),
    )

    assert.equal(dom.window.location.pathname, '/admin')
    assert.match(container.textContent, /Admin unavailable/)
  })

  await context.test('login failure', async () => {
    const container = await mountApp('/admin/login', async (path) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: false, message: 'Authentication required' }, 401)
      }

      return jsonResponse({ success: false, message: 'Invalid username or password' }, 401)
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
    assert.match(container.textContent, /Invalid username or password/)
  })
})
