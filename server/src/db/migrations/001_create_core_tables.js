export const id = '001_create_core_tables';

const checkClauses = Object.freeze({
  categories: Object.freeze({
    chk_categories_is_visible: 'is_visible IN (0, 1)',
  }),
  menu_items: Object.freeze({
    chk_menu_items_is_visible: 'is_visible IN (0, 1)',
    chk_menu_items_is_available: 'is_available IN (0, 1)',
  }),
  cafe_settings: Object.freeze({
    chk_cafe_settings_singleton: 'id = 1',
  }),
});

const tableDefinitions = [
  `CREATE TABLE IF NOT EXISTS admins (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_admins_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS categories (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    image_path VARCHAR(2048) NULL,
    display_order INT UNSIGNED NOT NULL DEFAULT 0,
    is_visible TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_categories_visible_order (is_visible, display_order, id),
    CONSTRAINT chk_categories_is_visible CHECK (${checkClauses.categories.chk_categories_is_visible})
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS menu_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    category_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NULL,
    price BIGINT UNSIGNED NOT NULL,
    image_path VARCHAR(2048) NULL,
    display_order INT UNSIGNED NOT NULL DEFAULT 0,
    is_visible TINYINT(1) NOT NULL DEFAULT 1,
    is_available TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_menu_items_category_visible_order (category_id, is_visible, display_order, id),
    CONSTRAINT fk_menu_items_category
      FOREIGN KEY (category_id) REFERENCES categories (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_menu_items_is_visible CHECK (${checkClauses.menu_items.chk_menu_items_is_visible}),
    CONSTRAINT chk_menu_items_is_available CHECK (${checkClauses.menu_items.chk_menu_items_is_available})
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS cafe_settings (
    id TINYINT UNSIGNED NOT NULL DEFAULT 1,
    cafe_name VARCHAR(150) NOT NULL,
    logo_path VARCHAR(2048) NULL,
    phone VARCHAR(50) NULL,
    address TEXT NULL,
    instagram_url VARCHAR(2048) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    CONSTRAINT chk_cafe_settings_singleton CHECK (${checkClauses.cafe_settings.chk_cafe_settings_singleton})
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const expectedColumns = {
  admins: {
    id: { dataType: 'bigint', nullable: false, unsigned: true, autoIncrement: true },
    username: { dataType: 'varchar', nullable: false, maximumLength: 50 },
    password_hash: { dataType: 'varchar', nullable: false, maximumLength: 255 },
    created_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
    },
    updated_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
      onUpdateValue: 'current_timestamp(3)',
    },
  },
  categories: {
    id: { dataType: 'bigint', nullable: false, unsigned: true, autoIncrement: true },
    name: { dataType: 'varchar', nullable: false, maximumLength: 100 },
    image_path: { dataType: 'varchar', nullable: true, maximumLength: 2048 },
    display_order: { dataType: 'int', nullable: false, unsigned: true, defaultValue: '0' },
    is_visible: { dataType: 'tinyint', nullable: false, defaultValue: '1' },
    created_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
    },
    updated_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
      onUpdateValue: 'current_timestamp(3)',
    },
  },
  menu_items: {
    id: { dataType: 'bigint', nullable: false, unsigned: true, autoIncrement: true },
    category_id: { dataType: 'bigint', nullable: false, unsigned: true },
    name: { dataType: 'varchar', nullable: false, maximumLength: 150 },
    description: { dataType: 'text', nullable: true },
    price: { dataType: 'bigint', nullable: false, unsigned: true },
    image_path: { dataType: 'varchar', nullable: true, maximumLength: 2048 },
    display_order: { dataType: 'int', nullable: false, unsigned: true, defaultValue: '0' },
    is_visible: { dataType: 'tinyint', nullable: false, defaultValue: '1' },
    is_available: { dataType: 'tinyint', nullable: false, defaultValue: '1' },
    created_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
    },
    updated_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
      onUpdateValue: 'current_timestamp(3)',
    },
  },
  cafe_settings: {
    id: { dataType: 'tinyint', nullable: false, unsigned: true, defaultValue: '1' },
    cafe_name: { dataType: 'varchar', nullable: false, maximumLength: 150 },
    logo_path: { dataType: 'varchar', nullable: true, maximumLength: 2048 },
    phone: { dataType: 'varchar', nullable: true, maximumLength: 50 },
    address: { dataType: 'text', nullable: true },
    instagram_url: { dataType: 'varchar', nullable: true, maximumLength: 2048 },
    created_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
    },
    updated_at: {
      dataType: 'datetime',
      columnType: 'datetime(3)',
      datetimePrecision: 3,
      nullable: false,
      defaultValue: 'current_timestamp(3)',
      onUpdateValue: 'current_timestamp(3)',
    },
  },
};

const expectedIndexes = {
  admins: {
    PRIMARY: { unique: true, columns: ['id'] },
    uq_admins_username: { unique: true, columns: ['username'] },
  },
  categories: {
    PRIMARY: { unique: true, columns: ['id'] },
    idx_categories_visible_order: {
      unique: false,
      columns: ['is_visible', 'display_order', 'id'],
    },
  },
  menu_items: {
    PRIMARY: { unique: true, columns: ['id'] },
    idx_menu_items_category_visible_order: {
      unique: false,
      columns: ['category_id', 'is_visible', 'display_order', 'id'],
    },
  },
  cafe_settings: {
    PRIMARY: { unique: true, columns: ['id'] },
  },
};

const expectedChecks = Object.freeze({
  admins: Object.freeze({}),
  ...checkClauses,
});

function createSchemaError(tableName, detail) {
  const error = new Error(`Table ${tableName} has an incompatible ${detail}.`);
  error.code = 'CORE_SCHEMA_VALIDATION_FAILED';
  error.isSafeToDisplay = true;
  return error;
}

function hasWrappingParentheses(value) {
  if (!value.startsWith('(') || !value.endsWith(')')) {
    return false;
  }

  let depth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      if (character === '\\' && quote !== '`' && index + 1 < value.length) {
        index += 1;
      } else if (character === quote && value[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }

      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;

      if (depth === 0 && index < value.length - 1) {
        return false;
      }

      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0 && quote === null;
}

