export function logProductImageCleanupFailure(logger, operation, error) {
  try {
    logger?.error?.('Product image cleanup failed.', {
      operation,
      name: error?.name ?? 'Error',
      code: error?.code ?? 'PRODUCT_IMAGE_CLEANUP_FAILED',
    });
  } catch {
    // Logging must never alter a durable database result.
  }
}

export async function removeProductImageAfterCommit(storage, publicPath, logger) {
  if (!publicPath) {
    return;
  }

  try {
    const removed = await storage.remove(publicPath);

    if (removed !== true) {
      logProductImageCleanupFailure(
        logger,
        'remove-previous-image',
        Object.assign(new Error('Managed image cleanup was refused.'), {
          code: 'PRODUCT_IMAGE_CLEANUP_REFUSED',
        }),
      );
    }
  } catch (error) {
    logProductImageCleanupFailure(logger, 'remove-previous-image', error);
  }
}
