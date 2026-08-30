import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import { createServer as createViteServer } from 'vite'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const viteCacheDirectory = await mkdtemp(join(tmpdir(), 'riona-product-app-test-'))
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/admin/products',
})
const originalGlobals = new Map()

function installGlobal(name, value) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

for (const [name, value] of [
  ['window', dom.window],
  ['document', dom.window.document],
  ['navigator', dom.window.navigator],
  ['HTMLElement', dom.window.HTMLElement],
  ['HTMLInputElement', dom.window.HTMLInputElement],
  ['Event', dom.window.Event],
  ['MouseEvent', dom.window.MouseEvent],
  ['Node', dom.window.Node],
  ['MutationObserver', dom.window.MutationObserver],
  ['File', dom.window.File],
  ['Blob', dom.window.Blob],
  ['FormData', dom.window.FormData],
  ['getComputedStyle', dom.window.getComputedStyle.bind(dom.window)],
  ['IS_REACT_ACT_ENVIRONMENT', true],
]) installGlobal(name, value)

const originalFetch = globalThis.fetch
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL
const objectUrls = []
const revokedObjectUrls = []
URL.createObjectURL = () => {
  const url = `blob:riona-product-${objectUrls.length + 1}`
  objectUrls.push(url)
  return url
}
URL.revokeObjectURL = (url) => revokedObjectUrls.push(url)

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

const managedPath = `/uploads/products/${'ab'.repeat(16)}.png`

function product(overrides = {}) {
  return {
    id: '1',
    categoryId: '9',
    categoryName: 'قهوه',
    name: 'لاته',
    description: 'نرم و گرم',
    price: '18446744073709551615',
    imagePath: managedPath,
    sortOrder: 0,
    isAvailable: false,
    isVisible: true,
    ...overrides,
  }
}

function categoryFixture(overrides = {}) {
  return {
    id: '9',
    name: 'قهوه',
    imagePath: null,
    sortOrder: 0,
    isVisible: true,
    ...overrides,
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settle(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await act(() => new Promise((resolveCycle) => setTimeout(resolveCycle, 0)))
  }
}

async function unmountApp() {
  if (!activeRoot) return
  await act(() => activeRoot.unmount())
  activeRoot = null
}

async function mountApp(pathname, handler, { strict = false, settleAfterRender = true } = {}) {
  await unmountApp()
  dom.window.history.replaceState({}, '', pathname)
  fetchHandler = handler
  const container = dom.window.document.getElementById('root')
  activeRoot = createRoot(container)
  await act(() => activeRoot.render(strict
    ? createElement(StrictMode, null, createElement(App))
    : createElement(App)))
  if (settleAfterRender) await settle()
  return container
}

function findButton(container, name) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === name)
}

function findControl(container, labelText) {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent.trim() === labelText,
  )
  return label?.htmlFor ? container.querySelector(`#${label.htmlFor}`) : label?.querySelector('input')
}

async function setControlValue(control, value) {
  const prototype = control instanceof dom.window.HTMLTextAreaElement
    ? dom.window.HTMLTextAreaElement.prototype
    : control instanceof dom.window.HTMLSelectElement
      ? dom.window.HTMLSelectElement.prototype
      : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
  await act(() => {
    setter.call(control, value)
    control.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

async function setFile(control, fileOrName = 'coffee.png') {
  const file = fileOrName instanceof dom.window.File
    ? fileOrName
    : new dom.window.File(['image'], fileOrName, { type: 'image/png' })
  Object.defineProperty(control, 'files', { configurable: true, value: [file] })
  await act(() => control.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
  return file
}

function revokeCount(url) {
  return revokedObjectUrls.filter((candidate) => candidate === url).length
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readCssRule(css, selector) {
  const match = css.match(new RegExp(`${escapeRegularExpression(selector)}\\s*\\{([^}]*)\\}`, 's'))
  assert.notEqual(match, null, `Missing Production CSS selector: ${selector}`)
  return match[1]
}

function readCssDeclaration(rule, property) {
  const match = rule.match(new RegExp(`(?:^|;)\\s*${escapeRegularExpression(property)}\\s*:\\s*([^;]+)`, 's'))
  assert.notEqual(match, null, `Missing Production CSS declaration: ${property}`)
  return match[1].trim()
}

function parseOpaqueHexColor(value) {
  const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  assert.notEqual(match, null, `Expected an sRGB hex color, received: ${value}`)
  const expanded = match[1].length <= 4
    ? [...match[1]].map((character) => character.repeat(2)).join('')
    : match[1]
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6), 16) : 255
  assert.equal(alpha, 255, `Contrast test requires compositing for non-opaque color: ${value}`)

  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255)
}

function resolveCssColor(css, declaration) {
  const token = declaration.match(/var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8}\b/i)?.[0]
  assert.notEqual(token, undefined, `Missing color token in declaration: ${declaration}`)

  if (!token.startsWith('var(')) return parseOpaqueHexColor(token)

  const variableName = token.slice(4, -1)
  const variableMatch = css.match(new RegExp(`${escapeRegularExpression(variableName)}\\s*:\\s*(#[0-9a-f]{3,8})\\s*;`, 'i'))
  assert.notEqual(variableMatch, null, `Missing Production CSS variable: ${variableName}`)
  return parseOpaqueHexColor(variableMatch[1])
}

function relativeLuminance(color) {
  const [red, green, blue] = color.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ))
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(firstColor, secondColor) {
  const firstLuminance = relativeLuminance(firstColor)
  const secondLuminance = relativeLuminance(secondColor)
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  )
}

