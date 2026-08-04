import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeIntegrationDatabase,
  integrationOwnershipTableName,
  runFailSafeCleanup,
  validateIntegrationDatabaseConfiguration,
} from '../test-support/integrationDatabase.js';

const ownershipToken = '123e4567-e89b-42d3-a456-426614174000';
const ownedDatabaseName = `riona_integration_${ownershipToken.replaceAll('-', '_')}`;

function createConfiguration(overrides = {}) {
  return {
    enabled: '1',
    target: {
      host: '127.0.0.1',
      port: '3307',
      user: 'integration_runner',
      password: '',
      database: ownedDatabaseName,
      ownershipToken,
      ...overrides.target,
    },
    production: {
      host: 'localhost',
      port: '3306',
      database: 'riona_cafe_menu',
      ...overrides.production,
    },
  };
}

function createOwnedDatabaseConnection({ ownership = ownershipToken, extraTable = null } = {}) {
  const statements = [];
  const connection = {
    async execute(statement) {
      statements.push(statement);

      if (statement.includes('GET_LOCK')) {
        return [[{ acquired: 1 }]];
      }

      if (statement.includes('RELEASE_LOCK')) {
        return [[{ released: 1 }]];
      }

      if (statement.includes('SELECT DATABASE()')) {
        return [[{ databaseName: ownedDatabaseName }]];
      }

      if (statement.includes(integrationOwnershipTableName)) {
        return [[{ ownershipToken: ownership }]];
      }

      if (statement.includes('INFORMATION_SCHEMA.TABLES')) {
        const tables = [{ tableName: integrationOwnershipTableName }];
        if (extraTable) {
          tables.push({ tableName: extraTable });
        }
        return [tables];
      }

      throw new Error('Unexpected query in integration safety test.');
    },
  };

  return { connection, statements };
}

function isDestructiveStatement(statement) {
  return /\b(?:DROP|ALTER|TRUNCATE|DELETE)\b/i.test(statement);
}

test('rejects staging-style and production targets before issuing any database query', async () => {
  for (const configuration of [
    createConfiguration({ target: { database: 'staging_test' } }),
    createConfiguration({
      target: { host: '127.0.0.1', port: '3306' },
      production: { database: ownedDatabaseName },
    }),
  ]) {
    const { connection, statements } = createOwnedDatabaseConnection();

    await assert.rejects(
      authorizeIntegrationDatabase(connection, configuration),
      (error) => error.isSafeToDisplay === true,
    );
    assert.deepEqual(statements, []);
  }
});

test('requires the matching ownership sentinel and a pristine run-specific database', async () => {
  for (const unsafeConnection of [
    createOwnedDatabaseConnection({ ownership: '00000000-0000-4000-8000-000000000000' }),
    createOwnedDatabaseConnection({ extraTable: 'unrelated_table' }),
  ]) {
    await assert.rejects(
      authorizeIntegrationDatabase(unsafeConnection.connection, createConfiguration()),
      (error) => error.code === 'INTEGRATION_DATABASE_OWNERSHIP_UNVERIFIED',
    );
    assert.equal(unsafeConnection.statements.some(isDestructiveStatement), false);
    assert.equal(
      unsafeConnection.statements.some((statement) => statement.includes('RELEASE_LOCK')),
      true,
    );
  }
});

test('authorizes only the matching run-specific sentinel under an advisory lock', async () => {
  const { connection, statements } = createOwnedDatabaseConnection();
  const authorization = await authorizeIntegrationDatabase(connection, createConfiguration());

  assert.equal(authorization.database, ownedDatabaseName);
  assert.equal(authorization.ownershipToken, ownershipToken);
  assert.equal(statements[0].includes('GET_LOCK'), true);
  assert.equal(statements.some(isDestructiveStatement), false);
});

test('runs every cleanup step and preserves primary and cleanup failures', async () => {
  const calls = [];
  const primaryError = new Error('Primary test failure.');

  await assert.rejects(
    runFailSafeCleanup(
      [
        {
          name: 'reset schema',
          action: async () => {
            calls.push('reset');
            throw new Error('Reset failed.');
          },
        },
        {
          name: 'close connection',
          action: async () => {
            calls.push('connection');
            throw new Error('Connection close failed.');
          },
        },
        {
          name: 'close pool',
          action: async () => {
            calls.push('pool');
          },
        },
      ],
      { primaryError },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 3 &&
      error.errors[0] === primaryError &&
      error.errors.slice(1).every((cleanupError) => cleanupError.cause instanceof Error),
  );

  assert.deepEqual(calls, ['reset', 'connection', 'pool']);
});

test('validates a correctly isolated configuration without touching a database', () => {
  const authorization = validateIntegrationDatabaseConfiguration(createConfiguration());

  assert.equal(authorization.database, ownedDatabaseName);
  assert.equal(authorization.lockName.includes(ownershipToken), true);
});