function isSqlWordCharacter(character) {
  return typeof character === 'string' && /[\p{L}\p{N}_$]/u.test(character);
}

function readQuotedToken(clause, startIndex, quote) {
  let value = quote;
  let index = startIndex + 1;
  let closed = false;

  for (; index < clause.length; index += 1) {
    const character = clause[index];
    value += character;

    if (character === '\\' && quote !== '`' && index + 1 < clause.length) {
      value += clause[index + 1];
      index += 1;
    } else if (character === quote && clause[index + 1] === quote) {
      value += clause[index + 1];
      index += 1;
    } else if (character === quote) {
      closed = true;
      break;
    }
  }

  return { value, endIndex: index, closed };
}

function tokenizeCheckClause(clause) {
  const tokens = [];

  for (let index = 0; index < clause.length; index += 1) {
    const character = clause[index];

    if (/\s/u.test(character)) {
      continue;
    }

    if (character === "'" || character === '"') {
      const token = readQuotedToken(clause, index, character);
      tokens.push({ type: 'literal', value: token.value });
      index = token.endIndex;
      continue;
    }

    if (character === '`') {
      const token = readQuotedToken(clause, index, character);
      const identifier = token.value.slice(1, token.closed ? -1 : undefined).replaceAll('``', '`');

      if (token.closed && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(identifier)) {
        tokens.push({ type: 'word', value: identifier.toLowerCase() });
      } else {
        tokens.push({ type: 'quotedIdentifier', value: token.value.toLowerCase() });
      }

      index = token.endIndex;
      continue;
    }

    if (isSqlWordCharacter(character)) {
      let value = character;

      while (isSqlWordCharacter(clause[index + 1])) {
        index += 1;
        value += clause[index];
      }

      tokens.push({ type: 'word', value: value.toLowerCase() });
      continue;
    }

    tokens.push({ type: 'symbol', value: character.toLowerCase() });
  }

  return tokens;
}