function assertProductStatusSwitchContrast(css) {
  const uncheckedTrackRule = readCssRule(css, '.admin-panel .product-status-control__switch')
  const checkedTrackRule = readCssRule(
    css,
    '.admin-panel .product-status-control > input:checked + label .product-status-control__switch',
  )
  const thumbRule = readCssRule(css, '.admin-panel .product-status-control__switch > span')
  const focusRule = readCssRule(css, '.admin-panel .product-status-control > input:focus-visible + label')
  const normalLabelRule = readCssRule(css, '.admin-panel .product-status-control > label')
  const disabledLabelRule = readCssRule(css, '.admin-panel .product-status-control > input:disabled + label')
  const statusCardRule = readCssRule(css, '.admin-panel .product-form__switches')

  for (const [state, rule] of [
    ['unchecked track', uncheckedTrackRule],
    ['checked track', checkedTrackRule],
    ['thumb', thumbRule],
  ]) {
    assert.doesNotMatch(rule, /(?:^|;)\s*opacity\s*:/, `${state} requires composited contrast coverage`)
  }

  const uncheckedTrack = resolveCssColor(css, readCssDeclaration(uncheckedTrackRule, 'background'))
  const checkedTrack = resolveCssColor(css, readCssDeclaration(checkedTrackRule, 'background'))
  const thumb = resolveCssColor(css, readCssDeclaration(thumbRule, 'background'))
  const focusIndicator = resolveCssColor(css, readCssDeclaration(focusRule, 'outline'))
  const backgrounds = [
    ['normal Create/Edit label', resolveCssColor(css, readCssDeclaration(normalLabelRule, 'background'))],
    ['disabled Create/Edit label', resolveCssColor(css, readCssDeclaration(disabledLabelRule, 'background'))],
    ['Create/Edit status card', resolveCssColor(css, readCssDeclaration(statusCardRule, 'background'))],
  ]

  for (const [backgroundName, background] of backgrounds) {
    const uncheckedRatio = contrastRatio(uncheckedTrack, background)
    assert.ok(
      uncheckedRatio >= 3.5,
      `Unchecked Product switch contrast on ${backgroundName} is ${uncheckedRatio}:1`,
    )

    const checkedRatio = contrastRatio(checkedTrack, background)
    assert.ok(
      checkedRatio >= 3,
      `Checked Product switch contrast on ${backgroundName} is ${checkedRatio}:1`,
    )
  }

  for (const [state, track] of [['unchecked', uncheckedTrack], ['checked', checkedTrack]]) {
    const thumbRatio = contrastRatio(thumb, track)
    assert.ok(thumbRatio >= 3, `Product switch thumb contrast in ${state} state is ${thumbRatio}:1`)
  }

  const statusCardBackground = backgrounds.find(([name]) => name === 'Create/Edit status card')[1]
  const focusRatio = contrastRatio(focusIndicator, statusCardBackground)
  assert.ok(focusRatio >= 3, `Product switch focus contrast is ${focusRatio}:1`)
}

async function submit(form) {
  await act(() => form.dispatchEvent(new dom.window.Event('submit', {
    bubbles: true,
    cancelable: true,
  })))
}

async function click(control) {
  assert.notEqual(control, undefined)
  await act(() => control.click())
}

async function resolveDeferred(pending, value) {
  await act(async () => {
    pending.resolve(value)
    await Promise.resolve()
  })
}

async function navigate(pathname) {
  await act(() => {
    dom.window.history.pushState({}, '', pathname)
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
  })
  await settle()
}

async function travelHistory(direction) {
  const navigationCompleted = new Promise((resolveNavigation) => {
    dom.window.addEventListener('popstate', resolveNavigation, { once: true })
  })

  dom.window.history[direction]()
  await act(async () => navigationCompleted)
  await settle()
}

function baseHandler({ products = [product()], categories = [categoryFixture()] } = {}) {
  return async (path, options = {}) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }
    if (path === '/api/admin/categories') {
      return jsonResponse({ success: true, categories })
    }
    if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
      return jsonResponse({ success: true, products })
    }
    throw new Error(`Unexpected Product UI request: ${path} ${options.method ?? 'GET'}`)
  }
}

async function fillCreateForm(container, fileOrName = 'coffee.png') {
  await setControlValue(findControl(container, 'نام محصول'), 'موکا')
  await setControlValue(findControl(container, 'قیمت (تومان)'), '9007199254740992')
  await setControlValue(findControl(container, 'توضیحات (اختیاری)'), 'بدون تبدیل قیمت')
  await setFile(findControl(container, 'انتخاب تصویر محصول'), fileOrName)
  return findControl(container, 'نام محصول').closest('form')
}

