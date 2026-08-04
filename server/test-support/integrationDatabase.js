export const integrationOwnershipTableName = 'riona_integration_test_ownership';

const ownershipTokenPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createSafetyError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.isSafeToDisplay = true;
  return error;
}

function requireSetting(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createSafetyError(
      `Missing required integration database setting: ${name}.`,
      'INTEGRATION_DATABASE_SETTING_MISSING',
    );
  }

  return value.trim();
}

function parsePort(value, name) {
  const normalizedValue = requireSetting(value, name);

  if (!/^\d+$/.test(normalizedValue)) {
    throw createSafetyError(
      `Invalid integration database setting: ${name}.`,
      'INTEGRATION_DATABASE_SETTING_INVALID',
    );
  }

  const port = Number(normalizedValue);

  if (port < 1 || port > 65535) {
    throw createSafetyError(
      `Invalid integration database setting: ${name}.`,
      'INTEGRATION_DATABASE_SETTING_INVALID',
    );
  }

  return port;
}

function normalizeHost(host) {
  const normalizedHost = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');

  if (['localhost', '127.0.0.1', '::1'].includes(normalizedHost)) {
    return 'loopback';
  }

  return normalizedHost;
}

export function validateIntegrationDatabaseConfiguration({ enabled, target, production }) {
  if (enabled !== '1') {
    throw createSafetyError(
      'Set RUN_DB_INTEGRATION_TESTS=1 to enable destructive integration tests.',
      'INTEGRATION_DATABASE_TESTS_DISABLED',
    );
  }

  const ownershipToken = requireSetting(
    target?.ownershipToken,
    'TEST_DB_OWNERSHIP_TOKEN',
  ).toLowerCase();

  if (!ownershipTokenPattern.test(ownershipToken)) {
    throw createSafetyError(
      'TEST_DB_OWNERSHIP_TOKEN must be a newly generated UUID.',
      'INTEGRATION_DATABASE_OWNERSHIP_TOKEN_INVALID',
    );
  }

  const targetDatabase = requireSetting(target?.database, 'TEST_DB_NAME');
  const expectedDatabaseName = `riona_integration_${ownershipToken.replaceAll('-', '_')}`;

  if (targetDatabase !== expectedDatabaseName) {
    throw createSafetyError(
      'TEST_DB_NAME must be the run-specific database derived from TEST_DB_OWNERSHIP_TOKEN.',
      'INTEGRATION_DATABASE_NAME_INVALID',
    );
  }

  const targetHost = requireSetting(target?.host, 'TEST_DB_HOST');
  const targetPort = parsePort(target?.port, 'TEST_DB_PORT');
  const targetUser = requireSetting(target?.user, 'TEST_DB_USER');
  const productionHost = requireSetting(production?.host, 'DB_HOST');
  const productionPort = parsePort(production?.port, 'DB_PORT');
  const productionDatabase = requireSetting(production?.database, 'DB_NAME');

  if (
    normalizeHost(targetHost) === normalizeHost(productionHost) &&
    targetPort === productionPort &&
    targetDatabase.toLowerCase() === productionDatabase.toLowerCase()
  ) {
    throw createSafetyError(
      'The integration database target must not match the application database.',
      'INTEGRATION_DATABASE_MATCHES_PRODUCTION',
    );
  }

  return Object.freeze({
    host: targetHost,
    port: targetPort,
    user: targetUser,
    password: target?.password ?? '',
    database: targetDatabase,
    ownershipToken,
    lockName: `riona_integration:${ownershipToken}`,
  });
}

async function acquireIntegrationLock(connection, authorization) {
  const [[result]] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', [
    authorization.lockName,
  ]);

  if (Number(result?.acquired) !== 1) {
    throw createSafetyError(
      'The integration database is already in use by another test run.',
      'INTEGRATION_DATABASE_LOCK_UNAVAILABLE',
    );
  }
}

export async function releaseIntegrationDatabaseLock(connection, authorization) {
  const [[result]] = await connection.execute('SELECT RELEASE_LOCK(?) AS released', [
    authorization.lockName,
  ]);

  if (Number(result?.released) !== 1) {
    throw createSafetyError(
      'The integration database lock could not be released cleanly.',
      'INTEGRATION_DATABASE_LOCK_RELEASE_FAILED',
    );
  }
}

async function verifyIntegrationDatabaseOwnership(connection, authorization) {
  let databaseRows;
  let ownershipRows;
  let tableRows;

  try {
    [databaseRows] = await connection.execute('SELECT DATABASE() AS databaseName');
    [ownershipRows] = await connection.execute(
      `SELECT ownership_token AS ownershipToken
         FROM ${integrationOwnershipTableName}
        WHERE singleton_id = 1`,
    );
    [tableRows] = await connection.execute(
      `SELECT TABLE_NAME AS tableName
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [authorization.database],
    );
  } catch {
    throw createSafetyError(
      'Integration database ownership could not be verified.',
      'INTEGRATION_DATABASE_OWNERSHIP_UNVERIFIED',
    );
  }

  const [databaseRow] = databaseRows;
  const isExpectedDatabase = databaseRow?.databaseName === authorization.database;
  const hasExpectedOwnership =
    ownershipRows.length === 1 &&
    ownershipRows[0]?.ownershipToken?.toLowerCase() === authorization.ownershipToken;
  const isPristineOwnedDatabase =
    tableRows.length === 1 && tableRows[0]?.tableName === integrationOwnershipTableName;

  if (!isExpectedDatabase || !hasExpectedOwnership || !isPristineOwnedDatabase) {
    throw createSafetyError(
      'Integration database ownership could not be verified.',
      'INTEGRATION_DATABASE_OWNERSHIP_UNVERIFIED',
    );
  }
}

export async function runFailSafeCleanup(steps, { primaryError = null } = {}) {
  const cleanupErrors = [];

  for (const { name, action } of steps) {
    try {
      await action();
    } catch (error) {
      const cleanupError = new Error(`Cleanup step failed: ${name}.`, { cause: error });
      cleanupError.code = 'INTEGRATION_DATABASE_CLEANUP_FAILED';
      cleanupErrors.push(cleanupError);
    }
  }

  if (cleanupErrors.length === 0) {
    if (primaryError) {
      throw primaryError;
    }

    return;
  }

  throw new AggregateError(
    primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'Integration database cleanup did not complete cleanly.',
    { cause: primaryError ?? cleanupErrors[0] },
  );
}

export async function authorizeIntegrationDatabase(connection, configuration) {
  const authorization = validateIntegrationDatabaseConfiguration(configuration);
  let lockAcquired = false;

  try {
    await acquireIntegrationLock(connection, authorization);
    lockAcquired = true;
    await verifyIntegrationDatabaseOwnership(connection, authorization);
    return authorization;
  } catch (error) {
    const cleanupSteps = lockAcquired
      ? [
          {
            name: 'release integration database lock',
            action: () => releaseIntegrationDatabaseLock(connection, authorization),
          },
        ]
      : [];

    await runFailSafeCleanup(cleanupSteps, { primaryError: error });
  }
}
