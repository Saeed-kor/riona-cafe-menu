import { productImageStorage as defaultStorage } from '../storage/productImages.storage.js';
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

function combineOperationErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  const combinedError = new AggregateError(
    [primaryError, ...cleanupErrors],
    'Product image operation failed and cleanup was incomplete.',
    { cause: primaryError },
  );

  combinedError.code = cleanupErrors.some(
    (error) => error?.code === 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN',
  )
    ? 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN'
    : (primaryError?.code ?? 'PRODUCT_IMAGE_OPERATION_FAILED');
  return combinedError;
}

function ambiguousCommitOutcomeError() {
  const error = new Error('Product image commit outcome could not be determined.');
  error.code = 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN';
  return error;
}

async function closeConnection(connection, cleanupErrors, { discard = false } = {}) {
  if (!connection) {
    return false;
  }

  try {
    if (discard && typeof connection.destroy === 'function') {
      await connection.destroy();
      return true;
    }

    await connection.release();
  } catch (error) {
    cleanupErrors.push(error);
  }

  return false;
}

async function removeStagedImage(storage, publicPath, cleanupErrors) {
  try {
    const removed = await storage.remove(publicPath);

    if (removed !== true) {
      cleanupErrors.push(new Error('Staged product image cleanup was refused.'));
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
}

async function verifyReplaceCommitOutcome(
  databaseExecutor,
  productId,
  newImagePath,
  previousImagePath,
) {
  const verificationErrors = [];
  let connection = null;
  let outcome = 'unknown';

  try {
    connection = await databaseExecutor.getConnection();
    const product = await selectProductById(connection, productId);

    if (product?.imagePath === newImagePath) {
      outcome = 'committed';
    } else if (!product || product.imagePath === previousImagePath) {
      outcome = 'not-committed';
    }
  } catch (error) {
    verificationErrors.push(error);
  } finally {
    await closeConnection(connection, verificationErrors);
  }

  return { outcome, verificationErrors };
}

export function createAdminProductImagesService({
  executor,
  storage = defaultStorage,
  logger = console,
} = {}) {
  return Object.freeze({
    async replace(productIdValue, image) {
      const productId = parseProductId(productIdValue);
      const storedImage = await storage.store(image);
      let connection = null;
      let databaseExecutor = null;
      let updatedProduct = null;
      let previousImagePath = null;
      let primaryError = null;
      let transactionStarted = false;
      let commitAttempted = false;
      let commitSucceeded = false;
      let canVerifyCommit = false;
      const cleanupErrors = [];

      try {
        databaseExecutor = executor ?? (await getDefaultExecutor());
        connection = await databaseExecutor.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;
        const currentProduct = await selectProductById(connection, productId, {
          forUpdate: true,
        });

        if (!currentProduct) {
          throw productNotFoundError();
        }

        previousImagePath = currentProduct.imagePath;
        await connection.execute(
          'UPDATE menu_items SET image_path = ? WHERE id = ?',
          [storedImage.publicPath, productId],
        );
        updatedProduct = await selectProductById(connection, productId);

        if (!updatedProduct || updatedProduct.imagePath !== storedImage.publicPath) {
          throw new Error('Updated product image could not be loaded.');
        }

        commitAttempted = true;
        await connection.commit();
        commitSucceeded = true;
        transactionStarted = false;
      } catch (error) {
        primaryError = error;

        if (transactionStarted && !commitAttempted) {
          try {
            await connection.rollback();
            transactionStarted = false;
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
          }
        }
      } finally {
        if (connection) {
          if (commitSucceeded) {
            const releaseErrors = [];
            await closeConnection(connection, releaseErrors);

            for (const releaseError of releaseErrors) {
              logProductImageCleanupFailure(
                logger,
                'release-connection',
                releaseError,
              );
            }
          } else {
            canVerifyCommit = await closeConnection(connection, cleanupErrors, {
              discard: commitAttempted,
            });
          }
        }
      }

      if (primaryError) {
        if (!commitAttempted) {
          await removeStagedImage(storage, storedImage.publicPath, cleanupErrors);
        } else if (canVerifyCommit) {
          const { outcome, verificationErrors } = await verifyReplaceCommitOutcome(
            databaseExecutor,
            productId,
            storedImage.publicPath,
            previousImagePath,
          );
          cleanupErrors.push(...verificationErrors);

          if (outcome === 'committed') {
            await removeProductImageAfterCommit(storage, previousImagePath, logger);
          } else if (outcome === 'not-committed') {
            await removeStagedImage(storage, storedImage.publicPath, cleanupErrors);
          } else {
            cleanupErrors.push(ambiguousCommitOutcomeError());
          }
        } else {
          cleanupErrors.push(ambiguousCommitOutcomeError());
        }

        throw combineOperationErrors(primaryError, cleanupErrors);
      }

      await removeProductImageAfterCommit(storage, previousImagePath, logger);
      return updatedProduct;
    },

    async remove(productIdValue) {
      const productId = parseProductId(productIdValue);
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      let connection = null;
      let updatedProduct = null;
      let previousImagePath = null;
      let primaryError = null;
      let transactionStarted = false;
      let commitAttempted = false;
      let commitSucceeded = false;
      const cleanupErrors = [];

      try {
        connection = await databaseExecutor.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;
        const currentProduct = await selectProductById(connection, productId, {
          forUpdate: true,
        });

        if (!currentProduct) {
          throw productNotFoundError();
        }

        previousImagePath = currentProduct.imagePath;

        if (previousImagePath) {
          await connection.execute(
            'UPDATE menu_items SET image_path = NULL WHERE id = ?',
            [productId],
          );
          updatedProduct = await selectProductById(connection, productId);

          if (!updatedProduct || updatedProduct.imagePath !== null) {
            throw new Error('Product without image could not be loaded.');
          }
        } else {
          updatedProduct = currentProduct;
        }

        commitAttempted = true;
        await connection.commit();
        commitSucceeded = true;
        transactionStarted = false;
      } catch (error) {
        primaryError = error;

        if (transactionStarted && !commitAttempted) {
          try {
            await connection.rollback();
            transactionStarted = false;
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
          }
        }
      } finally {
        if (connection) {
          if (commitSucceeded) {
            const releaseErrors = [];
            await closeConnection(connection, releaseErrors);

            for (const releaseError of releaseErrors) {
              logProductImageCleanupFailure(
                logger,
                'release-connection',
                releaseError,
              );
            }
          } else {
            await closeConnection(connection, cleanupErrors, {
              discard: commitAttempted,
            });
          }
        }
      }

      if (primaryError) {
        if (commitAttempted) {
          cleanupErrors.push(ambiguousCommitOutcomeError());
        }

        throw combineOperationErrors(primaryError, cleanupErrors);
      }

      await removeProductImageAfterCommit(storage, previousImagePath, logger);
      return updatedProduct;
    },
  });
}

export const adminProductImagesService = createAdminProductImagesService();
