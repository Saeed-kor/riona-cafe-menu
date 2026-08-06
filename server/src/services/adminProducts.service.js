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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
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
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createProductError(
      'categoryId must be a positive integer',
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

function toProduct(row) {
  return {
    id: String(row.id),
    categoryId: String(row.categoryId),
    categoryName: row.categoryName,
    name: row.name,
    description: row.description,
    price: String(row.price),
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

async function selectProductById(executor, productId) {
  const [rows] = await executor.execute(
    `SELECT CAST(menuItems.id AS CHAR) AS id,
            CAST(menuItems.category_id AS CHAR) AS categoryId,
            categories.name AS categoryName, menuItems.name,
            menuItems.description, CAST(menuItems.price AS CHAR) AS price,
            menuItems.display_order AS sortOrder,
            menuItems.is_available AS isAvailable,
            menuItems.is_visible AS isVisible
       FROM menu_items AS menuItems
       JOIN categories ON categories.id = menuItems.category_id
      WHERE menuItems.id = ?
      LIMIT 1`,
    [productId],
  );

  return rows[0] ? toProduct(rows[0]) : null;
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

  return new AggregateError(
    [primaryError, ...cleanupErrors],
    'Product creation failed and cleanup was incomplete.',
    { cause: primaryError },
  );
}

export function createAdminProductsService({ executor } = {}) {
  return Object.freeze({
    async list() {
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      const [rows] = await databaseExecutor.execute(
        `SELECT CAST(menuItems.id AS CHAR) AS id,
                CAST(menuItems.category_id AS CHAR) AS categoryId,
                categories.name AS categoryName, menuItems.name,
                menuItems.description, CAST(menuItems.price AS CHAR) AS price,
                menuItems.display_order AS sortOrder,
                menuItems.is_available AS isAvailable,
                menuItems.is_visible AS isVisible
           FROM menu_items AS menuItems
           JOIN categories ON categories.id = menuItems.category_id
          ORDER BY menuItems.display_order ASC, menuItems.id ASC`,
      );

      return rows.map(toProduct);
    },

    async create(body) {
      const product = validateNewProduct(body);
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      const connection = await databaseExecutor.getConnection();
      let createdProduct = null;
      let primaryError = null;
      let transactionStarted = false;
      let commitSucceeded = false;
      const cleanupErrors = [];

      try {
        await connection.beginTransaction();
        transactionStarted = true;
        await assertCategoryExists(connection, product.categoryId);
        await connection.execute(
          `INSERT INTO menu_items
             (category_id, name, description, price, display_order, is_available, is_visible)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            product.categoryId,
            product.name,
            product.description,
            product.price,
            product.sortOrder,
            Number(product.isAvailable),
            Number(product.isVisible),
          ],
        );
        const productId = await selectLastInsertedProductId(connection);
        createdProduct = await selectProductById(connection, productId);

        if (!createdProduct) {
          throw new Error('Created product could not be loaded.');
        }

        await connection.commit();
        commitSucceeded = true;
        transactionStarted = false;
      } catch (error) {
        primaryError = error;

        if (transactionStarted) {
          try {
            await connection.rollback();
            transactionStarted = false;
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
          }
        }
      } finally {
        try {
          connection.release();
        } catch (releaseError) {
          if (!commitSucceeded) {
            cleanupErrors.push(releaseError);
          }
        }
      }

      if (primaryError) {
        if (cleanupErrors.length === 0 && isMissingReferencedRowError(primaryError)) {
          throw invalidCategoryError();
        }

        throw combineCreateErrors(primaryError, cleanupErrors);
      }

      if (cleanupErrors.length > 0) {
        throw cleanupErrors[0];
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
      const [result] = await databaseExecutor.execute(
        'DELETE FROM menu_items WHERE id = ?',
        [productId],
      );

      if (Number(result.affectedRows) === 0) {
        throw productNotFoundError();
      }
    },
  });
}

export const adminProductsService = createAdminProductsService();