test.after(async () => {
  await unmountApp()
  await viteServer.close()
  globalThis.fetch = originalFetch
  URL.createObjectURL = originalCreateObjectUrl
  URL.revokeObjectURL = originalRevokeObjectUrl
  dom.window.close()
  await rm(viteCacheDirectory, { recursive: true, force: true })
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('renders the exact protected Product route with accessible Toman and independent status UI', async () => {
  const calls = []
  const handler = baseHandler()
  const container = await mountApp('/admin/products', async (path, options) => {
    calls.push({ path, options })
    return handler(path, options)
  })

  assert.equal(container.querySelector('h1')?.textContent, 'محصولات')
  assert.equal(container.querySelector('a[aria-current="page"]')?.getAttribute('href'), '/admin/products')
  assert.notEqual(findControl(container, 'قیمت (تومان)'), undefined)
  const renderedPrice = [...container.querySelectorAll('p')]
    .find((paragraph) => paragraph.textContent.trim().endsWith('تومان'))
  assert.equal(renderedPrice.textContent.replace(/\D/g, ''), '18446744073709551615')
  assert.match(container.textContent, /تومان/)
  assert.match(container.textContent, /نمایش در منو/)
  assert.match(container.textContent, /ناموجود/)
  assert.equal(container.querySelector('img[alt="تصویر لاته"]')?.getAttribute('src'), managedPath)
  assert.deepEqual(calls.slice(0, 3).map((call) => call.path).sort(), [
    '/api/admin/auth/me',
    '/api/admin/categories',
    '/api/admin/products',
  ].sort())
  for (const call of calls) assert.equal(call.options.credentials, 'include')
})

test('renders the redesigned Product editor and catalog with real accessible controls', async () => {
  const container = await mountApp('/admin/products', baseHandler())
  const createForm = container.querySelector('.product-form--create')
  const descriptionLabels = [...createForm.querySelectorAll('label')]
    .filter((label) => label.textContent.trim() === 'توضیحات (اختیاری)')

  assert.equal(descriptionLabels.length, 1)
  assert.equal(descriptionLabels[0].htmlFor, 'create-product-description')

  const fileInput = findControl(container, 'انتخاب تصویر محصول')
  const fileLabel = container.querySelector('label[for="create-product-image"]')
  assert.equal(fileInput?.type, 'file')
  assert.equal(fileInput?.classList.contains('product-file-input'), true)
  assert.equal(fileLabel?.htmlFor, fileInput.id)
  assert.equal(fileLabel?.textContent.trim(), 'انتخاب تصویر محصول')
  assert.match(fileInput.getAttribute('aria-describedby'), /create-product-image-state/)
  assert.match(fileInput.getAttribute('aria-describedby'), /create-product-image-help/)
  assert.equal(container.querySelector('#create-product-image-state')?.textContent.trim(), 'تصویری انتخاب نشده است.')

  for (const status of [
    ['visible', 'نمایش در منو', 'آیا محصول در منوی عمومی دیده شود؟', 'فعال'],
    ['available', 'موجود بودن', 'آیا محصول اکنون قابل سفارش است؟', 'موجود'],
  ]) {
    const [suffix, title, help, value] = status
    const input = container.querySelector(`#create-product-${suffix}`)
    const label = container.querySelector(`label[for="create-product-${suffix}"]`)
    assert.equal(input?.type, 'checkbox')
    assert.equal(input?.getAttribute('aria-label'), title)
    assert.equal(label?.htmlFor, input.id)
    assert.match(label.textContent, new RegExp(title))
    assert.equal(container.querySelector(`#create-product-${suffix}-help`)?.textContent, help)
    assert.match(label.textContent, new RegExp(value))
  }

  const productCard = container.querySelector('.product-item')
  assert.notEqual(productCard, null)
  assert.notEqual(productCard.querySelector('.product-item__media'), null)
  assert.deepEqual(
    [...productCard.querySelectorAll('.product-status-badge')].map((badge) => badge.textContent.trim()),
    ['نمایش در منو', 'ناموجود'],
  )
  assert.notEqual(productCard.querySelector('button[aria-label="ویرایش محصول لاته"]'), null)
  assert.notEqual(productCard.querySelector('button[aria-label="جایگزینی تصویر محصول لاته"]'), null)
  assert.notEqual(productCard.querySelector('button[aria-label="حذف محصول لاته"]'), null)
  assert.equal(
    container.querySelector('.product-management__refresh .admin-secondary-button')?.textContent.trim(),
    'بارگذاری دوباره',
  )
})

test('keeps Product visual rules Admin-scoped, responsive, and keyboard-safe', async () => {
  const css = await readFile(join(projectRoot, 'src', 'App.css'), 'utf8')
  const productSelectorLines = css.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('.product') && (line.endsWith('{') || line.endsWith(',')))

  assert.ok(productSelectorLines.length > 40)
  for (const selector of productSelectorLines) {
    assert.match(selector, /^\.admin-panel\s/, `Product selector escaped the Admin scope: ${selector}`)
  }

  assert.match(css, /\.admin-panel \.product-management\s*\{[^}]*width:\s*min\(100%, 1180px\)/s)
  assert.match(css, /\.admin-panel [^{]*\.product-upload__button[^}]*min-height:\s*44px/s)
  assert.match(css, /\.admin-panel \.product-file-input:focus-visible \+ \.product-upload__button/s)
  assert.match(css, /@media \(max-width: 760px\)[^{]*\{[\s\S]*?\.admin-panel \.product-form__layout/s)
  assert.match(css, /@media \(max-width: 520px\)[^{]*\{[\s\S]*?\.admin-panel \.product-form__inline-fields/s)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^{]*\{[\s\S]*?\.admin-panel \.product-item/s)
})

test('keeps the real Product status switch perceptible in every Production state', async () => {
  const css = await readFile(join(projectRoot, 'src', 'App.css'), 'utf8')
  assertProductStatusSwitchContrast(css)

  const uncheckedTrackRule = readCssRule(css, '.admin-panel .product-status-control__switch')
  const legacyTrackRule = uncheckedTrackRule.replace(
    /background\s*:\s*#[0-9a-f]{3,8}/i,
    'background: #a8ada9',
  )
  const legacyCss = css.replace(uncheckedTrackRule, legacyTrackRule)
  assert.notEqual(legacyCss, css, 'Legacy contrast mutation did not reach the Production selector')
  assert.throws(
    () => assertProductStatusSwitchContrast(legacyCss),
    (error) => /Unchecked Product switch contrast/.test(error.message),
  )
})

test('presents stable Product loading, empty, and error states', async (context) => {
  await context.test('loading state has a dedicated status surface', async () => {
    const pendingCategories = deferred()
    const pendingProducts = deferred()
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return pendingCategories.promise
      if (path === '/api/admin/products') return pendingProducts.promise
      throw new Error(path)
    }, { settleAfterRender: false })

    await settle()
    const loadingState = container.querySelector('.product-state--loading[role="status"]')
    assert.notEqual(loadingState, null)
    assert.match(loadingState.textContent, /در حال آماده‌سازی محصولات/)
    assert.equal(container.querySelector('.product-editor'), null)

    await act(async () => {
      pendingCategories.resolve(jsonResponse({ success: true, categories: [] }))
      pendingProducts.resolve(jsonResponse({ success: true, products: [] }))
      await Promise.resolve()
    })
    await settle()
  })

  await context.test('empty catalog gives a useful next step without fake data', async () => {
    const container = await mountApp('/admin/products', baseHandler({ products: [] }))
    const emptyState = container.querySelector('.product-empty-state[role="status"]')
    assert.equal(emptyState?.querySelector('h3')?.textContent, 'هنوز محصولی ایجاد نشده است.')
    assert.match(emptyState?.querySelector('p')?.textContent, /از فرم بالا شروع کنید/)
    assert.equal(container.querySelectorAll('.product-item').length, 0)
  })

  await context.test('error state remains safe and exposes Retry', async () => {
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products') return jsonResponse({ success: false, message: 'SQL private detail' }, 500)
      throw new Error(path)
    })
    const errorState = container.querySelector('.product-state--error[role="alert"]')
    assert.equal(errorState?.querySelector('strong')?.textContent, 'دریافت اطلاعات مدیریت محصولات ممکن نشد.')
    assert.notEqual(findButton(container, 'تلاش دوباره'), undefined)
    assert.doesNotMatch(errorState.textContent, /SQL|private detail/)
  })
})

test('disables Product creation without categories and provides an accessible Category link', async () => {
  const container = await mountApp('/admin/products', baseHandler({ categories: [], products: [] }))

  assert.match(container.textContent, /ابتدا یک دسته‌بندی بسازید/)
  const categoryLink = [...container.querySelectorAll('a[href="/admin/categories"]')]
    .find((link) => link.textContent.trim() === 'رفتن به دسته‌بندی‌ها')
  assert.notEqual(categoryLink, undefined)
  assert.equal(findButton(container, 'ایجاد محصول'), undefined)
})

test('runs create, edit, replace, and confirmed delete through the real Product UI/client', async () => {
  const requests = []
  let current = product()
  const originalConfirm = dom.window.confirm
  dom.window.confirm = () => true

  try {
    const container = await mountApp('/admin/products', async (path, options = {}) => {
      requests.push({ path, options })
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') return jsonResponse({ success: true, products: [current] })
      if (path === '/api/admin/products' && options.method === 'POST') {
        assert.equal(options.headers, undefined)
        const metadata = JSON.parse(options.body.get('metadata'))
        assert.equal(metadata.price, '9007199254740992')
        assert.equal(typeof metadata.price, 'string')
        assert.equal(options.body.get('image').name, 'coffee.png')
        const created = product({ id: '2', name: metadata.name, description: metadata.description, price: metadata.price })
        return jsonResponse({ success: true, product: created }, 201)
      }
      if (path === '/api/admin/products/1' && options.method === 'PATCH') {
        const changes = JSON.parse(options.body)
        assert.equal(changes.price, '0')
        current = { ...current, ...changes }
        return jsonResponse({ success: true, product: current })
      }
      if (path === '/api/admin/products/1/image' && options.method === 'PUT') {
        assert.equal(options.headers, undefined)
        current = { ...current, imagePath: `/uploads/products/${'cd'.repeat(16)}.webp` }
        return jsonResponse({ success: true, product: current })
      }
      if (path === '/api/admin/products/1' && options.method === 'DELETE') {
        return jsonResponse({ success: true, message: 'Product deleted' })
      }
      throw new Error(`Unexpected CRUD request: ${path}`)
    })

    const createForm = await fillCreateForm(container)
    const firstCreatePreview = objectUrls[objectUrls.length - 1]
    await setFile(findControl(container, 'انتخاب تصویر محصول'))
    const submittedCreatePreview = objectUrls[objectUrls.length - 1]
    assert.equal(revokedObjectUrls.includes(firstCreatePreview), true)
    await Promise.all([submit(createForm), submit(createForm)])
    await settle()
    assert.equal(requests.filter((request) => request.options.method === 'POST').length, 1)
    assert.match(container.textContent, /موکا/)
    assert.equal(revokedObjectUrls.includes(submittedCreatePreview), true)

    await click(findButton(container, 'ویرایش'))
    await settle()
    const editPrice = [...container.querySelectorAll('label')]
      .find((label) => label.textContent.trim() === 'قیمت (تومان)' && label.htmlFor.startsWith('edit-product-1'))
    await setControlValue(container.querySelector(`#${editPrice.htmlFor}`), '0')
    await submit(container.querySelector(`#${editPrice.htmlFor}`).closest('form'))
    await settle()
    assert.match(container.textContent, /0 تومان/)

    await click(findButton(container, 'جایگزینی تصویر'))
    await settle()
    const replaceInput = container.querySelector('#replace-product-1')
    await setFile(replaceInput, 'replacement.webp')
    const replacementPreview = objectUrls[objectUrls.length - 1]
    const oldImage = container.querySelector('img[alt="تصویر لاته"]')?.getAttribute('src')
    await submit(replaceInput.closest('form'))
    await settle()
    assert.equal(oldImage, managedPath)
    assert.match(container.querySelector('img[alt="تصویر لاته"]')?.getAttribute('src'), /cdcd/)
    assert.equal(revokedObjectUrls.includes(replacementPreview), true)
    assert.equal(findButton(container, 'حذف تصویر'), undefined)

    await click(findButton(container, 'حذف'))
    await settle()
    assert.doesNotMatch(container.textContent, /لاته/)
  } finally {
    dom.window.confirm = originalConfirm
  }
})

test('shows field-specific Product errors, safe load errors, and Retry recovery', async () => {
  let productLoads = 0
  const container = await mountApp('/admin/products', async (path, options = {}) => {
    if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
    if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
      productLoads += 1
      return productLoads === 1
        ? jsonResponse({ success: false, message: 'SELECT private' }, 500)
        : jsonResponse({ success: true, products: [] })
    }
    throw new Error(`Unexpected validation request: ${path}`)
  })

  assert.notEqual(container.querySelector('[role="alert"]'), null)
  assert.doesNotMatch(container.textContent, /SELECT|private/)
  await click(findButton(container, 'تلاش دوباره'))
  await settle()
  const form = container.querySelector('.product-form')
  await submit(form)
  await settle()
  const invalid = container.querySelector('[aria-invalid="true"]')
  assert.equal(invalid?.id, 'create-product-name')
  assert.equal(dom.window.document.activeElement, invalid)
  assert.match(invalid.getAttribute('aria-describedby'), /create-product-name-error/)
})

