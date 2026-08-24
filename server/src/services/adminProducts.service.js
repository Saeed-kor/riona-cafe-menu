import { productImageStorage as defaultProductImageStorage } from '../storage/productImages.storage.js';
import {
  logProductImageCleanupFailure,
  removeProductImageAfterCommit,
} from './productImageCleanup.js';

export const maximumProductNameCharacters = 150;
export const maximumProductDescriptionBytes = 65_535;

const maximumUnsignedBigInt = 18_446_744_073_709_551_615n;
const maximumUnsignedInt = 4_294_967_295;
const allowedProductFields = new Set([
  'categoryId',
  'name',
  'description',
  'price',
  'sortOrder',
  'isAvailable',
  'isVisible',
]);
let databaseModulePromise = null;

async function getDefaultExecutor() {
  databaseModulePromise ??= import('../config/db.js').catch((error) => {
    databaseModulePromise = null;
    throw error;
  });

  const { pool } = await databaseModulePromise;
  return pool;
}

function createProductError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.isSafeToDisplay = true;
  return error;
}

function assertBodyObject(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null)
  ) {
    throw createProductError('Product body is invalid', 'INVALID_PRODUCT_BODY', 400);
  }

  if (Object.keys(body).some((field) => !allowedProductFields.has(field))) {
    throw createProductError(
      'Product body contains unknown fields',
      'INVALID_PRODUCT_BODY',
      400,
    );
  }
}

function normalizeProductName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createProductError('Product name is required', 'INVALID_PRODUCT_NAME', 400);
  }

  const name = value.trim();

  if (Array.from(name).length > maximumProductNameCharacters) {
    throw createProductError(
      `Product name must be ${maximumProductNameCharacters} characters or fewer`,
      'INVALID_PRODUCT_NAME',
      400,
    );
  }

  return name;
}

function normalizeDescription(value) {
  if (value === null) {
    return null;
  }

  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > maximumProductDescriptionBytes
  ) {
    throw createProductError(
      `Product description must be null or at most ${maximumProductDescriptionBytes} UTF-8 bytes`,
      'INVALID_PRODUCT_DESCRIPTION',
      400,
    );
  }

  return value;
}

function normalizeCategoryId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw createProductError(
        'categoryId must be a canonical positive integer',
        'INVALID_PRODUCT_CATEGORY',
        400,
      );
    }

    return String(value);
  }

  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) {
    throw createProductError(
      'categoryId must be a canonical positive integer',
      'INVALID_PRODUCT_CATEGORY',
      400,
    );
  }

  if (BigInt(value) > maximumUnsignedBigInt) {
    throw createProductError(
      'categoryId must be a canonical positive integer',
      'INVALID_PRODUCT_CATEGORY',
      400,
    );
  }

  return value;
}

function normalizePrice(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw createProductError(
      'price must be a non-negative integer string',
      'INVALID_PRODUCT_PRICE',
      400,
    );
  }

  if (BigInt(value) > maximumUnsignedBigInt) {
    throw createProductError(
      'price exceeds the supported range',
      'INVALID_PRODUCT_PRICE',
      400,
    );
  }

  return value;
}

function normalizeSortOrder(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximumUnsignedInt) {
    throw createProductError(
      'sortOrder must be a non-negative integer',
      'INVALID_PRODUCT_SORT_ORDER',
      400,
    );
  }

  return value;
}

function normalizeBoolean(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw createProductError(
      `${fieldName} must be a boolean`,
      `INVALID_PRODUCT_${fieldName === 'isVisible' ? 'VISIBILITY' : 'AVAILABILITY'}`,
      400,
    );
  }

  return value;
}

export function parseProductId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) {
    throw createProductError('Product id is invalid', 'INVALID_PRODUCT_ID', 400);
  }

  const id = BigInt(value);

  if (id > maximumUnsignedBigInt) {
    throw createProductError('Product id is invalid', 'INVALID_PRODUCT_ID', 400);
  }

  return id.toString();
}

