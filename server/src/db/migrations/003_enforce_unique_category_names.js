export const id = '003_enforce_unique_category_names';

const categoryNameIndexName = 'uq_categories_name';
const expectedCharacterSet = 'utf8mb4';
const expectedCollation = 'utf8mb4_unicode_ci';
const expectedColumnType = 'varchar(100)';

function createSchemaError(detail, code = 'CATEGORY_SCHEMA_VALIDATION_FAILED') {
  const error = new Error(`Category schema is incompatible: ${detail}.`);
  error.code = code;
  error.isSafeToDisplay = true;
  return error;
}

function isExactCategoryNameIndex(indexes) {
  return (
    indexes.length === 1 &&
    indexes[0]?.indexName === categoryNameIndexName &&
    Number(indexes[0]?.nonUnique) === 0 &&
    Number(indexes[0]?.sequenceNumber) === 1 &&
    indexes[0]?.columnName === 'name' &&
    indexes[0]?.subPart === null
  );
}

export function validateCategoryNameIndexMetadata(indexes, allowMissing = false) {
  if (indexes.length === 0 && allowMissing) {
    return false;
  }

  if (!isExactCategoryNameIndex(indexes)) {
    throw createSchemaError(`index ${categoryNameIndexName}`);
  }

  return true;
}

export function validateCategoryNameColumnMetadata(column) {
  if (
    !column ||
    column.dataType?.toLowerCase() !== 'varchar' ||
    column.columnType?.toLowerCase() !== expectedColumnType ||
    Number(column.maximumLength) !== 100 ||
    column.isNullable !== 'NO' ||
    column.defaultValue !== null ||
    String(column.extra ?? '').trim() !== ''
  ) {
    throw createSchemaError('definition for column categories.name');
  }

  return (
    column.characterSet?.toLowerCase() === expectedCharacterSet &&
    column.collation?.toLowerCase() === expectedCollation
  );
}

async function inspectCategoryManagementSchema(connection, databaseName) {
  const [tables] = await connection.execute(
    `SELECT ENGINE AS engine, TABLE_COLLATION AS collation
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'categories'`,
    [databaseName],
  );

  if (tables.length !== 1 || tables[0]?.engine?.toLowerCase() !== 'innodb') {
    throw createSchemaError('categories table');
  }

  const [columns] = await connection.execute(
    `SELECT DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            CHARACTER_MAXIMUM_LENGTH AS maximumLength,
            IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra, CHARACTER_SET_NAME AS characterSet,
            COLLATION_NAME AS collation
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'categories'
        AND COLUMN_NAME = 'name'`,
    [databaseName],
  );

  if (columns.length !== 1) {
    throw createSchemaError('definition for column categories.name');
  }

  const columnIsAligned = validateCategoryNameColumnMetadata(columns[0]);

  const [indexes] = await connection.execute(
    `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
            SUB_PART AS subPart
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'categories'
        AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [databaseName, categoryNameIndexName],
  );

  return {
    tableIsAligned: tables[0].collation?.toLowerCase() === expectedCollation,
    columnIsAligned,
    indexExists: indexes.length > 0,
    indexIsValid: isExactCategoryNameIndex(indexes),
    indexes,
  };
}

export async function validateCategoryManagementSchema(
  connection,
  databaseName,
  allowMissingIndex = false,
) {
  const schema = await inspectCategoryManagementSchema(connection, databaseName);

  if (!schema.tableIsAligned) {
    throw createSchemaError('categories table collation');
  }

  if (!schema.columnIsAligned) {
    throw createSchemaError('character set or collation for column categories.name');
  }

  return validateCategoryNameIndexMetadata(schema.indexes, allowMissingIndex);
}

export async function up(connection, { databaseName }) {
  const schema = await inspectCategoryManagementSchema(connection, databaseName);

  if (schema.tableIsAligned && schema.columnIsAligned && schema.indexIsValid) {
    return;
  }

  const [duplicateRows] = await connection.query(
    `SELECT 1 AS duplicateExists
       FROM categories
      GROUP BY CONVERT(name USING utf8mb4) COLLATE utf8mb4_unicode_ci
     HAVING COUNT(*) > 1
      LIMIT 1`,
  );

  if (duplicateRows.length > 0) {
    throw createSchemaError(
      'duplicate category names must be resolved before migration',
      'DUPLICATE_CATEGORY_NAMES_EXIST',
    );
  }

  if (!schema.tableIsAligned) {
    await connection.query(
      `ALTER TABLE categories
         DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  }

  if (!schema.columnIsAligned) {
    await connection.query(
      `ALTER TABLE categories
         MODIFY COLUMN name VARCHAR(100)
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL`,
    );
  }

  if (schema.indexExists && !schema.indexIsValid) {
    await connection.query(
      `ALTER TABLE categories
         DROP INDEX uq_categories_name,
         ADD UNIQUE KEY uq_categories_name (name)`,
    );
  } else if (!schema.indexExists) {
    await connection.query(
      `ALTER TABLE categories
         ADD UNIQUE KEY uq_categories_name (name)`,
    );
  }

  await validateCategoryManagementSchema(connection, databaseName, false);
}
