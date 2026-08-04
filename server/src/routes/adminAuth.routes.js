import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import {
  adminAuthService as defaultAdminAuthService,
  adminSessionTtlMilliseconds,
} from '../services/adminAuth.service.js';

export const adminSessionCookieName = 'riona_admin_session';

export function createAdminLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      success: false,
      message: 'Too many login attempts. Try again later.',
    },
  });
}

export function getAdminSessionCookieOptions(isProduction, includeLifetime = true) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/api/admin',
    ...(includeLifetime ? { maxAge: adminSessionTtlMilliseconds } : {}),
  };
}

function hasLoginCredentials(body) {
  return (
    body &&
    typeof body.username === 'string' &&
    body.username.trim() !== '' &&
    typeof body.password === 'string' &&
    body.password !== ''
  );
}

export function createAdminAuthRouter({
  authService = defaultAdminAuthService,
  isProduction = false,
  loginLimiter = createAdminLoginLimiter(),
} = {}) {
  const router = Router();
  const cookieOptions = getAdminSessionCookieOptions(isProduction);
  const clearCookieOptions = getAdminSessionCookieOptions(isProduction, false);

  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', loginLimiter, async (request, response, next) => {
    if (!hasLoginCredentials(request.body)) {
      return response.status(400).json({
        success: false,
        message: 'Username and password are required',
      });
    }

    try {
      const result = await authService.login(request.body.username, request.body.password);
      response.cookie(adminSessionCookieName, result.sessionToken, cookieOptions);

      return response.status(200).json({
        success: true,
        admin: result.admin,
      });
    } catch (error) {
      if (error?.code === 'INVALID_ADMIN_CREDENTIALS') {
        return response.status(401).json({
          success: false,
          message: 'Invalid username or password',
        });
      }

      return next(error);
    }
  });

  router.get('/me', async (request, response, next) => {
    try {
      const admin = await authService.getCurrentAdmin(request.cookies[adminSessionCookieName]);

      if (!admin) {
        response.clearCookie(adminSessionCookieName, clearCookieOptions);
        return response.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      return response.status(200).json({
        success: true,
        admin,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', async (request, response, next) => {
    try {
      await authService.logout(request.cookies[adminSessionCookieName]);
      response.clearCookie(adminSessionCookieName, clearCookieOptions);

      return response.status(200).json({
        success: true,
        message: 'Logged out',
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
