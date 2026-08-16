import { Router } from 'express';
import multer from 'multer';

import { maximumProductImageBytes } from '../config/productImages.js';
import { createRequireAdmin } from '../middleware/requireAdmin.js';
import { notFound } from '../middleware/notFound.js';
import { adminAuthService as defaultAdminAuthService } from '../services/adminAuth.service.js';
import { adminCategoryImagesService as defaultCategoryImagesService } from '../services/adminCategoryImages.service.js';
import { parseCategoryId } from '../services/adminCategories.service.js';
import {
  createManagedImageError,
  validateCategoryImageFile,
} from '../services/productImageValidation.js';

const multipartParser = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: {
    fileSize: maximumProductImageBytes + 1,
    files: 1,
    fields: 0,
    parts: 2,
  },
}).single('image');

function createCategoryUploadError(message, code, status = 400) {
  return createManagedImageError(message, code, status);
}

function sendCategoryImageError(error, response, next) {
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

function parseCategoryImage(request, response, next) {
  multipartParser(request, response, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return sendCategoryImageError(
        createCategoryUploadError(
          'Category image exceeds the 5 MiB limit',
          'CATEGORY_IMAGE_TOO_LARGE',
          413,
        ),
        response,
        next,
      );
    }

    return sendCategoryImageError(
      createCategoryUploadError(
        'Exactly one category image field is required',
        'INVALID_CATEGORY_IMAGE_UPLOAD',
      ),
      response,
      next,
    );
  });
}

function validateCategoryId(request, response, next) {
  try {
    request.params.categoryId = parseCategoryId(request.params.categoryId);
    return next();
  } catch (error) {
    return sendCategoryImageError(error, response, next);
  }
}

function requireCategory(categoryImagesService) {
  return async (request, response, next) => {
    try {
      await categoryImagesService.assertExists(request.params.categoryId);
      return next();
    } catch (error) {
      return sendCategoryImageError(error, response, next);
    }
  };
}

export function createAdminCategoryImagesRouter({
  categoryImagesService = defaultCategoryImagesService,
  authService = defaultAdminAuthService,
} = {}) {
  const router = Router();
  const imageRoute = '/:categoryId/image';

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
    validateCategoryId,
    parseCategoryImage,
    requireCategory(categoryImagesService),
    async (request, response, next) => {
      try {
        const image = await validateCategoryImageFile(request.file);
        const category = await categoryImagesService.replace(
          request.params.categoryId,
          image,
        );
        return response.status(200).json({ success: true, category });
      } catch (error) {
        return sendCategoryImageError(error, response, next);
      }
    },
  );

  router.delete(
    imageRoute,
    validateCategoryId,
    async (request, response, next) => {
      try {
        const category = await categoryImagesService.remove(
          request.params.categoryId,
        );
        return response.status(200).json({ success: true, category });
      } catch (error) {
        return sendCategoryImageError(error, response, next);
      }
    },
  );

  router.all(imageRoute, notFound);

  return router;
}
