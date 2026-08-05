import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

import { up, validateCoreSchema } from '../src/db/migrations/001_create_core_tables.js';
import { validateAdminSessionsSchema } from '../src/db/migrations/002_create_admin_sessions.js';
import {
  up as enforceUniqueCategoryNames,
  validateCategoryManagementSchema,
} from '../src/db/migrations/003_enforce_unique_category_names.js';
import {
  authorizeIntegrationDatabase,
  releaseIntegrationDatabaseLock,
  runFailSafeCleanup,
  validateIntegrationDatabaseConfiguration,
} from '../test-support/integrationDatabase.js';

const serverRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const envFilePath = fileURLToPath(new URL('../.env', import.meta.url));

dotenv.config({ path: envFilePath, quiet: true });

const integrationConfiguration = {
  enabled: process.env.RUN_DB_INTEGRATION_TESTS,
  target: {
    host: process.env.TEST_DB_HOST,
    port: process.env.TEST_DB_PORT,
    user: process.env.TEST_DB_USER,
    password: process.env.TEST_DB_PASSWORD ?? '',
    database: process.env.TEST_DB_NAME,
    ownershipToken: process.env.TEST_DB_OWNERSHIP_TOKEN,
  },
  production: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
  },
};

let integrationSkipReason = false;
let integrationConfigurationError = null;
let validatedIntegrationTarget = null;

if (process.env.RUN_DB_INTEGRATION_TESTS !== '1') {
  integrationSkipReason = 'Set RUN_DB_INTEGRATION_TESTS=1 to enable destructive test-schema checks.';
} else {
  try {
    validatedIntegrationTarget = validateIntegrationDatabaseConfiguration(integrationConfiguration);
  } catch (error) {
    integrationConfigurationError = error;
  }
}

const testDatabaseName = validatedIntegrationTarget?.database ?? '';
const coreTableNames = ['admins', 'categories', 'menu_items', 'cafe_settings'];

async function resetTestSchema(connection) {
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  let resetError = null;

  try {
    for (const tableName of [
      'admin_sessions',
      'menu_items',
      'categories',
      'admins',
      'cafe_settings',
      'schema_migrations',
    ]) {
      await connection.query(`DROP TABLE IF EXISTS ${tableName}`);
    }
  } catch (error) {
    resetError = error;
  }

  await runFailSafeCleanup(
    [
      {
        name: 'restore foreign key checks',
        action: () => connection.query('SET FOREIGN_KEY_CHECKS = 1'),
      },
    ],
    { primaryError: resetError },
  );
}

async function assertCoreSchemaRejected(connection) {
  await assert.rejects(
    validateCoreSchema(connection, testDatabaseName, false),
    (error) => error.code === 'CORE_SCHEMA_VALIDATION_FAILED' && error.isSafeToDisplay === true,
  );
}

async function countAppliedMigrations(connection) {
  const [[row]] = await connection.query('SELECT COUNT(*) AS migrationCount FROM schema_migrations');
  return Number(row.migrationCount);
}

async function readAppliedMigrationIds(connection) {
  const [rows] = await connection.query('SELECT id FROM schema_migrations ORDER BY id');
  return rows.map((row) => row.id);
}

function runMigrationProcess() {
  const childEnvironment = {
    ...process.env,
    PORT: process.env.PORT ?? '3000',
    CLIENT_URL: process.env.CLIENT_URL ?? 'http://localhost:5173',
    DB_HOST: validatedIntegrationTarget.host,
    DB_PORT: String(validatedIntegrationTarget.port),
    DB_USER: validatedIntegrationTarget.user,
    DB_PASSWORD: validatedIntegrationTarget.password,
    DB_NAME: testDatabaseName,
  };

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, ['src/db/migrate.js'], {
      cwd: serverRoot,
      env: childEnvironment,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectProcess);
    child.once('close', (code, signal) => {
      resolveProcess({ code, signal, stdout, stderr });
    });
  });
}