test('fails closed when a successful Category dependency payload is malformed', async () => {
  const container = await mountApp('/admin/products', async (path) => {
    if (path === '/api/admin/auth/me') {
      return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
    }
    if (path === '/api/admin/categories') {
      return jsonResponse({
        success: true,
        categories: [{ id: '01', name: 'SQL private detail', password_hash: 'not-rendered' }],
      })
    }
    if (path === '/api/admin/products') {
      return jsonResponse({ success: true, products: [] })
    }
    throw new Error(path)
  })

  const safeError = container.querySelector('.product-state--error[role="alert"]')
  assert.equal(safeError?.querySelector('strong')?.textContent, 'دریافت اطلاعات مدیریت محصولات ممکن نشد.')
  assert.notEqual(findButton(container, 'تلاش دوباره'), undefined)
  assert.equal(findButton(container, 'ایجاد محصول'), undefined)
  assert.doesNotMatch(container.textContent, /SQL private detail|password_hash|not-rendered/)
})

test('keeps Product file-input DOM, React state, and object URLs synchronized', async (context) => {
  await context.test('Create success resets the real input and permits the same File again', async () => {
    const selectedFile = new dom.window.File(['same-image'], 'same-image.png', {
      type: 'image/png',
    })
    const container = await mountApp('/admin/products', async (path, options = {}) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }
      if (path === '/api/admin/categories') {
        return jsonResponse({ success: true, categories: [categoryFixture()] })
      }
      if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
        return jsonResponse({ success: true, products: [] })
      }
      if (path === '/api/admin/products' && options.method === 'POST') {
        assert.equal(options.body.get('image').name, selectedFile.name)
        return jsonResponse({
          success: true,
          product: product({ id: '2', name: 'same-file-created' }),
        }, 201)
      }
      throw new Error(path)
    })

    const createForm = await fillCreateForm(container, selectedFile)
    const inputBeforeSuccess = container.querySelector('#create-product-image')
    const submittedPreview = objectUrls[objectUrls.length - 1]
    assert.equal(inputBeforeSuccess.files[0], selectedFile)

    await submit(createForm)
    await settle()

    const inputAfterSuccess = container.querySelector('#create-product-image')
    assert.notEqual(inputAfterSuccess, inputBeforeSuccess)
    assert.equal(inputAfterSuccess.files.length, 0)
    assert.equal(container.querySelector('.product-form__preview'), null)
    assert.equal(revokeCount(submittedPreview), 1)

    await setFile(inputAfterSuccess, selectedFile)
    const repeatedPreview = objectUrls[objectUrls.length - 1]
    assert.equal(inputAfterSuccess.files[0], selectedFile)
    assert.notEqual(repeatedPreview, submittedPreview)
    assert.notEqual(container.querySelector('.product-form__preview'), null)

    await unmountApp()
    assert.equal(revokeCount(repeatedPreview), 1)
  })

  await context.test('manual Create reset clears both state and the native file input', async () => {
    const selectedFile = new dom.window.File(['manual-reset'], 'manual-reset.png', {
      type: 'image/png',
    })
    const container = await mountApp('/admin/products', baseHandler({ products: [] }))
    const createForm = await fillCreateForm(container, selectedFile)
    const inputBeforeReset = container.querySelector('#create-product-image')
    const previewBeforeReset = objectUrls[objectUrls.length - 1]

    await click(findButton(container, 'پاک‌کردن فرم'))
    await settle()

    const inputAfterReset = container.querySelector('#create-product-image')
    assert.notEqual(inputAfterReset, inputBeforeReset)
    assert.equal(inputAfterReset.files.length, 0)
    assert.equal(container.querySelector('.product-form__preview'), null)
    assert.equal(revokeCount(previewBeforeReset), 1)
    assert.equal(container.querySelector('#create-product-name').value, '')
    assert.equal(container.querySelector('#create-product-price').value, '')

    await setControlValue(container.querySelector('#create-product-name'), 'بعد از پاک‌کردن')
    await setControlValue(container.querySelector('#create-product-price'), '1')
    await submit(createForm)
    await settle()
    assert.equal(container.querySelector('#create-product-image').getAttribute('aria-invalid'), 'true')
  })

  await context.test('Create failure preserves the File and preview for a retry', async () => {
    const selectedFile = new dom.window.File(['retry-image'], 'retry-image.png', {
      type: 'image/png',
    })
    const submittedImages = []
    let creates = 0
    const container = await mountApp('/admin/products', async (path, options = {}) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }
      if (path === '/api/admin/categories') {
        return jsonResponse({ success: true, categories: [categoryFixture()] })
      }
      if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
        return jsonResponse({ success: true, products: [] })
      }
      if (path === '/api/admin/products' && options.method === 'POST') {
        creates += 1
        submittedImages.push(options.body.get('image'))
        return creates === 1
          ? jsonResponse({ success: false }, 500)
          : jsonResponse({
              success: true,
              product: product({ id: '2', name: 'retry-created' }),
            }, 201)
      }
      throw new Error(path)
    })

    const createForm = await fillCreateForm(container, selectedFile)
    const input = container.querySelector('#create-product-image')
    const preview = objectUrls[objectUrls.length - 1]

    await submit(createForm)
    await settle()
    assert.equal(input.files[0], selectedFile)
    assert.equal(container.querySelector('.product-form__preview')?.getAttribute('src'), preview)
    assert.equal(revokeCount(preview), 0)

    await submit(createForm)
    await settle()
    assert.equal(creates, 2)
    assert.deepEqual(submittedImages.map((image) => image.name), [selectedFile.name, selectedFile.name])
    assert.equal(container.querySelector('#create-product-image').files.length, 0)
    assert.equal(revokeCount(preview), 1)
  })

  await context.test('Replace failure preserves retry state and success or cancel fully unmounts it', async () => {
    const firstFile = new dom.window.File(['first-replacement'], 'first-replacement.png', {
      type: 'image/png',
    })
    const secondFile = new dom.window.File(['second-replacement'], 'second-replacement.png', {
      type: 'image/png',
    })
    let replacements = 0
    const container = await mountApp('/admin/products', async (path, options = {}) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }
      if (path === '/api/admin/categories') {
        return jsonResponse({ success: true, categories: [categoryFixture()] })
      }
      if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
        return jsonResponse({ success: true, products: [product()] })
      }
      if (path === '/api/admin/products/1/image' && options.method === 'PUT') {
        replacements += 1
        assert.equal(options.body.get('image').name, secondFile.name)
        return replacements === 1
          ? jsonResponse({ success: false }, 500)
          : jsonResponse({
              success: true,
              product: product({ imagePath: `/uploads/products/${'cd'.repeat(16)}.png` }),
            })
      }
      throw new Error(path)
    })

    await click(findButton(container, 'جایگزینی تصویر'))
    await settle()
    const input = container.querySelector('#replace-product-1')
    await setFile(input, firstFile)
    const firstPreview = objectUrls[objectUrls.length - 1]
    await setFile(input, secondFile)
    const retryPreview = objectUrls[objectUrls.length - 1]
    assert.equal(revokeCount(firstPreview), 1)

    await submit(input.closest('form'))
    await settle()
    assert.equal(input.files[0], secondFile)
    assert.equal(container.querySelector('.product-form__preview')?.getAttribute('src'), retryPreview)
    assert.equal(revokeCount(retryPreview), 0)

    await submit(input.closest('form'))
    await settle()
    assert.equal(container.querySelector('#replace-product-1'), null)
    assert.equal(container.querySelector('.product-replace-form'), null)
    assert.equal(revokeCount(retryPreview), 1)

    await click(findButton(container, 'جایگزینی تصویر'))
    await settle()
    const reopenedInput = container.querySelector('#replace-product-1')
    await setFile(reopenedInput, secondFile)
    const cancelledPreview = objectUrls[objectUrls.length - 1]
    await click(findButton(container, 'انصراف'))
    await settle()
    assert.equal(container.querySelector('#replace-product-1'), null)
    assert.equal(revokeCount(cancelledPreview), 1)
  })
})

