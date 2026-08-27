import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { configureTestEnvironment } from '../test-support/testEnvironment.js';

configureTestEnvironment();
Object.assign(process.env, {
  PORT: '3000',
  CLIENT_URL: 'http://localhost:5173',
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
  DB_USER: 'metadata_test',
  DB_PASSWORD: '',
  DB_NAME: 'metadata_only_test',
});

const {
  loadMigrations,
  runDiscoveredMigrations,
  validateMigrationTableMetadata,
} = await import('../src/db/migrate.js');
const { closeDatabasePool } = await import('../src/config/db.js');

after(async () => {
  await closeDatabasePool();
});

const correctTable = {
  engine: 'InnoDB',
  collation: 'utf8mb4_unicode_ci',
};
const correctColumns = [
  {
    columnName: 'id',
    ordinalPosition: 1,
    dataType: 'varchar',
    columnType: 'varchar(191)',
    maximumLength: 191,
    datetimePrecision: null,
    isNullable: 'NO',
    defaultValue: null,
    columnKey: 'PRI',
    extra: '',
  },
  {
    columnName: 'executed_at',
    ordinalPosition: 2,
    dataType: 'datetime',
    columnType: 'datetime(3)',
    maximumLength: null,
    datetimePrecision: 3,
    isNullable: 'NO',
    defaultValue: 'CURRENT_TIMESTAMP(3)',
    columnKey: '',
    extra: '',
  },
];
const correctIndexes = [
  {
    indexName: 'PRIMARY',
    nonUnique: 0,
    sequenceNumber: 1,
    columnName: 'id',
  },
];
const appliedMigrationIds = [
  '001_create_core_tables',
  '002_create_admin_sessions',
  '003_enforce_unique_category_names',
];
const productImageMigrationId = '004_require_product_image';

function productImageColumn(isNullable) {
  return {
    columnName: 'image_path',
    ordinalPosition: 6,
    dataType: 'varchar',
    columnType: 'varchar(2048)',
    maximumLength: 2048,
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    isNullable,
    defaultValue: 'NULL',
    extra: '',
  };
}

function createRunnerHarness({ hasNullProduct }) {
  const calls = [];
  let imageColumnIsNullable = true;

  return {
    calls,
    connection: {
      async query(sql, parameters) {
        calls.push({ method: 'query', sql, parameters });

        if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) {
          return [{ affectedRows: 0 }, []];
        }

        if (sql === 'SELECT id FROM schema_migrations ORDER BY id') {
          return [appliedMigrationIds.map((id) => ({ id })), []];
        }

        if (/^ALTER TABLE menu_items MODIFY COLUMN image_path/.test(sql)) {
          imageColumnIsNullable = false;
          return [{ affectedRows: 0 }, []];
        }

        throw new Error(`Unexpected runner query: ${sql}`);
      },
      async execute(sql, parameters) {
        calls.push({ method: 'execute', sql, parameters });

        if (
          sql.includes('INFORMATION_SCHEMA.TABLES') &&
          sql.includes("TABLE_NAME = 'schema_migrations'")
        ) {
          return [[structuredClone(correctTable)], []];
        }

        if (
          sql.includes('INFORMATION_SCHEMA.COLUMNS') &&
          sql.includes("TABLE_NAME = 'schema_migrations'")
        ) {
          return [structuredClone(correctColumns), []];
        }

        if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) {
          return [structuredClone(correctIndexes), []];
        }

        if (
          sql.includes('INFORMATION_SCHEMA.COLUMNS') &&
          sql.includes("TABLE_NAME = 'menu_items'")
        ) {
          return [[productImageColumn(imageColumnIsNullable ? 'YES' : 'NO')], []];
        }

        if (sql.includes('WHERE image_path IS NULL')) {
          return [hasNullProduct ? [{ incompatible: 1 }] : [], []];
        }

        if (sql === 'INSERT INTO schema_migrations (id) VALUES (?)') {
          return [{ affectedRows: 1 }, []];
        }

        throw new Error(`Unexpected runner statement: ${sql}`);
      },
    },
  };
}

function findCallIndex(calls, predicate) {
  const index = calls.findIndex(predicate);
  assert.notEqual(index, -1);
  return index;
}

function isProductImageRegistration(call) {
  return (
    call.method === 'execute' &&
    call.sql === 'INSERT INTO schema_migrations (id) VALUES (?)' &&
    call.parameters?.[0] === productImageMigrationId
  );
}

function assertTrackerRejected(columns = correctColumns, indexes = correctIndexes) {
  assert.throws(
    () => validateMigrationTableMetadata(correctTable, columns, indexes),
    (error) =>
      error.code === 'INCOMPATIBLE_MIGRATION_TABLE' && error.isSafeToDisplay === true,
  );
}

