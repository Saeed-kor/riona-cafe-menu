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
  const container = await mountApp('/admin/login', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    return jsonResponse({ success: true, categories: [] })
  })

  assert.equal(dom.window.location.pathname, '/admin')
  assert.match(container.textContent, /مدیر: admin/)
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

    if (path === '/api/admin/categories') {
      return jsonResponse({ success: true, categories: [] })
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
  assert.match(container.textContent, /مدیر: admin/)

  const logoutButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'خروج',
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

test('renders the Persian RTL admin shell with category loading and empty states', async () => {
  let resolveCategories
  const pendingCategories = new Promise((resolveResponse) => {
    resolveCategories = resolveResponse
  })
  const container = await mountApp('/admin', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }

    return pendingCategories
  })

  assert.equal(container.querySelector('.admin-panel').getAttribute('dir'), 'rtl')
  assert.match(container.textContent, /پنل مدیریت/)
  assert.match(container.textContent, /در حال دریافت دسته‌بندی‌ها/)
  assert.equal(container.querySelector('#create-category-name').disabled, true)

  resolveCategories(jsonResponse({ success: true, categories: [] }))
  await settle()

  assert.match(container.textContent, /هنوز دسته‌بندی‌ای ایجاد نشده است/)
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
  assert.match(container.textContent, /Admin login/)
})

test('manages category create, edit, visibility, order, and confirmed deletion through the UI', async () => {
  const requests = []
  const fixedDate = '2026-08-04T12:00:00.000Z'
  const categories = new Map([
    ['2', { id: '2', name: 'دسر', sortOrder: 2, isVisible: true, createdAt: fixedDate, updatedAt: fixedDate }],
    ['1', { id: '1', name: 'قهوه', sortOrder: 0, isVisible: true, createdAt: fixedDate, updatedAt: fixedDate }],
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
  const container = await mountApp('/admin', async (path, options) => {
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