test('enforces authoritative Product-load 401 ownership across mutations and auth epochs', async (context) => {
  for (const [label, failingPath] of [
    ['Product', '/api/admin/products'],
    ['Category dependency', '/api/admin/categories'],
  ]) {
    await context.test(`${label} 401 from the current epoch wins after a successful mutation`, async () => {
      const pendingCategories = deferred()
      const pendingProducts = deferred()
      let categoryLoads = 0
      let productLoads = 0
      const originalConfirm = dom.window.confirm
      dom.window.confirm = () => true

      try {
        const container = await mountApp('/admin/products', async (path, options = {}) => {
          if (path === '/api/admin/auth/me') {
            return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
          }
          if (path === '/api/admin/categories') {
            categoryLoads += 1
            return categoryLoads === 1
              ? jsonResponse({
                  success: true,
                  categories: [categoryFixture({ name: 'sensitive-category-401' })],
                })
              : pendingCategories.promise
          }
          if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
            productLoads += 1
            return productLoads === 1
              ? jsonResponse({
                  success: true,
                  products: [product({
                    name: 'sensitive-product-401',
                    categoryName: 'sensitive-category-401',
                  })],
                })
              : pendingProducts.promise
          }
          if (path === '/api/admin/products/1' && options.method === 'DELETE') {
            return jsonResponse({ success: true })
          }
          throw new Error(path)
        })

        await click(findButton(container, 'بارگذاری دوباره'))
        await settle()
        await click(findButton(container, 'حذف'))
        await settle()
        assert.doesNotMatch(container.textContent, /sensitive-product-401/)

        await act(async () => {
          pendingCategories.resolve(failingPath === '/api/admin/categories'
            ? jsonResponse({ success: false }, 401)
            : jsonResponse({
                success: true,
                categories: [categoryFixture({ name: 'stale-category-success' })],
              }))
          pendingProducts.resolve(failingPath === '/api/admin/products'
            ? jsonResponse({ success: false }, 401)
            : jsonResponse({ success: true, products: [] }))
          await Promise.resolve()
        })
        await settle()

        assert.equal(dom.window.location.pathname, '/admin/login')
        assert.equal(container.querySelector('#product-management-title'), null)
        assert.equal(container.querySelector('#admin-login-title')?.textContent, 'ورود به پنل مدیریت')
        assert.doesNotMatch(
          container.textContent,
          /sensitive-product-401|sensitive-category-401|stale-category-success/,
        )
      } finally {
        dom.window.confirm = originalConfirm
      }
    })
  }

  await context.test('an old-epoch Product 401 cannot invalidate a newer Login', async () => {
    const pendingCategories = deferred()
    const pendingProducts = deferred()
    let categoryLoads = 0
    let productLoads = 0
    const originalConfirm = dom.window.confirm
    dom.window.confirm = () => true

    try {
      const container = await mountApp('/admin/products', async (path, options = {}) => {
        if (path === '/api/admin/auth/me') {
          return jsonResponse({ success: true, admin: { id: '1', username: 'old-admin' } })
        }
        if (path === '/api/admin/categories') {
          categoryLoads += 1
          return categoryLoads === 1
            ? jsonResponse({ success: true, categories: [categoryFixture()] })
            : pendingCategories.promise
        }
        if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
          productLoads += 1
          return productLoads === 1
            ? jsonResponse({ success: true, products: [product()] })
            : pendingProducts.promise
        }
        if (path === '/api/admin/products/1' && options.method === 'DELETE') {
          return jsonResponse({ success: false }, 401)
        }
        if (path === '/api/admin/auth/login' && options.method === 'POST') {
          return jsonResponse({
            success: true,
            admin: { id: '2', username: 'new-admin' },
          })
        }
        throw new Error(path)
      })

      await click(findButton(container, 'بارگذاری دوباره'))
      await settle()
      await click(findButton(container, 'حذف'))
      await settle()
      assert.equal(dom.window.location.pathname, '/admin/login')

      await setControlValue(findControl(container, 'نام کاربری'), 'new-admin')
      await setControlValue(findControl(container, 'رمز عبور'), 'valid-password')
      await submit(findControl(container, 'نام کاربری').closest('form'))
      await settle()
      assert.equal(dom.window.location.pathname, '/admin')
      assert.match(container.textContent, /مدیر: new-admin/)

      await act(async () => {
        pendingCategories.resolve(jsonResponse({ success: false }, 401))
        pendingProducts.resolve(jsonResponse({ success: false }, 401))
        await Promise.resolve()
      })
      await settle()

      assert.equal(dom.window.location.pathname, '/admin')
      assert.match(container.textContent, /مدیر: new-admin/)
      assert.equal(container.querySelector('#admin-login-title'), null)
    } finally {
      dom.window.confirm = originalConfirm
    }
  })

  await context.test('a Product 401 after Public navigation cannot redirect the Public route', async () => {
    const pendingProduct = deferred()
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }
      if (path === '/api/admin/categories') {
        return jsonResponse({ success: true, categories: [categoryFixture()] })
      }
      if (path === '/api/admin/products') return pendingProduct.promise
      throw new Error(path)
    }, { settleAfterRender: false })

    await settle()
    await navigate('/')
    await resolveDeferred(pendingProduct, jsonResponse({ success: false }, 401))
    await settle()

    assert.equal(dom.window.location.pathname, '/')
    assert.equal(container.querySelector('#admin-login-title'), null)
    assert.equal(container.querySelector('#product-management-title'), null)
  })

  await context.test('a Product 401 after unmount causes no state-update warning', async () => {
    const pendingProduct = deferred()
    const capturedErrors = []
    const originalConsoleError = console.error
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }
      if (path === '/api/admin/categories') {
        return jsonResponse({ success: true, categories: [categoryFixture()] })
      }
      if (path === '/api/admin/products') return pendingProduct.promise
      throw new Error(path)
    }, { settleAfterRender: false })

    await settle()
    await unmountApp()
    console.error = (...argumentsList) => capturedErrors.push(argumentsList.join(' '))
    try {
      await resolveDeferred(pendingProduct, jsonResponse({ success: false }, 401))
      await settle()
    } finally {
      console.error = originalConsoleError
    }

    assert.equal(container.textContent, '')
    assert.deepEqual(capturedErrors, [])
  })

  await context.test('two simultaneous current-epoch 401 responses cause one safe transition', async () => {
    const pendingCategories = deferred()
    const pendingProducts = deferred()
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }
      if (path === '/api/admin/categories') return pendingCategories.promise
      if (path === '/api/admin/products') return pendingProducts.promise
      throw new Error(path)
    }, { settleAfterRender: false })
    await settle()

    const originalReplaceState = dom.window.history.replaceState
    let loginTransitions = 0
    dom.window.history.replaceState = function replaceState(...argumentsList) {
      const target = new URL(argumentsList[2], dom.window.location.href)
      if (target.pathname === '/admin/login') loginTransitions += 1
      return originalReplaceState.apply(this, argumentsList)
    }

    try {
      await act(async () => {
        pendingCategories.resolve(jsonResponse({ success: false }, 401))
        pendingProducts.resolve(jsonResponse({ success: false }, 401))
        await Promise.resolve()
      })
      await settle()
    } finally {
      dom.window.history.replaceState = originalReplaceState
    }

    assert.equal(dom.window.location.pathname, '/admin/login')
    assert.equal(loginTransitions, 1)
    assert.equal(container.querySelector('#product-management-title'), null)
  })

  await context.test('a stale non-401 load error cannot overwrite a successful mutation', async () => {
    const pendingCategories = deferred()
    const pendingProducts = deferred()
    let categoryLoads = 0
    let productLoads = 0
    const originalConfirm = dom.window.confirm
    dom.window.confirm = () => true

    try {
      const container = await mountApp('/admin/products', async (path, options = {}) => {
        if (path === '/api/admin/auth/me') {
          return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
        }
        if (path === '/api/admin/categories') {
          categoryLoads += 1
          return categoryLoads === 1
            ? jsonResponse({ success: true, categories: [categoryFixture()] })
            : pendingCategories.promise
        }
        if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
          productLoads += 1
          return productLoads === 1
            ? jsonResponse({ success: true, products: [product({ name: 'delete-me' })] })
            : pendingProducts.promise
        }
        if (path === '/api/admin/products/1' && options.method === 'DELETE') {
          return jsonResponse({ success: true })
        }
        throw new Error(path)
      })

      await click(findButton(container, 'بارگذاری دوباره'))
      await settle()
      await click(findButton(container, 'حذف'))
      await settle()
      await act(async () => {
        pendingCategories.resolve(jsonResponse({
          success: true,
          categories: [categoryFixture({ name: 'stale-category' })],
        }))
        pendingProducts.resolve(jsonResponse({ success: false }, 500))
        await Promise.resolve()
      })
      await settle()

      assert.equal(dom.window.location.pathname, '/admin/products')
      assert.doesNotMatch(container.textContent, /delete-me|stale-category/)
      assert.equal(container.querySelector('.product-management [role="alert"]'), null)
      assert.match(container.textContent, /هنوز محصولی ایجاد نشده است/)
    } finally {
      dom.window.confirm = originalConfirm
    }
  })

  await context.test('AbortError is not treated as session expiration', async () => {
    let productLoads = 0
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') {
        return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      }
      if (path === '/api/admin/categories') {
        return jsonResponse({ success: true, categories: [categoryFixture()] })
      }
      if (path === '/api/admin/products') {
        productLoads += 1
        if (productLoads === 1) return jsonResponse({ success: true, products: [product()] })
        const abortError = new Error('aborted')
        abortError.name = 'AbortError'
        throw abortError
      }
      throw new Error(path)
    })

    await click(findButton(container, 'بارگذاری دوباره'))
    await settle()

    assert.equal(dom.window.location.pathname, '/admin/products')
    assert.notEqual(container.querySelector('#product-management-title'), null)
    assert.equal(container.querySelector('#admin-login-title'), null)
    assert.notEqual(findButton(container, 'خروج'), undefined)
  })
})