export function normalizeCheckClause(clause) {
  if (typeof clause !== 'string') {
    return '';
  }

  const tokens = tokenizeCheckClause(clause);
  let normalized = tokens
    .map((token, index) => {
      const previousToken = tokens[index - 1];
      const separator = previousToken?.type === 'word' && token.type === 'word' ? ' ' : '';
      return `${separator}${token.value}`;
    })
    .join('');

  while (hasWrappingParentheses(normalized)) {
    normalized = normalized.slice(1, -1);
  }

  return normalized;
}

function normalizeSqlExpression(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return String(value).toLowerCase().replace(/\s+/g, '');
}

function validateColumn(tableName, column, expected) {
  const columnType = column.columnType.toLowerCase();
  const normalizedDefault = normalizeSqlExpression(column.defaultValue);
  const normalizedExtra = normalizeSqlExpression(column.extra);
  const expectedDefault = normalizeSqlExpression(expected.defaultValue);
  const expectedOnUpdate = expected.onUpdateValue
    ? `onupdate${normalizeSqlExpression(expected.onUpdateValue)}`
    : '';

  if (
    column.dataType.toLowerCase() !== expected.dataType ||
    (expected.columnType !== undefined && columnType !== expected.columnType) ||
    (expected.datetimePrecision !== undefined &&
      Number(column.datetimePrecision) !== expected.datetimePrecision) ||
    (column.isNullable === 'YES') !== expected.nullable ||
    (expected.unsigned === true && !columnType.includes('unsigned')) ||
    (expected.unsigned !== true && columnType.includes('unsigned')) ||
    (expected.autoIncrement === true && !normalizedExtra.includes('auto_increment')) ||
    (expected.autoIncrement !== true && normalizedExtra.includes('auto_increment')) ||
    normalizedExtra.replace('auto_increment', '') !== expectedOnUpdate ||
    (expected.maximumLength !== undefined &&
      Number(column.maximumLength) !== expected.maximumLength) ||
    (expected.defaultValue !== undefined && normalizedDefault !== expectedDefault)
  ) {
    throw createSchemaError(tableName, `definition for column ${column.columnName}`);
  }
}

export function validateCoreColumnMetadata(tableName, column) {
  const expected = expectedColumns[tableName]?.[column.columnName];

  if (!expected) {
    throw createSchemaError(tableName, `definition for column ${column.columnName}`);
  }

  validateColumn(tableName, column, expected);
}

export function validateCoreCheckMetadata(tableName, actualChecks) {
  const checks = expectedChecks[tableName];
  const expectedCheckEntries = Object.entries(checks ?? {});

  if (
    !checks ||
    actualChecks.length !== expectedCheckEntries.length ||
    expectedCheckEntries.some(([checkName, expectedClause]) => {
      const actualCheck = actualChecks.find((row) => row.constraintName === checkName);

      return (
        !actualCheck ||
        normalizeCheckClause(actualCheck.checkClause) !== normalizeCheckClause(expectedClause)
      );
    })
  ) {
    throw createSchemaError(tableName, 'set of check constraints');
  }
}

