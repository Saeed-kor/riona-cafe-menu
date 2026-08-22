export const adminAuthStatus = Object.freeze({
  checking: 'checking',
  authenticated: 'authenticated',
  unauthenticated: 'unauthenticated',
  error: 'error',
})

export const adminRouteKind = Object.freeze({
  public: 'public',
  canonical: 'canonical',
  login: 'login',
  protected: 'protected',
  notFound: 'not-found',
})

const canonicalAdminPaths = Object.freeze({
  '/admin/': '/admin',
  '/admin/login/': '/admin/login',
  '/admin/categories/': '/admin/categories',
})

export function resolveAdminRoute(pathname) {
  const canonicalPath = canonicalAdminPaths[pathname]

  if (canonicalPath) {
    return { kind: adminRouteKind.canonical, canonicalPath }
  }

  if (pathname === '/admin/login') {
    return { kind: adminRouteKind.login, canonicalPath: null }
  }

  if (pathname === '/admin' || pathname === '/admin/categories') {
    return { kind: adminRouteKind.protected, canonicalPath: null }
  }

  if (pathname.startsWith('/admin/')) {
    return { kind: adminRouteKind.notFound, canonicalPath: null }
  }

  return { kind: adminRouteKind.public, canonicalPath: null }
}

export function getAdminRedirect(pathname, status) {
  const route = resolveAdminRoute(pathname)
  const isKnownAdminRoute =
    route.kind === adminRouteKind.login || route.kind === adminRouteKind.protected

  if (
    !isKnownAdminRoute ||
    status === adminAuthStatus.checking ||
    status === adminAuthStatus.error
  ) {
    return null
  }

  if (status === adminAuthStatus.unauthenticated && route.kind === adminRouteKind.protected) {
    return '/admin/login'
  }

  if (status === adminAuthStatus.authenticated && route.kind === adminRouteKind.login) {
    return '/admin'
  }

  return null
}

function safeAuthError(error) {
  return Object.freeze({
    kind: typeof error?.kind === 'string' ? error.kind : 'unknown',
    status: Number.isInteger(error?.status) ? error.status : null,
  })
}

export async function bootstrapAdminAuth(api, { signal } = {}) {
  try {
    const admin = await api.getCurrentAdmin({ signal })
    return { status: adminAuthStatus.authenticated, admin, error: null }
  } catch (error) {
    if (error?.status === 401) {
      return { status: adminAuthStatus.unauthenticated, admin: null, error: null }
    }

    return { status: adminAuthStatus.error, admin: null, error: safeAuthError(error) }
  }
}