test('covers all twelve Product route/session/operation race owners with non-cooperative responses', async (context) => {
  await context.test('1) delayed Product load after public navigation is ignored', async () => {
    const productLoad = deferred()
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products') return productLoad.promise
      throw new Error(path)
    }, { settleAfterRender: false })
    await settle()
    await navigate('/')
    await resolveDeferred(productLoad, jsonResponse({ success: true, products: [product({ name: 'stale-public' })] }))
    await settle()
    assert.equal(container.querySelector('.product-management'), null)
    assert.doesNotMatch(container.textContent, /stale-public/)
  })

  await context.test('2) delayed Product load after Logout is ignored', async () => {
    const productLoad = deferred()
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products') return productLoad.promise
      if (path === '/api/admin/auth/logout') return jsonResponse({ success: true })
      throw new Error(path)
    }, { settleAfterRender: false })
    await settle()
    await click(findButton(container, 'خروج'))
    await settle()
    await resolveDeferred(productLoad, jsonResponse({ success: true, products: [product({ name: 'stale-logout' })] }))
    await settle()
    assert.equal(dom.window.location.pathname, '/admin/login')
    assert.doesNotMatch(container.textContent, /stale-logout/)
  })

  await context.test('3) only the newest out-of-order Retry applies', async () => {
    const first = deferred()
    const second = deferred()
    let loads = 0
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products') {
        loads += 1
        if (loads === 1) return jsonResponse({ success: true, products: [] })
        return loads === 2 ? first.promise : second.promise
      }
      throw new Error(path)
    })
    await click(findButton(container, 'بارگذاری دوباره'))
    await settle()
    await click(findButton(container, 'بارگذاری دوباره'))
    await settle()
    await resolveDeferred(second, jsonResponse({ success: true, products: [product({ name: 'fresh-retry' })] }))
    await settle()
    await resolveDeferred(first, jsonResponse({ success: true, products: [product({ name: 'stale-retry' })] }))
    await settle()
    assert.match(container.textContent, /fresh-retry/)
    assert.doesNotMatch(container.textContent, /stale-retry/)
  })

  await context.test('4) delayed Create after route change does not render', async () => {
    const create = deferred()
    const container = await mountApp('/admin/products', async (path, options = {}) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') return jsonResponse({ success: true, products: [] })
      if (path === '/api/admin/products' && options.method === 'POST') return create.promise
      throw new Error(path)
    })
    await submit(await fillCreateForm(container))
    const abandonedPreview = objectUrls[objectUrls.length - 1]
    await navigate('/admin/categories')
    assert.equal(revokedObjectUrls.includes(abandonedPreview), true)
    await resolveDeferred(create, jsonResponse({ success: true, product: product({ name: 'stale-create' }) }, 201))
    await settle()
    assert.doesNotMatch(container.textContent, /stale-create/)
  })

  await context.test('5) Create response after session expiration cannot authenticate UI', async () => {
    const create = deferred()
    let productLoads = 0
    const container = await mountApp('/admin/products', async (path, options = {}) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
        productLoads += 1
        return productLoads === 1 ? jsonResponse({ success: true, products: [] }) : jsonResponse({ success: false }, 401)
      }
      if (path === '/api/admin/products' && options.method === 'POST') return create.promise
      throw new Error(path)
    })
    await submit(await fillCreateForm(container))
    await click(findButton(container, 'بارگذاری دوباره'))
    await settle()
    await resolveDeferred(create, jsonResponse({ success: true, product: product({ name: 'late-create' }) }, 201))
    await settle()
    assert.equal(dom.window.location.pathname, '/admin/login')
    assert.doesNotMatch(container.textContent, /late-create/)
  })

  await context.test('6) an older Edit from a previous route owner cannot overwrite a newer Edit', async () => {
    const firstEdit = deferred()
    let patchCalls = 0
    const handler = async (path, options = {}) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') return jsonResponse({ success: true, products: [product()] })
      if (path === '/api/admin/products/1' && options.method === 'PATCH') {
        patchCalls += 1
        return patchCalls === 1 ? firstEdit.promise : jsonResponse({ success: true, product: product({ price: '200' }) })
      }
      throw new Error(path)
    }
    const container = await mountApp('/admin/products', handler)
    await click(findButton(container, 'ویرایش')); await settle()
    let editPrice = container.querySelector('#edit-product-1-price')
    await setControlValue(editPrice, '100'); await submit(editPrice.closest('form'))
    await navigate('/admin/categories'); await navigate('/admin/products')
    await click(findButton(container, 'ویرایش')); await settle()
    editPrice = container.querySelector('#edit-product-1-price')
    await setControlValue(editPrice, '200'); await submit(editPrice.closest('form')); await settle()
    await resolveDeferred(firstEdit, jsonResponse({ success: true, product: product({ price: '100' }) }))
    await settle()
    assert.match(container.textContent, /200 تومان/)
    assert.doesNotMatch(container.textContent, /100 تومان/)
  })

  await context.test('7) Replace response after Logout is ignored', async () => {
    const replace = deferred()
    const container = await mountApp('/admin/products', async (path, options = {}) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products') return jsonResponse({ success: true, products: [product()] })
      if (path === '/api/admin/products/1/image' && options.method === 'PUT') return replace.promise
      if (path === '/api/admin/auth/logout') return jsonResponse({ success: true })
      throw new Error(path)
    })
    await click(findButton(container, 'جایگزینی تصویر')); await settle()
    const input = container.querySelector('#replace-product-1')
    await setFile(input); await submit(input.closest('form'))
    await click(findButton(container, 'خروج')); await settle()
    await resolveDeferred(replace, jsonResponse({ success: true, product: product({ name: 'late-replace' }) }))
    await settle()
    assert.equal(dom.window.location.pathname, '/admin/login')
    assert.doesNotMatch(container.textContent, /late-replace/)
  })

  await context.test('8) a stale list cannot resurrect a deleted Product', async () => {
    const staleList = deferred()
    let loads = 0
    const originalConfirm = dom.window.confirm
    dom.window.confirm = () => true
    try {
      const container = await mountApp('/admin/products', async (path, options = {}) => {
        if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
        if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
        if (path === '/api/admin/products' && (options.method ?? 'GET') === 'GET') {
          loads += 1
          return loads === 1 ? jsonResponse({ success: true, products: [product()] }) : staleList.promise
        }
        if (path === '/api/admin/products/1' && options.method === 'DELETE') return jsonResponse({ success: true })
        throw new Error(path)
      })
      await click(findButton(container, 'بارگذاری دوباره')); await settle()
      await click(findButton(container, 'حذف')); await settle()
      await resolveDeferred(staleList, jsonResponse({ success: true, products: [product({ name: 'resurrected' })] }))
      await settle()
      assert.doesNotMatch(container.textContent, /resurrected|لاته/)
    } finally { dom.window.confirm = originalConfirm }
  })

  for (const [number, failingPath, delayedPath] of [
    [9, '/api/admin/categories', '/api/admin/products'],
    [10, '/api/admin/products', '/api/admin/categories'],
  ]) {
    await context.test(`${number}) either dependency 401 owns the shared session`, async () => {
      const delayed = deferred()
      const container = await mountApp('/admin/products', async (path) => {
        if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
        if (path === failingPath) return jsonResponse({ success: false }, 401)
        if (path === delayedPath) return delayed.promise
        throw new Error(path)
      }, { settleAfterRender: false })
      await settle()
      await resolveDeferred(delayed, delayedPath.includes('categories')
        ? jsonResponse({
            success: true,
            categories: [categoryFixture({ name: 'stale-category' })],
          })
        : jsonResponse({ success: true, products: [product({ name: 'stale-product' })] }))
      await settle()
      assert.equal(dom.window.location.pathname, '/admin/login')
      assert.doesNotMatch(container.textContent, /stale-category|stale-product/)
    })
  }

  await context.test('11) StrictMode ignores the first non-cooperative Product owner', async () => {
    const stale = deferred()
    let productLoads = 0
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products') {
        productLoads += 1
        return productLoads === 1 ? stale.promise : jsonResponse({ success: true, products: [product({ name: 'strict-fresh' })] })
      }
      throw new Error(path)
    }, { strict: true, settleAfterRender: false })
    await settle()
    await resolveDeferred(stale, jsonResponse({ success: true, products: [product({ name: 'strict-stale' })] }))
    await settle()
    assert.match(container.textContent, /strict-fresh/)
    assert.doesNotMatch(container.textContent, /strict-stale/)
  })

  await context.test('12) Back/Forward route ownership rejects an older pending load', async () => {
    const stale = deferred()
    let productLoads = 0
    const container = await mountApp('/admin/products', async (path) => {
      if (path === '/api/admin/auth/me') return jsonResponse({ success: true, admin: { id: '1', username: 'admin' } })
      if (path === '/api/admin/categories') return jsonResponse({ success: true, categories: [categoryFixture()] })
      if (path === '/api/admin/products') {
        productLoads += 1
        return productLoads === 1 ? stale.promise : jsonResponse({ success: true, products: [product({ name: 'history-fresh' })] })
      }
      throw new Error(path)
    }, { settleAfterRender: false })
    await settle()
    await navigate('/admin/unknown')
    assert.equal(container.querySelector('.product-management'), null)
    await travelHistory('back')
    assert.match(container.textContent, /history-fresh/)
    await travelHistory('forward')
    assert.equal(container.querySelector('.product-management'), null)
    await travelHistory('back')
    await resolveDeferred(stale, jsonResponse({ success: true, products: [product({ name: 'history-stale' })] }))
    await settle()
    assert.match(container.textContent, /history-fresh/)
    assert.doesNotMatch(container.textContent, /history-stale/)
    assert.equal(productLoads, 3)
  })
})
