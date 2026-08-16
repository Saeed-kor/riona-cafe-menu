export function logManagedImageCleanupFailure(
  logger,
  operation,
  error,
  { entityName = 'Image', fallbackCode = 'IMAGE_CLEANUP_FAILED' } = {},
) {
  try {
    logger?.error?.(`${entityName} cleanup failed.`, {
      operation,
      name: error?.name ?? 'Error',
      code: error?.code ?? fallbackCode,
    });
  } catch {
    // Logging must never alter a durable database result.
  }
}

export async function removeManagedImageAfterCommit(
  storage,
  publicPath,
  logger,
  options,
) {
  if (!publicPath) {
    return;
  }

  try {
    const removed = await storage.remove(publicPath);

    if (removed !== true) {
      logManagedImageCleanupFailure(
        logger,
        'remove-previous-image',
        Object.assign(new Error('Managed image cleanup was refused.'), {
          code: options?.refusedCode ?? 'IMAGE_CLEANUP_REFUSED',
        }),
        options,
      );
    }
  } catch (error) {
    logManagedImageCleanupFailure(
      logger,
      'remove-previous-image',
      error,
      options,
    );
  }
}

const productCleanupOptions = Object.freeze({
  entityName: 'Product image',
  fallbackCode: 'PRODUCT_IMAGE_CLEANUP_FAILED',
  refusedCode: 'PRODUCT_IMAGE_CLEANUP_REFUSED',
});

export function logProductImageCleanupFailure(logger, operation, error) {
  return logManagedImageCleanupFailure(
    logger,
    operation,
    error,
    productCleanupOptions,
  );
}

export function removeProductImageAfterCommit(storage, publicPath, logger) {
  return removeManagedImageAfterCommit(
    storage,
    publicPath,
    logger,
    productCleanupOptions,
  );
}
