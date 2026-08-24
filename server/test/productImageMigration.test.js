import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  id,
  up,
  validateRequiredProductImageSchema,
} from '../src/db/migrations/004_require_product_image.js';

function imageColumn(isNullable = 'YES', overrides = {}) {
  return {
    columnName: 'image_path',
    ordinalPosition: 6,
    dataType: 'varchar',
    columnType: 'varchar(2048)',
    maximumLength: 2048,
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    isNullable,
    defaultValue: null,
    extra: '',
    ...overrides,
  };
}

function createMigrationConnection({ nullable = true, nullRows = [] } = {}) {
  const calls = [];
  let currentNullable = nullable;

  return {
    calls,
    connection: {
      async execute(sql, parameters) {
        calls.push({ method: 'execute', sql, parameters });

        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return [[imageColumn(currentNullable ? 'YES' : 'NO')], []];
        }

        if (sql.includes('WHERE image_path IS NULL')) {
          return [nullRows, []];
        }

        throw new Error(`Unexpected migration SQL: ${sql}`);
      },
      async query(sql) {
        calls.push({ method: 'query', sql });
        assert.equal(
          sql,
          'ALTER TABLE menu_items MODIFY COLUMN image_path VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL',
        );
        currentNullable = false;
        return [{ affectedRows: 0 }, []];
      },
    },
  };
}

test('registers migration 004 after the immutable 001-003 sequence', async () => {
  const entries = (await readdir(new URL('../src/db/migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.js'))
    .sort((first, second) => first.localeCompare(second, 'en', { numeric: true }));

  assert.deepEqual(entries, [
    '001_create_core_tables.js',
    '002_create_admin_sessions.js',
    '003_enforce_unique_category_names.js',
    '004_require_product_image.js',
  ]);
  assert.equal(id, '004_require_product_image');
});

test('preflights null products before making only image_path NOT NULL', async () => {
  const harness = createMigrationConnection();

  await up(harness.connection, { databaseName: 'disposable_test_database' });

  assert.equal(
    harness.calls.filter((call) => call.method === 'query').length,
    1,
  );
  assert.match(harness.calls[1].sql, /image_path IS NULL/);
  assert.deepEqual(harness.calls[0].parameters, ['disposable_test_database']);
  await validateRequiredProductImageSchema(
    harness.connection,
    'disposable_test_database',
  );
});

test('stops safely before ALTER when a product has no image', async () => {
  const harness = createMigrationConnection({ nullRows: [{ incompatible: 1 }] });

  await assert.rejects(
    up(harness.connection, { databaseName: 'disposable_test_database' }),
    (error) =>
      error.code === 'PRODUCT_IMAGE_NULL_ROWS_EXIST' &&
      error.isSafeToDisplay === true &&
      error.message.includes('disposable_test_database') === false,
  );
  assert.equal(harness.calls.some((call) => call.method === 'query'), false);
});

test('is idempotent when image_path is already required', async () => {
  const harness = createMigrationConnection({ nullable: false });

  await up(harness.connection, { databaseName: 'disposable_test_database' });

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].sql.includes('INFORMATION_SCHEMA.COLUMNS'), true);
});

test('rejects drifted image columns without issuing DDL', async () => {
  const calls = [];
  const connection = {
    async execute(sql) {
      calls.push({ method: 'execute', sql });
      return [[imageColumn('YES', { maximumLength: 255, columnType: 'varchar(255)' })], []];
    },
    async query(sql) {
      calls.push({ method: 'query', sql });
    },
  };

  await assert.rejects(
    up(connection, { databaseName: 'disposable_test_database' }),
    (error) => error.code === 'PRODUCT_IMAGE_SCHEMA_INCOMPATIBLE',
  );
  assert.equal(calls.some((call) => call.method === 'query'), false);
});
