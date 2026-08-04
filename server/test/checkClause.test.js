import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCheckClause,
  validateCoreCheckMetadata,
  validateCoreColumnMetadata,
} from '../src/db/migrations/001_create_core_tables.js';

test('normalizes only insignificant MariaDB check-clause formatting', () => {
  const expected = 'is_visible IN (0, 1)';
  const formattedByMariaDb = ' ( ( `IS_VISIBLE`   in( 0, 1 ) ) ) ';

  assert.equal(normalizeCheckClause(formattedByMariaDb), normalizeCheckClause(expected));
});

test('does not erase semantic differences in check clauses', () => {
  const expected = normalizeCheckClause('is_visible IN (0, 1)');

  assert.notEqual(normalizeCheckClause('is_visiblein(0, 1)'), expected);
  assert.notEqual(normalizeCheckClause('is_available IN (0, 1)'), expected);
  assert.notEqual(normalizeCheckClause('is_visible NOT IN (0, 1)'), expected);
  assert.notEqual(normalizeCheckClause('is_visible IN (0, 2)'), expected);
  assert.notEqual(normalizeCheckClause('1 = 1'), expected);
});

test('rejects an identifier-keyword token collision through the production validator', () => {
  const expected = 'is_visible IN (0, 1)';
  const invalid = 'is_visiblein(0, 1)';

  assert.notEqual(normalizeCheckClause(invalid), normalizeCheckClause(expected));
  assert.doesNotThrow(() =>
    validateCoreCheckMetadata('categories', [
      { constraintName: 'chk_categories_is_visible', checkClause: expected },
    ]),
  );
  assert.throws(
    () =>
      validateCoreCheckMetadata('categories', [
        { constraintName: 'chk_categories_is_visible', checkClause: invalid },
      ]),
    (error) => error.code === 'CORE_SCHEMA_VALIDATION_FAILED',
  );
});

test('preserves whitespace and case inside quoted string values', () => {
  assert.notEqual(normalizeCheckClause("label = 'A B'"), normalizeCheckClause("label = 'AB'"));
  assert.notEqual(normalizeCheckClause("label = 'A'"), normalizeCheckClause("label = 'a'"));
});

test('validates the exact expected check-constraint set and clause', () => {
  const correctChecks = [
    {
      constraintName: 'chk_categories_is_visible',
      checkClause: '((`IS_VISIBLE` in (0, 1)))',
    },
  ];

  assert.doesNotThrow(() => validateCoreCheckMetadata('categories', correctChecks));
  assert.throws(
    () =>
      validateCoreCheckMetadata('categories', [
        { constraintName: 'chk_categories_is_visible', checkClause: '1 = 1' },
      ]),
    (error) => error.code === 'CORE_SCHEMA_VALIDATION_FAILED',
  );
  assert.throws(
    () => validateCoreCheckMetadata('categories', []),
    (error) => error.code === 'CORE_SCHEMA_VALIDATION_FAILED',
  );
  assert.throws(
    () =>
      validateCoreCheckMetadata('categories', [
        ...correctChecks,
        { constraintName: 'chk_categories_extra', checkClause: 'display_order < 1000' },
      ]),
    (error) => error.code === 'CORE_SCHEMA_VALIDATION_FAILED',
  );
});

test('validates structured DATETIME(3) defaults and ON UPDATE metadata', () => {
  const createdAt = {
    columnName: 'created_at',
    dataType: 'DATETIME',
    columnType: 'DATETIME(3)',
    datetimePrecision: 3,
    isNullable: 'NO',
    maximumLength: null,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
    extra: '',
  };
  const updatedAt = {
    ...createdAt,
    columnName: 'updated_at',
    extra: 'ON UPDATE CURRENT_TIMESTAMP(3)',
  };

  assert.doesNotThrow(() => validateCoreColumnMetadata('admins', createdAt));
  assert.doesNotThrow(() => validateCoreColumnMetadata('admins', updatedAt));

  for (const incompatibleColumn of [
    { ...createdAt, columnType: 'datetime', datetimePrecision: 0 },
    { ...createdAt, defaultValue: null },
    { ...createdAt, isNullable: 'YES' },
    { ...updatedAt, extra: '' },
    { ...updatedAt, extra: 'ON UPDATE CURRENT_TIMESTAMP' },
  ]) {
    assert.throws(
      () => validateCoreColumnMetadata('admins', incompatibleColumn),
      (error) => error.code === 'CORE_SCHEMA_VALIDATION_FAILED',
    );
  }
});