test('accepts the exact schema_migrations metadata', () => {
  assert.doesNotThrow(() =>
    validateMigrationTableMetadata(correctTable, correctColumns, correctIndexes),
  );
});

test('production runner does not register migration 004 when its pre-DDL data check fails', async () => {
  const migrations = await loadMigrations();
  const harness = createRunnerHarness({ hasNullProduct: true });

  assert.deepEqual(
    migrations.map((migration) => migration.id),
    [...appliedMigrationIds, productImageMigrationId],
  );
  await assert.rejects(
    runDiscoveredMigrations(harness.connection, migrations, {
      databaseName: 'disposable_test_database',
    }),
    (error) =>
      error.code === 'PRODUCT_IMAGE_NULL_ROWS_EXIST' &&
      error.isSafeToDisplay === true,
  );

  assert.equal(
    harness.calls.some(
      (call) => call.method === 'query' && /^ALTER TABLE\b/.test(call.sql),
    ),
    false,
  );
  assert.equal(harness.calls.some(isProductImageRegistration), false);
  assert.equal(
    harness.calls.some((call) => /\bINSERT\s+INTO\s+schema_migrations\b/i.test(call.sql)),
    false,
  );
  assert.notEqual(
    harness.calls.findIndex((call) => call.sql.includes('WHERE image_path IS NULL')),
    -1,
  );
});

test('production runner registers migration 004 once and only after its successful up', async () => {
  const migrations = await loadMigrations();
  const harness = createRunnerHarness({ hasNullProduct: false });

  await runDiscoveredMigrations(harness.connection, migrations, {
    databaseName: 'disposable_test_database',
  });

  const productMetadataCalls = harness.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) =>
      call.sql.includes('INFORMATION_SCHEMA.COLUMNS') &&
      call.sql.includes("TABLE_NAME = 'menu_items'"),
    );
  const nullPreflightIndex = findCallIndex(
    harness.calls,
    (call) => call.sql.includes('WHERE image_path IS NULL'),
  );
  const ddlIndex = findCallIndex(
    harness.calls,
    (call) => call.method === 'query' && /^ALTER TABLE menu_items\b/.test(call.sql),
  );
  const registrationIndexes = harness.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => isProductImageRegistration(call));
  const allRegistrationCalls = harness.calls.filter(
    (call) => call.sql === 'INSERT INTO schema_migrations (id) VALUES (?)',
  );
  const ddlCalls = harness.calls.filter(
    (call) => call.method === 'query' && /^ALTER TABLE menu_items\b/.test(call.sql),
  );

  assert.equal(productMetadataCalls.length, 2);
  assert.equal(registrationIndexes.length, 1);
  assert.equal(allRegistrationCalls.length, 1);
  assert.equal(ddlCalls.length, 1);
  assert.deepEqual(registrationIndexes[0].call.parameters, [productImageMigrationId]);
  assert.ok(productMetadataCalls[0].index < nullPreflightIndex);
  assert.ok(nullPreflightIndex < ddlIndex);
  assert.ok(ddlIndex < productMetadataCalls[1].index);
  assert.ok(productMetadataCalls[1].index < registrationIndexes[0].index);
});

test('rejects VARCHAR(32) migration ids', () => {
  const columns = structuredClone(correctColumns);
  columns[0].columnType = 'varchar(32)';
  columns[0].maximumLength = 32;
  assertTrackerRejected(columns);
});

test('rejects incompatible executed_at precision, nullability, default, and extra metadata', () => {
  for (const changes of [
    { columnType: 'datetime', datetimePrecision: 0 },
    { isNullable: 'YES' },
    { defaultValue: null },
    { defaultValue: '2000-01-01 00:00:00.000' },
    { extra: 'on update current_timestamp(3)' },
  ]) {
    const columns = structuredClone(correctColumns);
    Object.assign(columns[1], changes);
    assertTrackerRejected(columns);
  }
});

test('rejects additional columns and an incompatible primary key', () => {
  assertTrackerRejected([
    ...structuredClone(correctColumns),
    {
      columnName: 'required_value',
      ordinalPosition: 3,
      dataType: 'int',
      columnType: 'int(11)',
      maximumLength: null,
      datetimePrecision: null,
      isNullable: 'NO',
      defaultValue: null,
      columnKey: '',
      extra: '',
    },
  ]);
  assertTrackerRejected(correctColumns, [
    { indexName: 'PRIMARY', nonUnique: 0, sequenceNumber: 1, columnName: 'executed_at' },
  ]);
  assertTrackerRejected(correctColumns, [
    ...correctIndexes,
    {
      indexName: 'uq_schema_migrations_executed_at',
      nonUnique: 0,
      sequenceNumber: 1,
      columnName: 'executed_at',
    },
  ]);
});
