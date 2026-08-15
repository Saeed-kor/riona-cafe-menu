import { Router } from 'express';
import multer from 'multer';

import { maximumProductImageBytes } from '../config/productImages.js';
import { createRequireAdmin } from '../middleware/requireAdmin.js';
import { notFound } from '../middleware/notFound.js';
import { adminAuthService as defaultAdminAuthService } from '../services/adminAuth.service.js';
import { adminProductImagesService as defaultProductImagesService } from '../services/adminProductImages.service.js';
import { parseProductId } from '../services/adminProducts.service.js';
import {
  createProductImageError,
  validateProductImageFile,
} from '../services/productImageValidation.js';

const multipartParser = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: {
    // Busboy emits its limit event when this exact byte count is reached.
    // Validation below enforces the real inclusive 5 MiB application limit.
    fileSize: maximumProductImageBytes + 1,
    files: 1,
    fields: 0,
    parts: 2,
  },
}).single('image');

function parseProductImage(request, response, next) {
  multipartParser(request, response, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return sendProductImageError(
        createProductImageError(
          'Product image exceeds the 5 MiB limit',
          'PRODUCT_IMAGE_TOO_LARGE',
          413,
        ),
        response,
        next,
      );
    }

    return sendProductImageError(
      createProductImageError(
        'Exactly one product image field is required',
        'INVALID_PRODUCT_IMAGE_UPLOAD',
      ),
      response,
      next,
    );
  });
}

function sendProductImageError(error, response, next) {
  if (
    error?.isSafeToDisplay === true &&
    [400, 404, 413].includes(error.status)
  ) {
    return response.status(error.status).json({
      success: false,
      message: error.message,
    });
  }

  return next(error);
}

function validateProductId(request, response, next) {
  try {
    request.params.productId = parseProductId(request.params.productId);
    return next();
  } catch (error) {
    return sendProductImageError(error, response, next);
  }
}

export function createAdminProductImagesRouter({
  productImagesService = defaultProductImagesService,
  authService = defaultAdminAuthService,
} = {}) {
  const router = Router();
  const imageRoute = '/:productId/image';

  router.all(
    imageRoute,
    (_request, response, next) => {
      response.set('Cache-Control', 'no-store');
      next();
    },
    createRequireAdmin(authService),
  );

  router.put(
    imageRoute,
    validateProductId,
    parseProductImage,
    async (request, response, next) => {
      try {
        const image = await validateProductImageFile(request.file);
        const product = await productImagesService.replace(
          request.params.productId,
          image,
        );
        return response.status(200).json({ success: true, product });
      } catch (error) {
        return sendProductImageError(error, response, next);
      }
    },
  );

  router.delete(
    imageRoute,
    validateProductId,
    async (request, response, next) => {
      try {
        const product = await productImagesService.remove(request.params.productId);
        return response.status(200).json({ success: true, product });
      } catch (error) {
        return sendProductImageError(error, response, next);
      }
    },
  );

  router.all(imageRoute, notFound);

  return router;
}