test(
  'migration integration scenarios on an explicitly authorized disposable database',
  { skip: integrationSkipReason, timeout: 120_000 },
  async (context) => {
    if (integrationConfigurationError) {
      throw integrationConfigurationError;
    }

    let connection = null;
    let databaseOwnershipVerified = false;
    let primaryError = null;
    let ensureMigrationTable;
    let closeDatabasePool;

    try {
      connection = await mysql.createConnection({
        host: validatedIntegrationTarget.host,
        port: validatedIntegrationTarget.port,
        user: validatedIntegrationTarget.user,
        password: validatedIntegrationTarget.password,
        database: testDatabaseName,
        charset: 'utf8mb4',
      });
      await authorizeIntegrationDatabase(connection, integrationConfiguration);
      databaseOwnershipVerified = true;

      process.env.PORT ??= '3000';
      process.env.CLIENT_URL ??= 'http://localhost:5173';
      process.env.DB_HOST = validatedIntegrationTarget.host;
      process.env.DB_PORT = String(validatedIntegrationTarget.port);
      process.env.DB_USER = validatedIntegrationTarget.user;
      process.env.DB_PASSWORD = validatedIntegrationTarget.password;
      process.env.DB_NAME = testDatabaseName;

      ({ ensureMigrationTable } = await import('../src/db/migrate.js'));
      ({ closeDatabasePool } = await import('../src/config/db.js'));

    await context.test('accepts the exact core schema and migration tracker', async () => {
      await resetTestSchema(connection);
      await ensureMigrationTable(connection, testDatabaseName);
      await up(connection, { databaseName: testDatabaseName });
      await validateCoreSchema(connection, testDatabaseName, false);
    });

    await context.test('rejects a same-name check with the wrong clause', async () => {
      await resetTestSchema(connection);
      await up(connection, { databaseName: testDatabaseName });
      await connection.query(
        'ALTER TABLE categories DROP CONSTRAINT chk_categories_is_visible',
      );
      await connection.query(
        'ALTER TABLE categories ADD CONSTRAINT chk_categories_is_visible CHECK (1 = 1)',
      );
      await assertCoreSchemaRejected(connection);
    });

    await context.test('rejects missing and additional check constraints', async (checkContext) => {
      await checkContext.test('missing check', async () => {
        await resetTestSchema(connection);
        await up(connection, { databaseName: testDatabaseName });
        await connection.query(
          'ALTER TABLE categories DROP CONSTRAINT chk_categories_is_visible',
        );
        await assertCoreSchemaRejected(connection);
      });

      await checkContext.test('additional check', async () => {
        await resetTestSchema(connection);
        await up(connection, { databaseName: testDatabaseName });
        await connection.query(
          'ALTER TABLE categories ADD CONSTRAINT chk_categories_extra CHECK (display_order < 1000)',
        );
        await assertCoreSchemaRejected(connection);
      });
    });

    await context.test('rejects incompatible timestamp definitions', async (timestampContext) => {
      await timestampContext.test('missing DATETIME(3) precision', async () => {
        await resetTestSchema(connection);
        await up(connection, { databaseName: testDatabaseName });
        await connection.query(
          'ALTER TABLE admins MODIFY created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
        );
        await assertCoreSchemaRejected(connection);
      });

      await timestampContext.test('missing default', async () => {
        await resetTestSchema(connection);
        await up(connection, { databaseName: testDatabaseName });
        await connection.query('ALTER TABLE admins MODIFY created_at DATETIME(3) NOT NULL');
        await assertCoreSchemaRejected(connection);
      });

      await timestampContext.test('missing ON UPDATE expression', async () => {
        await resetTestSchema(connection);
        await up(connection, { databaseName: testDatabaseName });
        await connection.query(
          'ALTER TABLE admins MODIFY updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
        );
        await assertCoreSchemaRejected(connection);
      });
    });

    await context.test('rejects incompatible migration tracker definitions', async (trackerContext) => {
      await trackerContext.test('VARCHAR(32) migration id', async () => {
        await resetTestSchema(connection);
        await connection.query(`
          CREATE TABLE schema_migrations (
            id VARCHAR(32) NOT NULL PRIMARY KEY,
            executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await assert.rejects(
          ensureMigrationTable(connection, testDatabaseName),
          (error) => error.code === 'INCOMPATIBLE_MIGRATION_TABLE',
        );
      });

      await trackerContext.test('wrong executed_at precision and default', async () => {
        await resetTestSchema(connection);
        await connection.query(`
          CREATE TABLE schema_migrations (
            id VARCHAR(191) NOT NULL PRIMARY KEY,
            executed_at DATETIME NOT NULL DEFAULT '2000-01-01 00:00:00'
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await assert.rejects(
          ensureMigrationTable(connection, testDatabaseName),
          (error) => error.code === 'INCOMPATIBLE_MIGRATION_TABLE',
        );
      });

      await trackerContext.test('additional required column', async () => {
        await resetTestSchema(connection);
        await connection.query(`
          CREATE TABLE schema_migrations (
            id VARCHAR(191) NOT NULL PRIMARY KEY,
            executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            required_value INT NOT NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await assert.rejects(
          ensureMigrationTable(connection, testDatabaseName),
          (error) => error.code === 'INCOMPATIBLE_MIGRATION_TABLE',
        );
      });
    });

    await context.test('recovers from an interrupted partial core migration', async () => {
      await resetTestSchema(connection);
      await ensureMigrationTable(connection, testDatabaseName);
      let createTableCount = 0;
      const interruptedConnection = {
        execute: connection.execute.bind(connection),
        async query(statement, parameters) {
          if (/^\s*CREATE TABLE/i.test(statement)) {
            createTableCount += 1;

            if (createTableCount === 2) {
              const error = new Error('Injected integration-test interruption.');
              error.code = 'INJECTED_MIGRATION_FAILURE';
              throw error;
            }
          }

          return connection.query(statement, parameters);
        },
      };

      await assert.rejects(
        up(interruptedConnection, { databaseName: testDatabaseName }),
        (error) => error.code === 'INJECTED_MIGRATION_FAILURE',
      );
      assert.equal(await countAppliedMigrations(connection), 0);

      const [partialTables] = await connection.execute(
        `SELECT TABLE_NAME AS tableName
           FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?, ?)`,
        [testDatabaseName, ...coreTableNames],
      );
      assert.deepEqual(partialTables.map((table) => table.tableName), ['admins']);

      await up(connection, { databaseName: testDatabaseName });
      await connection.execute('INSERT INTO schema_migrations (id) VALUES (?)', [
        '001_create_core_tables',
      ]);
      assert.equal(await countAppliedMigrations(connection), 1);
    });

    await context.test('does not record a failed incompatible migration', async () => {
      await resetTestSchema(connection);
      await up(connection, { databaseName: testDatabaseName });
      await connection.query(
        'ALTER TABLE categories DROP CONSTRAINT chk_categories_is_visible',
      );
      await connection.query(
        'ALTER TABLE categories ADD CONSTRAINT chk_categories_is_visible CHECK (1 = 1)',
      );

      const result = await runMigrationProcess();
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.equal(await countAppliedMigrations(connection), 0);
      assert.equal(result.stderr.includes(testDatabaseName), false);
      if (process.env.TEST_DB_PASSWORD) {
        assert.equal(result.stderr.includes(process.env.TEST_DB_PASSWORD), false);
      }
    });

    await context.test('enforces target collation across a drifted category-name column', async () => {
      await resetTestSchema(connection);
      await up(connection, { databaseName: testDatabaseName });
      await connection.query(
        `ALTER TABLE categories
           MODIFY COLUMN name VARCHAR(100)
           CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`,
      );
      await connection.execute(
        'INSERT INTO categories (name) VALUES (?), (?)',
        ['Cafe', 'CAFÉ'],
      );

      await assert.rejects(
        enforceUniqueCategoryNames(connection, { databaseName: testDatabaseName }),
        (error) => error.code === 'DUPLICATE_CATEGORY_NAMES_EXIST',
      );

      const [[columnAfterRejection]] = await connection.execute(
        `SELECT CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME = 'categories'
            AND COLUMN_NAME = 'name'`,
        [testDatabaseName],
      );
      const [indexesAfterRejection] = await connection.execute(
        `SELECT INDEX_NAME AS indexName, SUB_PART AS subPart
           FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME = 'categories'
            AND INDEX_NAME = 'uq_categories_name'`,
        [testDatabaseName],
      );

      assert.equal(columnAfterRejection.characterSet, 'utf8mb4');
      assert.equal(columnAfterRejection.collation, 'utf8mb4_bin');
      assert.equal(indexesAfterRejection.length, 0);

      await connection.execute('DELETE FROM categories WHERE name = ?', ['CAFÉ']);
      await enforceUniqueCategoryNames(connection, { databaseName: testDatabaseName });
      await validateCategoryManagementSchema(connection, testDatabaseName, false);

      await assert.rejects(
        connection.execute('INSERT INTO categories (name) VALUES (?)', ['CAFÉ']),
        (error) => error.code === 'ER_DUP_ENTRY',
      );
    });

    await context.test('replaces a same-name prefix index with a full-column unique index', async () => {
      await resetTestSchema(connection);
      await up(connection, { databaseName: testDatabaseName });
      await connection.query(
        `ALTER TABLE categories
           ADD UNIQUE KEY uq_categories_name (name(10))`,
      );

      await enforceUniqueCategoryNames(connection, { databaseName: testDatabaseName });

      const [indexRows] = await connection.execute(
        `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
                SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
                SUB_PART AS subPart
           FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME = 'categories'
            AND INDEX_NAME = 'uq_categories_name'
          ORDER BY SEQ_IN_INDEX`,
        [testDatabaseName],
      );

      assert.equal(indexRows.length, 1);
      assert.equal(indexRows[0].indexName, 'uq_categories_name');
      assert.equal(Number(indexRows[0].nonUnique), 0);
      assert.equal(Number(indexRows[0].sequenceNumber), 1);
      assert.equal(indexRows[0].columnName, 'name');
      assert.equal(indexRows[0].subPart, null);

      const firstName = '1234567890-alpha';
      const secondName = '1234567890-beta';
      await connection.execute('INSERT INTO categories (name) VALUES (?), (?)', [
        firstName,
        secondName,
      ]);
      await assert.rejects(
        connection.execute('INSERT INTO categories (name) VALUES (?)', [firstName]),
        (error) => error.code === 'ER_DUP_ENTRY',
      );

      await enforceUniqueCategoryNames(connection, { databaseName: testDatabaseName });
      await validateCategoryManagementSchema(connection, testDatabaseName, false);
    });

    await context.test('remains idempotent on a second execution', async () => {
      await resetTestSchema(connection);
      const firstRun = await runMigrationProcess();
      const secondRun = await runMigrationProcess();

      assert.equal(firstRun.code, 0);
      assert.equal(secondRun.code, 0);
      assert.deepEqual(await readAppliedMigrationIds(connection), [
        '001_create_core_tables',
        '002_create_admin_sessions',
        '003_enforce_unique_category_names',
      ]);
      await validateCoreSchema(connection, testDatabaseName, false);
      await validateAdminSessionsSchema(connection, testDatabaseName, false);
      await validateCategoryManagementSchema(connection, testDatabaseName, false);
    });

    await context.test('serializes two concurrent migration runners', async () => {
      await resetTestSchema(connection);
      const results = await Promise.all([runMigrationProcess(), runMigrationProcess()]);

      assert.deepEqual(
        results.map((result) => result.code),
        [0, 0],
      );
      assert.deepEqual(await readAppliedMigrationIds(connection), [
        '001_create_core_tables',
        '002_create_admin_sessions',
        '003_enforce_unique_category_names',
      ]);
      await validateCoreSchema(connection, testDatabaseName, false);
      await validateAdminSessionsSchema(connection, testDatabaseName, false);
      await validateCategoryManagementSchema(connection, testDatabaseName, false);
    });
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanupSteps = [];

      if (databaseOwnershipVerified) {
        cleanupSteps.push(
          {
            name: 'reset owned integration schema',
            action: () => resetTestSchema(connection),
          },
          {
            name: 'release integration database lock',
            action: () =>
              releaseIntegrationDatabaseLock(connection, validatedIntegrationTarget),
          },
        );
      }

      if (connection) {
        cleanupSteps.push({
          name: 'close integration database connection',
          action: () => connection.end(),
        });
      }

      if (closeDatabasePool) {
        cleanupSteps.push({
          name: 'close application database pool',
          action: () => closeDatabasePool(),
        });
      }

      await runFailSafeCleanup(cleanupSteps, { primaryError });
    }
  },
);
