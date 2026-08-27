import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeDatabasePool, pool } from '../config/db.js';
import { env } from '../config/env.js';

const migrationDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));
const migrationNamePattern = /^\d{3,}_[a-z0-9_]+$/;
const migrationLockName = 'riona_cafe_menu_schema_migrations';

function createSafeError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.isSafeToDisplay = true;
  return error;
}

export async function loadMigrations() {
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .sort((first, second) => first.name.localeCompare(second.name, 'en', { numeric: true }));

  const migrations = [];
  const migrationIds = new Set();

  for (const file of files) {
    const expectedId = basename(file.name, '.js');

    if (!migrationNamePattern.test(expectedId)) {
      throw createSafeError(
        'Migration filenames must start with a numeric version and use lowercase characters.',
        'INVALID_MIGRATION_NAME',
      );
    }

    const migration = await import(pathToFileURL(join(migrationDirectory, file.name)).href);

    if (migration.id !== expectedId || typeof migration.up !== 'function') {
      throw createSafeError(
        `Migration ${expectedId} must export a matching id and an up function.`,
        'INVALID_MIGRATION_MODULE',
      );
    }

    if (migrationIds.has(migration.id)) {
      throw createSafeError('Duplicate migration identifiers are not allowed.', 'DUPLICATE_MIGRATION');
    }

    migrationIds.add(migration.id);
    migrations.push(migration);
  }

  return migrations;
}

async function acquireMigrationLock(connection) {
  const [[result]] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', [
    migrationLockName,
  ]);

  if (Number(result.acquired) !== 1) {
    throw createSafeError(
      'Another migration process is already running. Try again after it finishes.',
      'MIGRATION_LOCK_UNAVAILABLE',
    );
  }
}

function normalizeSqlExpression(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return String(value).toLowerCase().replace(/\s+/g, '');
}

export function validateMigrationTableMetadata(table, columns, indexes) {
  const [idColumn, executedAtColumn] = columns;
  const primaryIndex = indexes.filter((index) => index.indexName === 'PRIMARY');
  const hasExpectedColumns =
    columns.length === 2 &&
    idColumn?.columnName === 'id' &&
    Number(idColumn.ordinalPosition) === 1 &&
    idColumn?.dataType?.toLowerCase() === 'varchar' &&
    idColumn.columnType?.toLowerCase() === 'varchar(191)' &&
    Number(idColumn.maximumLength) === 191 &&
    idColumn.isNullable === 'NO' &&
    idColumn.columnKey === 'PRI' &&
    idColumn.defaultValue === null &&
    normalizeSqlExpression(idColumn.extra) === '' &&
    executedAtColumn?.columnName === 'executed_at' &&
    Number(executedAtColumn.ordinalPosition) === 2 &&
    executedAtColumn?.dataType?.toLowerCase() === 'datetime' &&
    executedAtColumn.columnType?.toLowerCase() === 'datetime(3)' &&
    Number(executedAtColumn.datetimePrecision) === 3 &&
    executedAtColumn.isNullable === 'NO' &&
    executedAtColumn.columnKey === '' &&
    normalizeSqlExpression(executedAtColumn.defaultValue) === 'current_timestamp(3)' &&
    normalizeSqlExpression(executedAtColumn.extra) === '';
  const hasExpectedPrimaryKey =
    indexes.length === 1 &&
    primaryIndex.length === 1 &&
    Number(primaryIndex[0].nonUnique) === 0 &&
    Number(primaryIndex[0].sequenceNumber) === 1 &&
    primaryIndex[0].columnName === 'id';

  if (
    !table ||
    table.engine?.toLowerCase() !== 'innodb' ||
    table.collation?.toLowerCase() !== 'utf8mb4_unicode_ci' ||
    !hasExpectedColumns ||
    !hasExpectedPrimaryKey
  ) {
    throw createSafeError(
      'The existing schema_migrations table is incompatible with this project.',
      'INCOMPATIBLE_MIGRATION_TABLE',
    );
  }
}

export async function ensureMigrationTable(connection, databaseName = env.DB_NAME) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(191) NOT NULL,
      executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [[table]] = await connection.execute(
    `SELECT ENGINE AS engine, TABLE_COLLATION AS collation
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'schema_migrations'`,
    [databaseName],
  );
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME AS columnName, ORDINAL_POSITION AS ordinalPosition,
            DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
            CHARACTER_MAXIMUM_LENGTH AS maximumLength,
            DATETIME_PRECISION AS datetimePrecision,
            IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
            COLUMN_KEY AS columnKey, EXTRA AS extra
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'schema_migrations'
      ORDER BY ORDINAL_POSITION`,
    [databaseName],
  );
  const [indexes] = await connection.execute(
    `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'schema_migrations'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [databaseName],
  );

  validateMigrationTableMetadata(table, columns, indexes);
}

export async function runDiscoveredMigrations(
  connection,
  migrations,
  { databaseName = env.DB_NAME, onMigrationSelected = () => {} } = {},
) {
  await ensureMigrationTable(connection, databaseName);

  const [appliedRows] = await connection.query(
    'SELECT id FROM schema_migrations ORDER BY id',
  );
  const appliedIds = new Set(appliedRows.map((row) => row.id));
  const availableIds = new Set(migrations.map((migration) => migration.id));

  if (appliedRows.some((row) => !availableIds.has(row.id))) {
    throw createSafeError(
      'The database migration history is incompatible with this codebase.',
      'UNKNOWN_APPLIED_MIGRATION',
    );
  }

  for (const migration of migrations) {
    onMigrationSelected(migration.id);

    if (appliedIds.has(migration.id)) {
      console.log(`Skipping already applied migration: ${migration.id}`);
      continue;
    }

    console.log(`Applying migration: ${migration.id}`);
    await migration.up(connection, { databaseName });
    await connection.execute('INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
    console.log(`Applied migration: ${migration.id}`);
  }

  console.log('Database migrations are up to date.');
}

export async function runMigrations() {
  let connection = null;
  let lockAcquired = false;
  let activeMigrationId = null;

  try {
    const migrations = await loadMigrations();
    connection = await pool.getConnection();
    await acquireMigrationLock(connection);
    lockAcquired = true;
    await runDiscoveredMigrations(connection, migrations, {
      databaseName: env.DB_NAME,
      onMigrationSelected(migrationId) {
        activeMigrationId = migrationId;
      },
    });
  } catch (error) {
    if (error?.isSafeToDisplay) {
      console.error(error.message);
    } else {
      const errorCode = error?.code ?? 'MIGRATION_FAILED';
      const migrationContext = activeMigrationId ? ` for ${activeMigrationId}` : '';
      console.error(`Database migration failed${migrationContext} (${errorCode}).`);
    }

    process.exitCode = 1;
  } finally {
    if (connection && lockAcquired) {
      try {
        await connection.execute('SELECT RELEASE_LOCK(?)', [migrationLockName]);
      } catch {
        console.error('The migration lock could not be released cleanly.');
        process.exitCode = 1;
      }
    }

    connection?.release();

    try {
      await closeDatabasePool();
    } catch {
      console.error('The database pool could not be closed cleanly.');
      process.exitCode = 1;
    }
  }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  await runMigrations();
}
