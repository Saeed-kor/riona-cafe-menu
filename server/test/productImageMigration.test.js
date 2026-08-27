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

function createMigrationConnection({
  nullable = true,
  nullRows = [],
  defaultValue = null,
} = {}) {
  const calls = [];
  let currentNullable = nullable;

  return {
    calls,
    connection: {
      async execute(sql, parameters) {
        calls.push({ method: 'execute', sql, parameters });

        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return [[imageColumn(currentNullable ? 'YES' : 'NO', { defaultValue })], []];
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

function createMetadataConnection(columns) {
  const calls = [];

  return {
    calls,
    connection: {
      async execute(sql, parameters) {
        calls.push({ method: 'execute', sql, parameters });
        assert.match(sql, /INFORMATION_SCHEMA\.COLUMNS/);
        return [columns, []];
      },
      async query(sql) {
        calls.push({ method: 'query', sql });
        throw new Error(`Unexpected migration DDL: ${sql}`);
      },
    },
  };
}

async function assertIncompatibleBeforeDdl(columns) {
  const harness = createMetadataConnection(columns);

  await assert.rejects(
    up(harness.connection, { databaseName: 'disposable_test_database' }),
    (error) =>
      error.code === 'PRODUCT_IMAGE_SCHEMA_INCOMPATIBLE' &&
      error.isSafeToDisplay === true,
  );
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].method, 'execute');
  assert.match(harness.calls[0].sql, /INFORMATION_SCHEMA\.COLUMNS/);
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

test('accepts only the MySQL and normalized unquoted MariaDB no-default representations', async (context) => {
  const acceptedDefaults = [
    ['MySQL null', null],
    ['MariaDB uppercase NULL', 'NULL'],
    ['MariaDB lowercase null', 'null'],
    ['MariaDB case and surrounding whitespace', ' \tNuLl\r\n'],
  ];

  for (const [name, defaultValue] of acceptedDefaults) {
    await context.test(name, async () => {
      const harness = createMetadataConnection([
        imageColumn('NO', { defaultValue }),
      ]);

      const schema = await validateRequiredProductImageSchema(
        harness.connection,
        'disposable_test_database',
      );

      assert.deepEqual(schema, { nullable: false });
      assert.equal(Object.isFrozen(schema), true);
      assert.equal(harness.calls.length, 1);
    });
  }
});

test('accepts real MariaDB NULL metadata even though the previous strict-null condition rejects it', async () => {
  const mariaDbColumn = imageColumn('NO', { defaultValue: 'NULL' });
  const harness = createMetadataConnection([mariaDbColumn]);

  assert.equal(mariaDbColumn.defaultValue === null, false);
  await assert.doesNotReject(
    validateRequiredProductImageSchema(
      harness.connection,
      'disposable_test_database',
    ),
  );
});

test('rejects every non-null or non-canonical COLUMN_DEFAULT representation', async (context) => {
  const rejectedDefaults = [
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace-only string', ' \t\r\n'],
    ['single-quoted NULL literal', "'NULL'"],
    ['double-quoted NULL literal', '"NULL"'],
    ['other literal string', 'none'],
    ['CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP'],
    ['SQL expression', 'COALESCE(NULL, \'image.png\')'],
    ['number', 0],
    ['Boolean', false],
    ['object', { value: 'NULL' }],
    ['array', ['NULL']],
  ];

  for (const [name, defaultValue] of rejectedDefaults) {
    await context.test(name, async () => {
      await assertIncompatibleBeforeDdl([
        imageColumn('YES', { defaultValue }),
      ]);
    });
  }
});

test('preflights a MariaDB-compatible nullable schema before making only image_path NOT NULL', async () => {
  const harness = createMigrationConnection({ defaultValue: 'NULL' });

  await up(harness.connection, { databaseName: 'disposable_test_database' });

  assert.equal(
    harness.calls.filter((call) => call.method === 'query').length,
    1,
  );
  assert.match(harness.calls[1].sql, /image_path IS NULL/);
  assert.deepEqual(harness.calls[0].parameters, ['disposable_test_database']);
  assert.equal(
    harness.calls.filter((call) => call.sql.includes('INFORMATION_SCHEMA.COLUMNS')).length,
    2,
  );
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

test('rejects every protected image-column schema drift before issuing DDL', async (context) => {
  const driftedColumns = [
    ['missing metadata row', []],
    ['incomplete metadata row', [{}]],
    ['duplicate metadata rows', [imageColumn(), imageColumn()]],
    ['column name', [imageColumn('YES', { columnName: 'legacy_image_path' })]],
    ['ordinal position', [imageColumn('YES', { ordinalPosition: 7 })]],
    ['data type', [imageColumn('YES', { dataType: 'text' })]],
    ['column type', [imageColumn('YES', { columnType: 'varchar(255)' })]],
    ['maximum length', [imageColumn('YES', { maximumLength: 255 })]],
    ['character set', [imageColumn('YES', { characterSet: 'latin1' })]],
    ['collation', [imageColumn('YES', { collation: 'utf8mb4_bin' })]],
    ['nullability metadata', [imageColumn('MAYBE')]],
    ['extra metadata', [imageColumn('YES', { extra: 'DEFAULT_GENERATED' })]],
  ];

  for (const [name, columns] of driftedColumns) {
    await context.test(name, async () => {
      await assertIncompatibleBeforeDdl(columns);
    });
  }
});

test('required-schema validation still rejects a nullable image column', async () => {
  const harness = createMetadataConnection([imageColumn('YES')]);

  await assert.rejects(
    validateRequiredProductImageSchema(
      harness.connection,
      'disposable_test_database',
    ),
    (error) => error.code === 'PRODUCT_IMAGE_SCHEMA_INCOMPATIBLE',
  );
});
