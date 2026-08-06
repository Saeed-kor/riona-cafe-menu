import assert from 'node:assert/strict';
import test from 'node:test';

import {
  up,
  validateCategoryNameColumnMetadata,
  validateCategoryNameIndexMetadata,
} from '../src/db/migrations/003_enforce_unique_category_names.js';

const expectedIndex = [
  {
    indexName: 'uq_categories_name',
    nonUnique: 0,
    sequenceNumber: 1,
    columnName: 'name',
    subPart: null,
  },
];

const prefixIndex = [{ ...expectedIndex[0], subPart: 10 }];

const expectedColumn = {
  dataType: 'varchar',
  columnType: 'varchar(100)',
  maximumLength: 100,
  isNullable: 'NO',
  defaultValue: null,
  extra: '',
  characterSet: 'utf8mb4',
  collation: 'utf8mb4_unicode_ci',
};

test('accepts only the exact unique category-name index', () => {
  assert.equal(validateCategoryNameIndexMetadata(expectedIndex), true);
  assert.equal(validateCategoryNameIndexMetadata([], true), false);

  for (const indexes of [
    [{ ...expectedIndex[0], nonUnique: 1 }],
    [{ ...expectedIndex[0], columnName: 'id' }],
    [{ ...expectedIndex[0], subPart: 10 }],
    [{ ...expectedIndex[0], subPart: '10' }],
    [{ ...expectedIndex[0], subPart: undefined }],
    [...expectedIndex, { ...expectedIndex[0], sequenceNumber: 2 }],
  ]) {
    assert.throws(
      () => validateCategoryNameIndexMetadata(indexes),
      (error) => error.code === 'CATEGORY_SCHEMA_VALIDATION_FAILED',
    );
  }
});

test('prefixUniqueIndexAcceptedAsExact is false', () => {
  let prefixUniqueIndexAcceptedAsExact = true;

  try {
    validateCategoryNameIndexMetadata(prefixIndex);
  } catch {
    prefixUniqueIndexAcceptedAsExact = false;
  }

  assert.equal(prefixUniqueIndexAcceptedAsExact, false);
});

test('validates the category-name definition separately from its character metadata', () => {
  assert.equal(validateCategoryNameColumnMetadata(expectedColumn), true);
  assert.equal(
    validateCategoryNameColumnMetadata({
      ...expectedColumn,
      collation: 'utf8mb4_bin',
    }),
    false,
  );
  assert.equal(
    validateCategoryNameColumnMetadata({
      ...expectedColumn,
      characterSet: 'latin1',
      collation: 'latin1_swedish_ci',
    }),
    false,
  );

  for (const column of [
    { ...expectedColumn, columnType: 'varchar(120)', maximumLength: 120 },
    { ...expectedColumn, isNullable: 'YES' },
    { ...expectedColumn, defaultValue: '' },
  ]) {
    assert.throws(
      () => validateCategoryNameColumnMetadata(column),
      (error) => error.code === 'CATEGORY_SCHEMA_VALIDATION_FAILED',
    );
  }
});

function normalizeForTargetCollation(value) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en');
}

function createMigrationConnection({
  tableCollation = 'utf8mb4_unicode_ci',
  column = expectedColumn,
  indexes = [],
  categoryNames = [],
  preserveIndexesAfterReplacement = false,
} = {}) {
  const queries = [];
  const state = {
    tableCollation,
    column: { ...column },
    indexes: indexes.map((index) => ({ ...index })),
  };

  return {
    queries,
    state,
    connection: {
      async execute(sql, parameters) {
        queries.push({ sql, parameters, method: 'execute' });

        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
          return [[{ engine: 'InnoDB', collation: state.tableCollation }], []];
        }

        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return [[{ ...state.column }], []];
        }

        if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) {
          return [state.indexes.map((index) => ({ ...index })), []];
        }

        throw new Error(`Unexpected execute in migration test: ${sql}`);
      },
      async query(sql) {
        queries.push({ sql, method: 'query' });

        if (sql.includes('SELECT 1 AS duplicateExists')) {
          if (
            !sql.includes(
              'GROUP BY CONVERT(name USING utf8mb4) COLLATE utf8mb4_unicode_ci',
            )
          ) {
            throw new Error('Duplicate detection did not use the target collation.');
          }

          const normalizedNames = categoryNames.map(normalizeForTargetCollation);
          const hasEquivalentNames = new Set(normalizedNames).size !== normalizedNames.length;
          return [hasEquivalentNames ? [{ duplicateExists: 1 }] : [], []];
        }

        if (sql.includes('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')) {
          state.tableCollation = 'utf8mb4_unicode_ci';
          return [{ affectedRows: 0 }, []];
        }

        if (sql.includes('MODIFY COLUMN name VARCHAR(100)')) {
          assert.match(sql, /CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL/);
          state.column = { ...expectedColumn };
          return [{ affectedRows: 0 }, []];
        }

        if (
          sql.includes('DROP INDEX uq_categories_name') &&
          sql.includes('ADD UNIQUE KEY uq_categories_name (name)')
        ) {
          if (!preserveIndexesAfterReplacement) {
            state.indexes = expectedIndex.map((index) => ({ ...index }));
          }
          return [{ affectedRows: 0 }, []];
        }

        if (sql.includes('ADD UNIQUE KEY uq_categories_name (name)')) {
          state.indexes = expectedIndex.map((index) => ({ ...index }));
          return [{ affectedRows: 0 }, []];
        }

        throw new Error(`Unexpected query in migration test: ${sql}`);
      },
    },
  };
}

