import { productImageStorage as defaultStorage } from '../storage/productImages.storage.js';
import { createAdminEntityImagesService } from './adminEntityImages.service.js';
import { parseProductId, selectProductById } from './adminProducts.service.js';
import {
  logProductImageCleanupFailure,
  removeProductImageAfterCommit,
} from './productImageCleanup.js';

let databaseModulePromise = null;

async function getDefaultExecutor() {
  databaseModulePromise ??= import('../config/db.js').catch((error) => {
    databaseModulePromise = null;
    throw error;
  });

  const { pool } = await databaseModulePromise;
  return pool;
}

function productNotFoundError() {
  const error = new Error('Product not found');
  error.code = 'PRODUCT_NOT_FOUND';
  error.status = 404;
  error.isSafeToDisplay = true;
  return error;
}

async function updateProductImagePath(connection, productId, imagePath) {
  if (imagePath === null) {
    await connection.execute(
      'UPDATE menu_items SET image_path = NULL WHERE id = ?',
      [productId],
    );
    return;
  }

  await connection.execute(
    'UPDATE menu_items SET image_path = ? WHERE id = ?',
    [imagePath, productId],
  );
}

export function createAdminProductImagesService({
  executor,
  storage = defaultStorage,
  logger = console,
} = {}) {
  return createAdminEntityImagesService({
    executor,
    getDefaultExecutor,
    storage,
    logger,
    parseId: parseProductId,
    selectById: selectProductById,
    updateImagePath: updateProductImagePath,
    createNotFoundError: productNotFoundError,
    removeAfterCommit: removeProductImageAfterCommit,
    logCleanupFailure: logProductImageCleanupFailure,
    operationName: 'Product image',
    unknownCommitCode: 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN',
    replaceReloadErrorMessage: 'Updated product image could not be loaded.',
    removeReloadErrorMessage: 'Product without image could not be loaded.',
  });
}

export const adminProductImagesService = createAdminProductImagesService();
