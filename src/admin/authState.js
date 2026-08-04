export const adminAuthStatus = Object.freeze({
  loading: 'loading',
  authenticated: 'authenticated',
  anonymous: 'anonymous',
  error: 'error',
})

export function getAdminRedirect(pathname, status) {
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/')

  if (!isAdminPath || status === adminAuthStatus.loading || status === adminAuthStatus.error) {
    return null
  }

  if (status === adminAuthStatus.anonymous && pathname !== '/admin/login') {
    return '/admin/login'
  }

  if (status === adminAuthStatus.authenticated && pathname === '/admin/login') {
    return '/admin'
  }

  return null
}

export async function bootstrapAdminAuth(api) {
  try {
    const admin = await api.getCurrentAdmin()
    return { status: adminAuthStatus.authenticated, admin, error: null }
  } catch (error) {
    if (error?.status === 401) {
      return { status: adminAuthStatus.anonymous, admin: null, error: null }
    }

    return { status: adminAuthStatus.error, admin: null, error }
  }
}
