import assert from 'node:assert/strict';
import { after, test } from 'node:test';

Object.assign(process.env, {
  PORT: '3000',
  CLIENT_URL: 'http://localhost:5173',
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
  DB_USER: 'metadata_test',
  DB_PASSWORD: '',
  DB_NAME: 'metadata_only_test',
});

const { validateMigrationTableMetadata } = await import('../src/db/migrate.js');
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