test('checks target-collation duplicates before adding the unique index to an aligned schema', async () => {
  const { connection, queries } = createMigrationConnection({ categoryNames: ['قهوه', 'چای'] });

  await up(connection, { databaseName: 'riona_test' });

  const columnInspectionIndex = queries.findIndex(({ sql }) =>
    sql.includes('INFORMATION_SCHEMA.COLUMNS'),
  );
  const duplicateCheckIndex = queries.findIndex(({ sql }) =>
    sql.includes('SELECT 1 AS duplicateExists'),
  );
  const indexCreationIndex = queries.findIndex(({ sql }) =>
    sql.includes('ADD UNIQUE KEY uq_categories_name (name)'),
  );

  assert.ok(columnInspectionIndex >= 0);
  assert.ok(duplicateCheckIndex > columnInspectionIndex);
  assert.ok(indexCreationIndex > duplicateCheckIndex);
  assert.equal(
    queries.some(({ sql }) => sql.includes('MODIFY COLUMN name')),
    false,
  );
});

test('aligns a drifted table and binary name column before creating the index', async () => {
  const { connection, queries, state } = createMigrationConnection({
    tableCollation: 'utf8mb4_bin',
    column: { ...expectedColumn, collation: 'utf8mb4_bin' },
    categoryNames: ['Coffee', 'Tea'],
  });

  await up(connection, { databaseName: 'riona_test' });

  const duplicateCheckIndex = queries.findIndex(({ sql }) =>
    sql.includes('SELECT 1 AS duplicateExists'),
  );
  const tableAlignmentIndex = queries.findIndex(({ sql }) =>
    sql.includes('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'),
  );
  const columnAlignmentIndex = queries.findIndex(({ sql }) =>
    sql.includes('MODIFY COLUMN name VARCHAR(100)'),
  );
  const indexCreationIndex = queries.findIndex(({ sql }) =>
    sql.includes('ADD UNIQUE KEY uq_categories_name (name)'),
  );

  assert.ok(tableAlignmentIndex > duplicateCheckIndex);
  assert.ok(columnAlignmentIndex > tableAlignmentIndex);
  assert.ok(indexCreationIndex > columnAlignmentIndex);
  assert.equal(state.tableCollation, 'utf8mb4_unicode_ci');
  assert.equal(state.column.collation, 'utf8mb4_unicode_ci');
  assert.deepEqual(state.indexes, expectedIndex);
});

test('aligns only a binary name column when the table default is already correct', async () => {
  const { connection, queries, state } = createMigrationConnection({
    column: { ...expectedColumn, collation: 'utf8mb4_bin' },
    categoryNames: ['Coffee', 'Tea'],
  });

  await up(connection, { databaseName: 'riona_test' });

  const duplicateCheckIndex = queries.findIndex(({ sql }) =>
    sql.includes('SELECT 1 AS duplicateExists'),
  );
  const columnAlignmentIndex = queries.findIndex(({ sql }) =>
    sql.includes('MODIFY COLUMN name VARCHAR(100)'),
  );
  const indexCreationIndex = queries.findIndex(({ sql }) =>
    sql.includes('ADD UNIQUE KEY uq_categories_name (name)'),
  );

  assert.equal(
    queries.some(({ sql }) =>
      sql.includes('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'),
    ),
    false,
  );
  assert.ok(columnAlignmentIndex > duplicateCheckIndex);
  assert.ok(indexCreationIndex > columnAlignmentIndex);
  assert.equal(state.column.collation, 'utf8mb4_unicode_ci');
});