export function validateNewProduct(body) {
  assertBodyObject(body);

  return {
    categoryId: normalizeCategoryId(body.categoryId),
    name: normalizeProductName(body.name),
    description: body.description === undefined ? null : normalizeDescription(body.description),
    price: normalizePrice(body.price),
    sortOrder: body.sortOrder === undefined ? 0 : normalizeSortOrder(body.sortOrder),
    isAvailable:
      body.isAvailable === undefined
        ? true
        : normalizeBoolean(body.isAvailable, 'isAvailable'),
    isVisible:
      body.isVisible === undefined ? true : normalizeBoolean(body.isVisible, 'isVisible'),
  };
}

export function validateProductChanges(body) {
  assertBodyObject(body);
  const fields = Object.keys(body);

  if (fields.length === 0) {
    throw createProductError(
      'At least one product field is required',
      'EMPTY_PRODUCT_UPDATE',
      400,
    );
  }

  return {
    ...(fields.includes('categoryId')
      ? { categoryId: normalizeCategoryId(body.categoryId) }
      : {}),
    ...(fields.includes('name') ? { name: normalizeProductName(body.name) } : {}),
    ...(fields.includes('description')
      ? { description: normalizeDescription(body.description) }
      : {}),
    ...(fields.includes('price') ? { price: normalizePrice(body.price) } : {}),
    ...(fields.includes('sortOrder')
      ? { sortOrder: normalizeSortOrder(body.sortOrder) }
      : {}),
    ...(fields.includes('isAvailable')
      ? { isAvailable: normalizeBoolean(body.isAvailable, 'isAvailable') }
      : {}),
    ...(fields.includes('isVisible')
      ? { isVisible: normalizeBoolean(body.isVisible, 'isVisible') }
      : {}),
  };
}

export function toProduct(row, { allowUnmanagedImage = false } = {}) {
  if (
    !allowUnmanagedImage &&
    (typeof row.imagePath !== 'string' ||
      !/^\/uploads\/products\/[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(row.imagePath))
  ) {
    throw new Error('Product image path is invalid.');
  }

  return {
    id: String(row.id),
    categoryId: String(row.categoryId),
    categoryName: row.categoryName,
    name: row.name,
    description: row.description,
    price: String(row.price),
    imagePath: row.imagePath,
    sortOrder: Number(row.sortOrder),
    isAvailable: Number(row.isAvailable) === 1,
    isVisible: Number(row.isVisible) === 1,
  };
}

function invalidCategoryError() {
  return createProductError(
    'Category does not exist',
    'INVALID_PRODUCT_CATEGORY',
    400,
  );
}

function productNotFoundError() {
  return createProductError('Product not found', 'PRODUCT_NOT_FOUND', 404);
}

function isMissingReferencedRowError(error) {
  return error?.code === 'ER_NO_REFERENCED_ROW_2' || Number(error?.errno) === 1452;
}

async function categoryExists(executor, categoryId) {
  const [rows] = await executor.execute(
    `SELECT id
       FROM categories
      WHERE id = ?
      LIMIT 1`,
    [categoryId],
  );

  return rows.length > 0;
}

async function assertCategoryExists(executor, categoryId) {
  if (!(await categoryExists(executor, categoryId))) {
    throw invalidCategoryError();
  }
}

export async function selectProductById(executor, productId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT CAST(menuItems.id AS CHAR) AS id,
            CAST(menuItems.category_id AS CHAR) AS categoryId,
            categories.name AS categoryName, menuItems.name,
            menuItems.description, CAST(menuItems.price AS CHAR) AS price,
            menuItems.image_path AS imagePath,
            menuItems.display_order AS sortOrder,
            menuItems.is_available AS isAvailable,
            menuItems.is_visible AS isVisible
       FROM menu_items AS menuItems
       JOIN categories ON categories.id = menuItems.category_id
      WHERE menuItems.id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [productId],
  );

  return rows[0] ? toProduct(rows[0], { allowUnmanagedImage: forUpdate }) : null;
}

async function selectLastInsertedProductId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id',
  );
  const id = rows[0]?.id;

  if (
    typeof id !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(id) ||
    BigInt(id) > maximumUnsignedBigInt
  ) {
    throw new Error('Created product id could not be loaded.');
  }

  return id;
}

function combineCreateErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  const combinedError = new AggregateError(
    [primaryError, ...cleanupErrors],
    'Product creation failed and cleanup was incomplete.',
    { cause: primaryError },
  );

  combinedError.code = cleanupErrors.some(
    (error) => error?.code === 'PRODUCT_CREATE_COMMIT_OUTCOME_UNKNOWN',
  )
    ? 'PRODUCT_CREATE_COMMIT_OUTCOME_UNKNOWN'
    : (primaryError?.code ?? 'PRODUCT_CREATE_FAILED');
  return combinedError;
}

function combineDeleteErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  const combinedError = new AggregateError(
    [primaryError, ...cleanupErrors],
    'Product deletion failed and cleanup was incomplete.',
    { cause: primaryError },
  );

  combinedError.code = cleanupErrors.some(
    (error) => error?.code === 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN',
  )
    ? 'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN'
    : (primaryError?.code ?? 'PRODUCT_DELETE_FAILED');
  return combinedError;
}

function ambiguousCommitOutcomeError(operation, code) {
  const error = new Error(`Product ${operation} commit outcome could not be determined.`);
  error.code = code;
  return error;
}

async function closeDeleteConnection(
  connection,
  cleanupErrors,
  { discard = false } = {},
) {
  if (!connection) {
    return false;
  }

  try {
    if (discard && typeof connection.destroy === 'function') {
      await connection.destroy();
      return true;
    } else {
      await connection.release();
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  return false;
}

async function removeStagedProductImage(storage, imagePath, cleanupErrors) {
  try {
    const removed = await storage.remove(imagePath);

    if (removed !== true) {
      cleanupErrors.push(new Error('Staged product image cleanup was refused.'));
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
}

async function verifyCreateCommitOutcome(databaseExecutor, productId, imagePath) {
  const verificationErrors = [];
  let connection = null;
  let outcome = 'unknown';
  let product = null;

  if (!productId) {
    return { outcome, product, verificationErrors };
  }

  try {
    connection = await databaseExecutor.getConnection();
    product = await selectProductById(connection, productId);

    if (!product) {
      outcome = 'not-committed';
    } else if (product.imagePath === imagePath) {
      outcome = 'committed';
    }
  } catch (error) {
    verificationErrors.push(error);
  } finally {
    await closeDeleteConnection(connection, verificationErrors);
  }

  return { outcome, product, verificationErrors };
}

async function verifyDeleteCommitOutcome(databaseExecutor, productId, previousImagePath) {
  const verificationErrors = [];
  let connection = null;
  let outcome = 'unknown';

  try {
    connection = await databaseExecutor.getConnection();
    const product = await selectProductById(connection, productId);

    if (!product) {
      outcome = 'committed';
    } else if (product.imagePath === previousImagePath) {
      outcome = 'not-committed';
    }
  } catch (error) {
    verificationErrors.push(error);
  } finally {
    await closeDeleteConnection(connection, verificationErrors);
  }

  return { outcome, verificationErrors };
}

export function createAdminProductsService({
  executor,
  productImageStorage = defaultProductImageStorage,
  logger = console,
} = {}) {
  return Object.freeze({
    async list() {
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      const [rows] = await databaseExecutor.execute(
        `SELECT CAST(menuItems.id AS CHAR) AS id,
                CAST(menuItems.category_id AS CHAR) AS categoryId,
                categories.name AS categoryName, menuItems.name,
                menuItems.description, CAST(menuItems.price AS CHAR) AS price,
                menuItems.image_path AS imagePath,
                menuItems.display_order AS sortOrder,
                menuItems.is_available AS isAvailable,
                menuItems.is_visible AS isVisible
           FROM menu_items AS menuItems
           JOIN categories ON categories.id = menuItems.category_id
          ORDER BY menuItems.display_order ASC, menuItems.id ASC`,
      );

      return rows.map(toProduct);
    },

    async create(body, image) {
      if (!image || typeof image !== 'object') {
        throw createProductError(
          'Product image is required',
          'PRODUCT_IMAGE_REQUIRED',
          400,
        );
      }

      const storedImage = await productImageStorage.store(image);
      let product;
      const cleanupErrors = [];

      try {
        product = validateNewProduct(body);
      } catch (error) {
        await removeStagedProductImage(
          productImageStorage,
          storedImage.publicPath,
          cleanupErrors,
        );
        throw combineCreateErrors(error, cleanupErrors);
      }

      let databaseExecutor = null;
      let connection = null;
      let createdProduct = null;
      let createdProductId = null;
      let primaryError = null;
      let transactionStarted = false;
      let rollbackFailed = false;
      let commitAttempted = false;
      let commitSucceeded = false;
      let canVerifyCommit = false;

      try {
        databaseExecutor = executor ?? (await getDefaultExecutor());
        connection = await databaseExecutor.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;
        await assertCategoryExists(connection, product.categoryId);
        await connection.execute(
          `INSERT INTO menu_items
             (category_id, name, description, price, image_path,
              display_order, is_available, is_visible)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            product.categoryId,
            product.name,
            product.description,
            product.price,
            storedImage.publicPath,
            product.sortOrder,
            Number(product.isAvailable),
            Number(product.isVisible),
          ],
        );
        createdProductId = await selectLastInsertedProductId(connection);
        createdProduct = await selectProductById(connection, createdProductId);

        if (!createdProduct || createdProduct.imagePath !== storedImage.publicPath) {
          throw new Error('Created product could not be loaded.');
        }

        commitAttempted = true;
        await connection.commit();
        commitSucceeded = true;
        transactionStarted = false;
      } catch (error) {
        primaryError = error;

        if (isMissingReferencedRowError(error)) {
          primaryError = invalidCategoryError();
        }

        if (transactionStarted && !commitAttempted) {
          try {
            await connection.rollback();
            transactionStarted = false;
          } catch (rollbackError) {
            rollbackFailed = true;
            cleanupErrors.push(rollbackError);
          }
        }
      } finally {
        if (connection) {
          if (commitSucceeded) {
            const releaseErrors = [];
            await closeDeleteConnection(connection, releaseErrors);

            for (const releaseError of releaseErrors) {
              logProductImageCleanupFailure(logger, 'release-connection', releaseError);
            }
          } else {
            canVerifyCommit = await closeDeleteConnection(connection, cleanupErrors, {
              discard: commitAttempted || rollbackFailed,
            });
          }
        }
      }

      if (primaryError) {
        if (!commitAttempted) {
          await removeStagedProductImage(
            productImageStorage,
            storedImage.publicPath,
            cleanupErrors,
          );
        } else if (canVerifyCommit) {
          const verification = await verifyCreateCommitOutcome(
            databaseExecutor,
            createdProductId,
            storedImage.publicPath,
          );
          cleanupErrors.push(...verification.verificationErrors);

          if (verification.outcome === 'committed') {
            logProductImageCleanupFailure(logger, 'commit-acknowledgement', primaryError);

            for (const verificationError of cleanupErrors) {
              logProductImageCleanupFailure(
                logger,
                'verification-connection',
                verificationError,
              );
            }

            return verification.product;
          }

          if (verification.outcome === 'not-committed') {
            await removeStagedProductImage(
              productImageStorage,
              storedImage.publicPath,
              cleanupErrors,
            );
          } else {
            cleanupErrors.push(
              ambiguousCommitOutcomeError(
                'creation',
                'PRODUCT_CREATE_COMMIT_OUTCOME_UNKNOWN',
              ),
            );
          }
        } else {
          cleanupErrors.push(
            ambiguousCommitOutcomeError(
              'creation',
              'PRODUCT_CREATE_COMMIT_OUTCOME_UNKNOWN',
            ),
          );
        }

        throw combineCreateErrors(primaryError, cleanupErrors);
      }

      return createdProduct;
    },

    async update(productIdValue, body) {
      const productId = parseProductId(productIdValue);
      const changes = validateProductChanges(body);
      const databaseExecutor = executor ?? (await getDefaultExecutor());

      if (changes.categoryId !== undefined) {
        await assertCategoryExists(databaseExecutor, changes.categoryId);
      }

      const assignments = [];
      const values = [];

      if (changes.categoryId !== undefined) {
        assignments.push('category_id = ?');
        values.push(changes.categoryId);
      }

      if (changes.name !== undefined) {
        assignments.push('name = ?');
        values.push(changes.name);
      }

      if (changes.description !== undefined) {
        assignments.push('description = ?');
        values.push(changes.description);
      }

      if (changes.price !== undefined) {
        assignments.push('price = ?');
        values.push(changes.price);
      }

      if (changes.sortOrder !== undefined) {
        assignments.push('display_order = ?');
        values.push(changes.sortOrder);
      }

      if (changes.isAvailable !== undefined) {
        assignments.push('is_available = ?');
        values.push(Number(changes.isAvailable));
      }

      if (changes.isVisible !== undefined) {
        assignments.push('is_visible = ?');
        values.push(Number(changes.isVisible));
      }

      try {
        await databaseExecutor.execute(
          `UPDATE menu_items
              SET ${assignments.join(', ')}
            WHERE id = ?`,
          [...values, productId],
        );
      } catch (error) {
        if (isMissingReferencedRowError(error)) {
          throw invalidCategoryError();
        }

        throw error;
      }

      const updatedProduct = await selectProductById(databaseExecutor, productId);

      if (!updatedProduct) {
        throw productNotFoundError();
      }

      return updatedProduct;
    },

    async remove(productIdValue) {
      const productId = parseProductId(productIdValue);
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      let connection = null;
      let previousImagePath = null;
      let primaryError = null;
      let transactionStarted = false;
      let rollbackFailed = false;
      let commitAttempted = false;
      let commitSucceeded = false;
      let canVerifyCommit = false;
      let verifiedCommitted = false;
      const cleanupErrors = [];

      try {
        connection = await databaseExecutor.getConnection();
        await connection.beginTransaction();
        transactionStarted = true;
        const product = await selectProductById(connection, productId, {
          forUpdate: true,
        });

        if (!product) {
          throw productNotFoundError();
        }

        previousImagePath = product.imagePath;
        const [result] = await connection.execute(
          'DELETE FROM menu_items WHERE id = ?',
          [productId],
        );

        if (Number(result.affectedRows) === 0) {
          throw productNotFoundError();
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
            rollbackFailed = true;
            cleanupErrors.push(rollbackError);
          }
        }
      } finally {
        if (connection) {
          if (commitSucceeded) {
            const releaseErrors = [];
            await closeDeleteConnection(connection, releaseErrors);

            for (const releaseError of releaseErrors) {
              logProductImageCleanupFailure(
                logger,
                'release-connection',
                releaseError,
              );
            }
          } else {
            canVerifyCommit = await closeDeleteConnection(connection, cleanupErrors, {
              discard: commitAttempted || rollbackFailed,
            });
          }
        }
      }

      if (primaryError) {
        if (commitAttempted) {
          if (canVerifyCommit) {
            const verification = await verifyDeleteCommitOutcome(
              databaseExecutor,
              productId,
              previousImagePath,
            );
            cleanupErrors.push(...verification.verificationErrors);

            if (verification.outcome === 'committed') {
              verifiedCommitted = true;
            } else if (verification.outcome === 'unknown') {
              cleanupErrors.push(
                ambiguousCommitOutcomeError(
                  'deletion',
                  'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN',
                ),
              );
            }
          } else {
            cleanupErrors.push(
              ambiguousCommitOutcomeError(
                'deletion',
                'PRODUCT_IMAGE_COMMIT_OUTCOME_UNKNOWN',
              ),
            );
          }
        }

        if (!verifiedCommitted) {
          throw combineDeleteErrors(primaryError, cleanupErrors);
        }

        logProductImageCleanupFailure(logger, 'commit-acknowledgement', primaryError);

        for (const verificationError of cleanupErrors) {
          logProductImageCleanupFailure(
            logger,
            'verification-connection',
            verificationError,
          );
        }
      }

      await removeProductImageAfterCommit(
        productImageStorage,
        previousImagePath,
        logger,
      );
    },
  });
}

export const adminProductsService = createAdminProductsService();
