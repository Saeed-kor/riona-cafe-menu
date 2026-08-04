export const id = '002_create_admin_sessions';

const tableDefinition = `CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_sessions_token_hash (token_hash),
  KEY idx_admin_sessions_admin_id (admin_id),
  KEY idx_admin_sessions_expires_at (expires_at),
  CONSTRAINT fk_admin_sessions_admin
    FOREIGN KEY (admin_id) REFERENCES admins (id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const expectedColumns = {
  id: {
    dataType: 'bigint',
    columnType: 'bigint(20) unsigned',
    nullable: false,
    autoIncrement: true,
  },
  admin_id: {
    dataType: 'bigint',
    columnType: 'bigint(20) unsigned',
    nullable: false,
  },
  token_hash: {
    dataType: 'char',
    columnType: 'char(64)',
    nullable: false,
    maximumLength: 64,
    characterSet: 'ascii',
    collation: 'ascii_bin',
  },
  expires_at: {
    dataType: 'datetime',
    columnType: 'datetime(3)',
    nullable: false,
    datetimePrecision: 3,
  },
  created_at: {
    dataType: 'datetime',
    columnType: 'datetime(3)',
    nullable: false,
    datetimePrecision: 3,
    defaultValue: 'current_timestamp(3)',
  },
};

const expectedIndexes = {
  PRIMARY: { unique: true, columns: ['id'] },
  uq_admin_sessions_token_hash: { unique: true, columns: ['token_hash'] },
  idx_admin_sessions_admin_id: { unique: false, columns: ['admin_id'] },
  idx_admin_sessions_expires_at: { unique: false, columns: ['expires_at'] },
};

function createSchemaError(detail) {
  const error = new Error(`Table admin_sessions has an incompatible ${detail}.`);
  error.code = 'ADMIN_SESSIONS_SCHEMA_VALIDATION_FAILED';
  error.isSafeToDisplay = true;
  return error;
}

function normalizeSqlExpression(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return String(value).toLowerCase().replace(/\s+/g, '');
}

function validateColumn(column, expected) {
  const normalizedExtra = normalizeSqlExpression(column.extra);

  if (
    column.dataType?.toLowerCase() !== expected.dataType ||
    column.columnType?.toLowerCase() !== expected.columnType ||
    (column.isNullable === 'YES') !== expected.nullable ||
    (expected.autoIncrement === true && normalizedExtra !== 'auto_increment') ||
    (expected.autoIncrement !== true && normalizedExtra !== '') ||
    (expected.maximumLength !== undefined &&
      Number(column.maximumLength) !== expected.maximumLength) ||
    (expected.datetimePrecision !== undefined &&
      Number(column.datetimePrecision) !== expected.datetimePrecision) ||
    (expected.characterSet !== undefined &&
      column.characterSet?.toLowerCase() !== expected.characterSet) ||
    (expected.collation !== undefined && column.collation?.toLowerCase() !== expected.collation) ||
    (expected.defaultValue !== undefined &&
      normalizeSqlExpression(column.defaultValue) !== expected.defaultValue) ||
    (expected.defaultValue === undefined && column.defaultValue !== null)
  ) {
    throw createSchemaError(`definition for column ${column.columnName}`);
  }
}

export function validateAdminSessionsMetadata({ table, columns, indexes, foreignKeys }) {
  if (
    !table ||
    table.engine?.toLowerCase() !== 'innodb' ||
    table.collation?.toLowerCase() !== 'utf8mb4_unicode_ci'
  ) {
    throw createSchemaError('engine or collation');
  }

  const expectedColumnEntries = Object.entries(expectedColumns);

  if (
    columns.length !== expectedColumnEntries.length ||
    expectedColumnEntries.some(([columnName], index) => columns[index]?.columnName !== columnName)
  ) {
    throw createSchemaError('set of columns');
  }

  for (const column of columns) {
    validateColumn(column, expectedColumns[column.columnName]);
  }

  const expectedIndexEntries = Object.entries(expectedIndexes);
  const actualIndexNames = new Set(indexes.map((index) => index.indexName));

  if (
    actualIndexNames.size !== expectedIndexEntries.length ||
    expectedIndexEntries.some(([indexName, expected]) => {
      const actual = indexes.filter((index) => index.indexName === indexName);

      return (
        actual.length !== expected.columns.length ||
        Boolean(actual[0]?.nonUnique) === expected.unique ||
        actual.some((index, position) => index.columnName !== expected.columns[position])
      );
    })
  ) {
    throw createSchemaError('set of indexes');
  }

  const [foreignKey] = foreignKeys;

  if (
    foreignKeys.length !== 1 ||
    foreignKey.constraintName !== 'fk_admin_sessions_admin' ||
    foreignKey.columnName !== 'admin_id' ||
    foreignKey.referencedTableName !== 'admins' ||
    foreignKey.referencedColumnName !== 'id' ||
    foreignKey.deleteRule !== 'CASCADE' ||
    !['RESTRICT', 'NO ACTION'].includes(foreignKey.updateRule)
  ) {
    throw createSchemaError('foreign key');
  }
}

export async function validateAdminSessionsSchema(connection, databaseName, allowMissing) {
  const [tables] = await connection.execute(
    `SELECT ENGINE AS engine, TABLE_COLLATION AS collation
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'admin_sessions'`,
    [databaseName],
  );

  if (tables.length === 0 && allowMissing) {
    return;
  }

  if (tables.length !== 1) {
    throw createSchemaError('table definition');
  }

  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME AS columnName, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable, CHARACTER_MAXIMUM_LENGTH AS maximumLength,
            DATETIME_PRECISION AS datetimePrecision, COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra, CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'admin_sessions'
      ORDER BY ORDINAL_POSITION`,
    [databaseName],
  );
  const [indexes] = await connection.execute(
    `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'admin_sessions'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [databaseName],
  );
  const [foreignKeys] = await connection.execute(
    `SELECT keyUsage.CONSTRAINT_NAME AS constraintName,
            keyUsage.COLUMN_NAME AS columnName,
            keyUsage.REFERENCED_TABLE_NAME AS referencedTableName,
            keyUsage.REFERENCED_COLUMN_NAME AS referencedColumnName,
            referential.DELETE_RULE AS deleteRule,
            referential.UPDATE_RULE AS updateRule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS keyUsage
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential
         ON referential.CONSTRAINT_SCHEMA = keyUsage.CONSTRAINT_SCHEMA
        AND referential.CONSTRAINT_NAME = keyUsage.CONSTRAINT_NAME
        AND referential.TABLE_NAME = keyUsage.TABLE_NAME
      WHERE keyUsage.CONSTRAINT_SCHEMA = ?
        AND keyUsage.TABLE_NAME = 'admin_sessions'
        AND keyUsage.REFERENCED_TABLE_NAME IS NOT NULL`,
    [databaseName],
  );

  validateAdminSessionsMetadata({ table: tables[0], columns, indexes, foreignKeys });
}

export async function up(connection, { databaseName }) {
  await validateAdminSessionsSchema(connection, databaseName, true);
  await connection.query(tableDefinition);
  await validateAdminSessionsSchema(connection, databaseName, false);
}