export async function validateCoreSchema(connection, databaseName, allowMissing) {
  const tableNames = Object.keys(expectedColumns);
  const [tables] = await connection.execute(
    `SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?, ?)`,
    [databaseName, ...tableNames],
  );
  const existingTableNames = new Set(tables.map((table) => table.tableName));

  if (!allowMissing && existingTableNames.size !== tableNames.length) {
    throw createSchemaError('core schema', 'set of tables');
  }

  for (const table of tables) {
    if (
      table.engine?.toLowerCase() !== 'innodb' ||
      table.collation?.toLowerCase() !== 'utf8mb4_unicode_ci'
    ) {
      throw createSchemaError(table.tableName, 'engine or collation');
    }
  }

  if (existingTableNames.size === 0) {
    return;
  }

  const [columns] = await connection.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType,
            COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
             CHARACTER_MAXIMUM_LENGTH AS maximumLength,
             DATETIME_PRECISION AS datetimePrecision,
             COLUMN_DEFAULT AS defaultValue, EXTRA AS extra
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?, ?)
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [databaseName, ...tableNames],
  );

  for (const tableName of existingTableNames) {
    const actualColumns = columns.filter((column) => column.tableName === tableName);
    const tableExpectedColumns = expectedColumns[tableName];
    const expectedColumnNames = Object.keys(tableExpectedColumns);

    if (
      actualColumns.length !== expectedColumnNames.length ||
      actualColumns.some((column) => !tableExpectedColumns[column.columnName])
    ) {
      throw createSchemaError(tableName, 'set of columns');
    }

    for (const column of actualColumns) {
      validateCoreColumnMetadata(tableName, column);
    }
  }

  const [indexRows] = await connection.execute(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?, ?)
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [databaseName, ...tableNames],
  );

  for (const tableName of existingTableNames) {
    for (const [indexName, expectedIndex] of Object.entries(expectedIndexes[tableName])) {
      const actualIndex = indexRows.filter(
        (row) => row.tableName === tableName && row.indexName === indexName,
      );
      const actualColumns = actualIndex.map((row) => row.columnName);

      if (
        actualIndex.length !== expectedIndex.columns.length ||
        Boolean(actualIndex[0]?.nonUnique) === expectedIndex.unique ||
        actualColumns.some((columnName, index) => columnName !== expectedIndex.columns[index])
      ) {
        throw createSchemaError(tableName, `index ${indexName}`);
      }
    }
  }

  const [checkRows] = await connection.execute(
    `SELECT tableConstraints.TABLE_NAME AS tableName,
            tableConstraints.CONSTRAINT_NAME AS constraintName,
            checkConstraints.CHECK_CLAUSE AS checkClause
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tableConstraints
       JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS checkConstraints
         ON checkConstraints.CONSTRAINT_SCHEMA = tableConstraints.CONSTRAINT_SCHEMA
        AND checkConstraints.CONSTRAINT_NAME = tableConstraints.CONSTRAINT_NAME
      WHERE tableConstraints.CONSTRAINT_SCHEMA = ?
        AND tableConstraints.CONSTRAINT_TYPE = 'CHECK'
        AND tableConstraints.TABLE_NAME IN (?, ?, ?, ?)`,
    [databaseName, ...tableNames],
  );

  for (const tableName of Object.keys(expectedChecks)) {
    if (!existingTableNames.has(tableName)) {
      continue;
    }

    const actualChecks = checkRows.filter((row) => row.tableName === tableName);
    validateCoreCheckMetadata(tableName, actualChecks);
  }

  if (existingTableNames.has('menu_items')) {
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
          AND keyUsage.TABLE_NAME = 'menu_items'
          AND keyUsage.REFERENCED_TABLE_NAME IS NOT NULL`,
      [databaseName],
    );
    const [foreignKey] = foreignKeys;

    if (
      foreignKeys.length !== 1 ||
      foreignKey.constraintName !== 'fk_menu_items_category' ||
      foreignKey.columnName !== 'category_id' ||
      foreignKey.referencedTableName !== 'categories' ||
      foreignKey.referencedColumnName !== 'id' ||
      !['RESTRICT', 'NO ACTION'].includes(foreignKey.deleteRule) ||
      !['RESTRICT', 'NO ACTION'].includes(foreignKey.updateRule)
    ) {
      throw createSchemaError('menu_items', 'foreign key');
    }
  }
}

export async function up(connection, { databaseName }) {
  await validateCoreSchema(connection, databaseName, true);

  for (const tableDefinition of tableDefinitions) {
    await connection.query(tableDefinition);
  }

  await validateCoreSchema(connection, databaseName, false);
}
