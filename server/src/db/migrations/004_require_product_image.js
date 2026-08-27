export const id = '004_require_product_image';

function createMigrationError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.isSafeToDisplay = true;
  return error;
}

function normalizeExtra(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim().toLowerCase();
}

function hasNoColumnDefault(value) {
  return (
    value === null ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'null')
  );
}

function hasExpectedImageColumn(column, { nullable }) {
  return (
    column?.columnName === 'image_path' &&
    Number(column.ordinalPosition) === 6 &&
    column.dataType?.toLowerCase() === 'varchar' &&
    column.columnType?.toLowerCase() === 'varchar(2048)' &&
    Number(column.maximumLength) === 2048 &&
    column.characterSet?.toLowerCase() === 'utf8mb4' &&
    column.collation?.toLowerCase() === 'utf8mb4_unicode_ci' &&
    column.isNullable === (nullable ? 'YES' : 'NO') &&
    hasNoColumnDefault(column.defaultValue) &&
    normalizeExtra(column.extra) === ''
  );
}

async function readProductImageColumn(connection, databaseName) {
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition,
            DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            CHARACTER_MAXIMUM_LENGTH AS maximumLength,
            CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation,
            IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'menu_items'
        AND COLUMN_NAME = 'image_path'`,
    [databaseName],
  );

  return columns;
}

export async function validateRequiredProductImageSchema(
  connection,
  databaseName,
  allowNullable = false,
) {
  const columns = await readProductImageColumn(connection, databaseName);

  if (
    columns.length !== 1 ||
    (!hasExpectedImageColumn(columns[0], { nullable: false }) &&
      !(allowNullable && hasExpectedImageColumn(columns[0], { nullable: true })))
  ) {
    throw createMigrationError(
      'The product image column is incompatible with this project.',
      'PRODUCT_IMAGE_SCHEMA_INCOMPATIBLE',
    );
  }

  return Object.freeze({ nullable: columns[0].isNullable === 'YES' });
}

export async function up(connection, { databaseName } = {}) {
  if (typeof databaseName !== 'string' || databaseName.trim() === '') {
    throw createMigrationError(
      'A database name is required to validate the product image migration.',
      'PRODUCT_IMAGE_DATABASE_REQUIRED',
    );
  }

  const currentSchema = await validateRequiredProductImageSchema(
    connection,
    databaseName,
    true,
  );

  if (!currentSchema.nullable) {
    return;
  }

  const [incompatibleRows] = await connection.execute(
    'SELECT 1 AS incompatible FROM menu_items WHERE image_path IS NULL LIMIT 1',
  );

  if (incompatibleRows.length > 0) {
    throw createMigrationError(
      'Product images cannot be required while products without images exist. Add an image to every product and retry the migration.',
      'PRODUCT_IMAGE_NULL_ROWS_EXIST',
    );
  }

  await connection.query(
    'ALTER TABLE menu_items MODIFY COLUMN image_path VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL',
  );
  await validateRequiredProductImageSchema(connection, databaseName);
}
