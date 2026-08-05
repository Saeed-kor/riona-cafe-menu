import { Router } from 'express';

import { createRequireAdmin } from '../middleware/requireAdmin.js';
import { adminCategoriesService as defaultCategoriesService } from '../services/adminCategories.service.js';
import { adminAuthService as defaultAdminAuthService } from '../services/adminAuth.service.js';

function sendCategoryError(error, response, next) {
  if (
    error?.isSafeToDisplay === true &&
    [400, 404, 409].includes(error.status)
  ) {
    return response.status(error.status).json({
      success: false,
      message: error.message,
    });
  }

  return next(error);
}

export function createAdminCategoriesRouter({
  categoriesService = defaultCategoriesService,
  authService = defaultAdminAuthService,
} = {}) {
  const router = Router();

  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(createRequireAdmin(authService));

  router.get('/', async (_request, response, next) => {
    try {
      const categories = await categoriesService.list();
      return response.status(200).json({ success: true, categories });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    try {
      const category = await categoriesService.create(request.body);
      return response.status(201).json({ success: true, category });
    } catch (error) {
      return sendCategoryError(error, response, next);
    }
  });

  router.patch('/:categoryId', async (request, response, next) => {
    try {
      const category = await categoriesService.update(
        request.params.categoryId,
        request.body,
      );
      return response.status(200).json({ success: true, category });
    } catch (error) {
      return sendCategoryError(error, response, next);
    }
  });

  router.delete('/:categoryId', async (request, response, next) => {
    try {
      await categoriesService.remove(request.params.categoryId);
      return response.status(200).json({
        success: true,
        message: 'Category deleted',
      });
    } catch (error) {
      return sendCategoryError(error, response, next);
    }
  });

  return router;
}