test('detects target-collation equivalents while the current name column is binary', async () => {
  const { connection, queries, state } = createMigrationConnection({
    column: { ...expectedColumn, collation: 'utf8mb4_bin' },
    indexes: prefixIndex,
    categoryNames: ['Cafe', 'CAFÉ'],
  });

  await assert.rejects(
    up(connection, { databaseName: 'riona_test' }),
    (error) =>
      error.code === 'DUPLICATE_CATEGORY_NAMES_EXIST' && error.isSafeToDisplay === true,
  );

  assert.equal(
    queries.some(({ sql }) => /^\s*ALTER TABLE categories/u.test(sql)),
    false,
  );
  assert.equal(state.column.collation, 'utf8mb4_bin');
  assert.deepEqual(state.indexes, prefixIndex);
});

test('replaces a same-name prefix index and validates the full-column replacement', async () => {
  const { connection, queries, state } = createMigrationConnection({
    indexes: prefixIndex,
    categoryNames: ['Coffee', 'Tea'],
  });

  await up(connection, { databaseName: 'riona_test' });

  const duplicateCheckIndex = queries.findIndex(({ sql }) =>
    sql.includes('SELECT 1 AS duplicateExists'),
  );
  const replacementIndex = queries.findIndex(
    ({ sql }) =>
      sql.includes('DROP INDEX uq_categories_name') &&
      sql.includes('ADD UNIQUE KEY uq_categories_name (name)'),
  );
  const statisticsQueries = queries.filter(({ sql }) =>
    sql.includes('INFORMATION_SCHEMA.STATISTICS'),
  );

  assert.ok(replacementIndex > duplicateCheckIndex);
  assert.equal(
    queries.filter(({ sql }) => /^\s*ALTER TABLE categories/u.test(sql)).length,
    1,
  );
  assert.equal(statisticsQueries.length, 2);
  assert.equal(
    statisticsQueries.every(({ sql }) => sql.includes('SUB_PART AS subPart')),
    true,
  );
  assert.deepEqual(state.indexes, expectedIndex);
});

test('fails final validation when a prefix index remains after replacement DDL', async () => {
  const { connection, queries } = createMigrationConnection({
    indexes: prefixIndex,
    categoryNames: ['Coffee'],
    preserveIndexesAfterReplacement: true,
  });

  await assert.rejects(
    up(connection, { databaseName: 'riona_test' }),
    (error) => error.code === 'CATEGORY_SCHEMA_VALIDATION_FAILED',
  );
  assert.equal(
    queries.filter(
      ({ sql }) =>
        sql.includes('DROP INDEX uq_categories_name') &&
        sql.includes('ADD UNIQUE KEY uq_categories_name (name)'),
    ).length,
    1,
  );
});

test('performs no DDL for an exact full-column index with an explicit null subPart', async () => {
  const { connection, queries } = createMigrationConnection({ indexes: expectedIndex });

  await up(connection, { databaseName: 'riona_test' });
  await up(connection, { databaseName: 'riona_test' });

  assert.equal(
    queries.some(({ sql }) => sql.includes('SELECT 1 AS duplicateExists')),
    false,
  );
  assert.equal(
    queries.some(({ sql }) => /^\s*ALTER TABLE categories/u.test(sql)),
    false,
  );
});

test('is idempotent after the schema and exact unique index have been aligned', async () => {
  const { connection, queries } = createMigrationConnection({ categoryNames: ['Coffee'] });

  await up(connection, { databaseName: 'riona_test' });
  await up(connection, { databaseName: 'riona_test' });

  assert.equal(
    queries.filter(({ sql }) => sql.includes('SELECT 1 AS duplicateExists')).length,
    1,
  );
  assert.equal(
    queries.filter(({ sql }) => sql.includes('ADD UNIQUE KEY uq_categories_name (name)')).length,
    1,
  );
  assert.equal(
    queries.filter(({ sql }) => sql.includes('MODIFY COLUMN name')).length,
    0,
  );
});
