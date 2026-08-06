import { Router } from 'express';

import { createRequireAdmin } from '../middleware/requireAdmin.js';
import { adminAuthService as defaultAdminAuthService } from '../services/adminAuth.service.js';
import { adminProductsService as defaultProductsService } from '../services/adminProducts.service.js';

function sendProductError(error, response, next) {
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

export function createAdminProductsRouter({
  productsService = defaultProductsService,
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
      const products = await productsService.list();
      return response.status(200).json({ success: true, products });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    try {
      const product = await productsService.create(request.body);
      return response.status(201).json({ success: true, product });
    } catch (error) {
      return sendProductError(error, response, next);
    }
  });

  router.patch('/:productId', async (request, response, next) => {
    try {
      const product = await productsService.update(
        request.params.productId,
        request.body,
      );
      return response.status(200).json({ success: true, product });
    } catch (error) {
      return sendProductError(error, response, next);
    }
  });

  router.delete('/:productId', async (request, response, next) => {
    try {
      await productsService.remove(request.params.productId);
      return response.status(200).json({
        success: true,
        message: 'Product deleted',
      });
    } catch (error) {
      return sendProductError(error, response, next);
    }
  });

  return router;
}
