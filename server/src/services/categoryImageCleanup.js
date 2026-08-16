import {
  logManagedImageCleanupFailure,
  removeManagedImageAfterCommit,
} from './productImageCleanup.js';

const categoryCleanupOptions = Object.freeze({
  entityName: 'Category image',
  fallbackCode: 'CATEGORY_IMAGE_CLEANUP_FAILED',
  refusedCode: 'CATEGORY_IMAGE_CLEANUP_REFUSED',
});

export function logCategoryImageCleanupFailure(logger, operation, error) {
  return logManagedImageCleanupFailure(
    logger,
    operation,
    error,
    categoryCleanupOptions,
  );
}

export function removeCategoryImageAfterCommit(storage, publicPath, logger) {
  return removeManagedImageAfterCommit(
    storage,
    publicPath,
    logger,
    categoryCleanupOptions,
  );
}
