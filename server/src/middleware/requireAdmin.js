import { adminSessionCookieName } from '../routes/adminAuth.routes.js';
import { adminAuthService as defaultAdminAuthService } from '../services/adminAuth.service.js';

export function createRequireAdmin(authService = defaultAdminAuthService) {
  return async function requireAdmin(request, response, next) {
    try {
      const sessionToken = request.cookies?.[adminSessionCookieName];
      const admin = await authService.getCurrentAdmin(sessionToken);

      if (!admin) {
        return response.status(401).json({
          success: false,
          message: 'Authentication required',
        });
      }

      response.locals.admin = admin;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
