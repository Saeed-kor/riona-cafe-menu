export const maximumCategoryNameCharacters = 100;

const maximumUnsignedBigInt = 18_446_744_073_709_551_615n;
const allowedCategoryFields = new Set(['name', 'sortOrder', 'isVisible']);
let databaseModulePromise = null;

async function getDefaultExecutor() {
  databaseModulePromise ??= import('../config/db.js').catch((error) => {
    databaseModulePromise = null;
    throw error;
  });

  const { pool } = await databaseModulePromise;
  return pool;
}

function createCategoryError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.isSafeToDisplay = true;
  return error;
}

function assertBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createCategoryError('Category body is invalid', 'INVALID_CATEGORY_BODY', 400);
  }

  if (Object.keys(body).some((field) => !allowedCategoryFields.has(field))) {
    throw createCategoryError('Category body contains unknown fields', 'INVALID_CATEGORY_BODY', 400);
  }
}

function normalizeCategoryName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createCategoryError('Category name is required', 'INVALID_CATEGORY_NAME', 400);
  }

  const name = value.trim();

  if (Array.from(name).length > maximumCategoryNameCharacters) {
    throw createCategoryError(
      `Category name must be ${maximumCategoryNameCharacters} characters or fewer`,
      'INVALID_CATEGORY_NAME',
      400,
    );
  }

  return name;
}

function normalizeSortOrder(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295) {
    throw createCategoryError(
      'sortOrder must be a non-negative integer',
      'INVALID_CATEGORY_SORT_ORDER',
      400,
    );
  }

  return value;
}

function normalizeVisibility(value) {
  if (typeof value !== 'boolean') {
    throw createCategoryError(
      'isVisible must be a boolean',
      'INVALID_CATEGORY_VISIBILITY',
      400,
    );
  }

  return value;
}

export function parseCategoryId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) {
    throw createCategoryError('Category id is invalid', 'INVALID_CATEGORY_ID', 400);
  }

  const id = BigInt(value);

  if (id > maximumUnsignedBigInt) {
    throw createCategoryError('Category id is invalid', 'INVALID_CATEGORY_ID', 400);
  }

  return id.toString();
}

export function validateNewCategory(body) {
  assertBodyObject(body);

  return {
    name: normalizeCategoryName(body.name),
    sortOrder: body.sortOrder === undefined ? 0 : normalizeSortOrder(body.sortOrder),
    isVisible: body.isVisible === undefined ? true : normalizeVisibility(body.isVisible),
  };
}

export function validateCategoryChanges(body) {
  assertBodyObject(body);
  const fields = Object.keys(body);

  if (fields.length === 0) {
    throw createCategoryError(
      'At least one category field is required',
      'EMPTY_CATEGORY_UPDATE',
      400,
    );
  }

  return {
    ...(fields.includes('name') ? { name: normalizeCategoryName(body.name) } : {}),
    ...(fields.includes('sortOrder')
      ? { sortOrder: normalizeSortOrder(body.sortOrder) }
      : {}),
    ...(fields.includes('isVisible')
      ? { isVisible: normalizeVisibility(body.isVisible) }
      : {}),
  };
}

function normalizeTimestamp(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toCategory(row) {
  return {
    id: String(row.id),
    name: row.name,
    sortOrder: Number(row.sortOrder),
    isVisible: Number(row.isVisible) === 1,
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt),
  };
}

function isDuplicateNameError(error) {
  return error?.code === 'ER_DUP_ENTRY' || Number(error?.errno) === 1062;
}

function isReferencedCategoryError(error) {
  return error?.code === 'ER_ROW_IS_REFERENCED_2' || Number(error?.errno) === 1451;
}

function duplicateNameError() {
  return createCategoryError(
    'A category with this name already exists',
    'CATEGORY_NAME_CONFLICT',
    409,
  );
}

function categoryNotFoundError() {
  return createCategoryError('Category not found', 'CATEGORY_NOT_FOUND', 404);
}

async function selectCategoryById(executor, categoryId) {
  const [rows] = await executor.execute(
    `SELECT id, name, display_order AS sortOrder, is_visible AS isVisible,
            created_at AS createdAt, updated_at AS updatedAt
       FROM categories
      WHERE id = ?
      LIMIT 1`,
    [categoryId],
  );

  return rows[0] ? toCategory(rows[0]) : null;
}

export function createAdminCategoriesService({ executor } = {}) {
  return Object.freeze({
    async list() {
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      const [rows] = await databaseExecutor.execute(
        `SELECT id, name, display_order AS sortOrder, is_visible AS isVisible,
                created_at AS createdAt, updated_at AS updatedAt
           FROM categories
          ORDER BY display_order ASC, id ASC`,
      );

      return rows.map(toCategory);
    },

    async create(body) {
      const category = validateNewCategory(body);
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      let result;

      try {
        [result] = await databaseExecutor.execute(
          `INSERT INTO categories (name, display_order, is_visible)
           VALUES (?, ?, ?)`,
          [category.name, category.sortOrder, Number(category.isVisible)],
        );
      } catch (error) {
        if (isDuplicateNameError(error)) {
          throw duplicateNameError();
        }

        throw error;
      }

      const createdCategory = await selectCategoryById(
        databaseExecutor,
        String(result.insertId),
      );

      if (!createdCategory) {
        throw new Error('Created category could not be loaded.');
      }

      return createdCategory;
    },

    async update(categoryIdValue, body) {
      const categoryId = parseCategoryId(categoryIdValue);
      const changes = validateCategoryChanges(body);
      const assignments = [];
      const values = [];

      if (changes.name !== undefined) {
        assignments.push('name = ?');
        values.push(changes.name);
      }

      if (changes.sortOrder !== undefined) {
        assignments.push('display_order = ?');
        values.push(changes.sortOrder);
      }

      if (changes.isVisible !== undefined) {
        assignments.push('is_visible = ?');
        values.push(Number(changes.isVisible));
      }

      const databaseExecutor = executor ?? (await getDefaultExecutor());

      try {
        await databaseExecutor.execute(
          `UPDATE categories
              SET ${assignments.join(', ')}
            WHERE id = ?`,
          [...values, categoryId],
        );
      } catch (error) {
        if (isDuplicateNameError(error)) {
          throw duplicateNameError();
        }

        throw error;
      }

      const updatedCategory = await selectCategoryById(databaseExecutor, categoryId);

      if (!updatedCategory) {
        throw categoryNotFoundError();
      }

      return updatedCategory;
    },

    async remove(categoryIdValue) {
      const categoryId = parseCategoryId(categoryIdValue);
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      let result;

      try {
        [result] = await databaseExecutor.execute('DELETE FROM categories WHERE id = ?', [
          categoryId,
        ]);
      } catch (error) {
        if (isReferencedCategoryError(error)) {
          throw createCategoryError(
            'A category with menu items cannot be deleted',
            'CATEGORY_HAS_MENU_ITEMS',
            409,
          );
        }

        throw error;
      }

      if (Number(result.affectedRows) === 0) {
        throw categoryNotFoundError();
      }
    },
  });
}

export const adminCategoriesService = createAdminCategoriesService();
