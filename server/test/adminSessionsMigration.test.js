import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAdminSessionsMetadata } from '../src/db/migrations/002_create_admin_sessions.js';

function validMetadata() {
  return {
    table: { engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' },
    columns: [
      {
        columnName: 'id',
        dataType: 'bigint',
        columnType: 'bigint(20) unsigned',
        isNullable: 'NO',
        maximumLength: null,
        datetimePrecision: null,
        defaultValue: null,
        extra: 'auto_increment',
        characterSet: null,
        collation: null,
      },
      {
        columnName: 'admin_id',
        dataType: 'bigint',
        columnType: 'bigint(20) unsigned',
        isNullable: 'NO',
        maximumLength: null,
        datetimePrecision: null,
        defaultValue: null,
        extra: '',
        characterSet: null,
        collation: null,
      },
      {
        columnName: 'token_hash',
        dataType: 'char',
        columnType: 'char(64)',
        isNullable: 'NO',
        maximumLength: 64,
        datetimePrecision: null,
        defaultValue: null,
        extra: '',
        characterSet: 'ascii',
        collation: 'ascii_bin',
      },
      {
        columnName: 'expires_at',
        dataType: 'datetime',
        columnType: 'datetime(3)',
        isNullable: 'NO',
        maximumLength: null,
        datetimePrecision: 3,
        defaultValue: null,
        extra: '',
        characterSet: null,
        collation: null,
      },
      {
        columnName: 'created_at',
        dataType: 'datetime',
        columnType: 'datetime(3)',
        isNullable: 'NO',
        maximumLength: null,
        datetimePrecision: 3,
        defaultValue: 'current_timestamp(3)',
        extra: '',
        characterSet: null,
        collation: null,
      },
    ],
    indexes: [
      { indexName: 'PRIMARY', nonUnique: 0, sequenceNumber: 1, columnName: 'id' },
      {
        indexName: 'idx_admin_sessions_admin_id',
        nonUnique: 1,
        sequenceNumber: 1,
        columnName: 'admin_id',
      },
      {
        indexName: 'idx_admin_sessions_expires_at',
        nonUnique: 1,
        sequenceNumber: 1,
        columnName: 'expires_at',
      },
      {
        indexName: 'uq_admin_sessions_token_hash',
        nonUnique: 0,
        sequenceNumber: 1,
        columnName: 'token_hash',
      },
    ],
    foreignKeys: [
      {
        constraintName: 'fk_admin_sessions_admin',
        columnName: 'admin_id',
        referencedTableName: 'admins',
        referencedColumnName: 'id',
        deleteRule: 'CASCADE',
        updateRule: 'RESTRICT',
      },
    ],
  };
}

test('accepts the exact admin_sessions persistence schema', () => {
  assert.doesNotThrow(() => validateAdminSessionsMetadata(validMetadata()));
});

test('rejects a session table that can compare token hashes case-insensitively', () => {
  const metadata = validMetadata();
  metadata.columns[2].collation = 'ascii_general_ci';

  assert.throws(
    () => validateAdminSessionsMetadata(metadata),
    (error) => error.code === 'ADMIN_SESSIONS_SCHEMA_VALIDATION_FAILED',
  );
});
