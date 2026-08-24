import { Router } from 'express';
import multer from 'multer';

import { maximumProductImageBytes } from '../config/productImages.js';
import { createRequireAdmin } from '../middleware/requireAdmin.js';
import { adminAuthService as defaultAdminAuthService } from '../services/adminAuth.service.js';
import { adminProductsService as defaultProductsService } from '../services/adminProducts.service.js';
import {
  createProductImageError,
  validateProductImageFile,
} from '../services/productImageValidation.js';

const maximumProductMetadataBytes = 16 * 1024;
const multipartCreateParser = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: {
    fileSize: maximumProductImageBytes + 1,
    fieldSize: maximumProductMetadataBytes,
    fieldNameSize: 100,
    files: 1,
    fields: 1,
    // Busboy raises the parts event at the configured count, so three permits
    // exactly the required metadata + image pair and rejects a third part.
    parts: 3,
  },
}).fields([
  { name: 'metadata', maxCount: 1 },
  { name: 'image', maxCount: 1 },
]);

function createMultipartError(message, code = 'INVALID_PRODUCT_CREATE_UPLOAD', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.isSafeToDisplay = true;
  return error;
}

function parseMultipartCreate(request, response, next) {
  if (!request.is('multipart/form-data')) {
    return sendProductError(
      createMultipartError(
        'Product creation requires multipart metadata and one image',
        'PRODUCT_CREATE_MULTIPART_REQUIRED',
        415,
      ),
      response,
      next,
    );
  }

  return multipartCreateParser(request, response, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return sendProductError(
        createProductImageError(
          'Product image exceeds the 5 MiB limit',
          'PRODUCT_IMAGE_TOO_LARGE',
          413,
        ),
        response,
        next,
      );
    }

    if (error) {
      return sendProductError(
        createMultipartError('Exactly one metadata field and one product image are required'),
        response,
        next,
      );
    }

    const bodyFields = Object.keys(request.body ?? {});
    const fileFields = Object.keys(request.files ?? {});
    const images = request.files?.image;

    if (
      bodyFields.length !== 1 ||
      bodyFields[0] !== 'metadata' ||
      typeof request.body.metadata !== 'string' ||
      fileFields.length !== 1 ||
      fileFields[0] !== 'image' ||
      !Array.isArray(images) ||
      images.length !== 1
    ) {
      return sendProductError(
        createMultipartError('Exactly one metadata field and one product image are required'),
        response,
        next,
      );
    }

    return next();
  });
}

function parseMetadata(request, response, next) {
  try {
    const metadata = JSON.parse(request.body.metadata);

    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      (Object.getPrototypeOf(metadata) !== Object.prototype &&
        Object.getPrototypeOf(metadata) !== null)
    ) {
      throw createMultipartError('Product metadata must be a JSON object');
    }

    request.productMetadata = metadata;
    return next();
  } catch (error) {
    return sendProductError(
      error?.isSafeToDisplay
        ? error
        : createMultipartError('Product metadata contains invalid JSON'),
      response,
      next,
    );
  }
}

function sendProductError(error, response, next) {
  if (
    error?.isSafeToDisplay === true &&
    [400, 404, 409, 413, 415].includes(error.status)
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

  router.post(
    '/',
    parseMultipartCreate,
    parseMetadata,
    async (request, response, next) => {
      try {
        const image = await validateProductImageFile(request.files.image[0]);
        const product = await productsService.create(request.productMetadata, image);
        return response.status(201).json({ success: true, product });
      } catch (error) {
        return sendProductError(error, response, next);
      }
    },
  );

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
