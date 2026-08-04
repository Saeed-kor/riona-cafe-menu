import assert from 'node:assert/strict';
import test from 'node:test';

import bcrypt from 'bcryptjs';

import {
  createAdminAuthService,
  expiredSessionCleanupBatchSize,
  hashSessionToken,
} from '../src/services/adminAuth.service.js';

const fixedNow = new Date('2026-08-04T10:00:00.000Z');
const fixedSessionToken = 'a'.repeat(64);

test('login verifies the stored password_hash and persists only a token hash', async () => {
  const passwordHash = await bcrypt.hash('correct horse battery staple', 4);
  const inserts = [];
  const cleanupStatements = [];
  const executor = {
    async execute(sql, parameters) {
      if (sql.includes('FROM admins')) {
        return [[{ id: 7, username: 'admin', passwordHash }], []];
      }

      if (sql.includes('DELETE FROM admin_sessions') && sql.includes('expires_at')) {
        cleanupStatements.push(sql);
        return [{ affectedRows: 2 }, []];
      }

      if (sql.includes('INSERT INTO admin_sessions')) {
        inserts.push(parameters);
        return [{ insertId: 1 }, []];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = createAdminAuthService({
    executor,
    tokenFactory: () => fixedSessionToken,
    now: () => fixedNow,
  });

  const result = await service.login(' admin ', 'correct horse battery staple');

  assert.deepEqual(result.admin, { id: '7', username: 'admin' });
  assert.equal(result.sessionToken, fixedSessionToken);
  assert.equal(cleanupStatements.length, 1);
  assert.match(cleanupStatements[0], /ORDER BY expires_at/);
  assert.match(
    cleanupStatements[0],
    new RegExp(`LIMIT ${expiredSessionCleanupBatchSize}$`),
  );
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], 7);
  assert.equal(inserts[0][1], hashSessionToken(fixedSessionToken));
  assert.notEqual(inserts[0][1], fixedSessionToken);
  assert.equal(inserts[0][2].toISOString(), '2026-08-04T18:00:00.000Z');
  assert.equal(JSON.stringify(result.admin).includes('password'), false);
  assert.equal(JSON.stringify(result.admin).includes('hash'), false);
});

test('wrong password and unknown username return the same generic authentication error', async (context) => {
  const passwordHash = await bcrypt.hash('correct horse battery staple', 4);
  let insertCount = 0;
  const executor = {
    async execute(sql, parameters) {
      if (sql.includes('FROM admins')) {
        return [
          parameters[0] === 'admin' ? [{ id: 7, username: 'admin', passwordHash }] : [],
          [],
        ];
      }

      if (sql.includes('INSERT INTO admin_sessions')) {
        insertCount += 1;
        return [{ insertId: 1 }, []];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = createAdminAuthService({ executor });

  for (const [name, username, password] of [
    ['wrong password', 'admin', 'wrong password'],
    ['unknown username', 'missing-admin', 'wrong password'],
  ]) {
    await context.test(name, async () => {
      await assert.rejects(
        service.login(username, password),
        (error) =>
          error.code === 'INVALID_ADMIN_CREDENTIALS' &&
          error.status === 401 &&
          error.message === 'Invalid username or password',
      );
    });
  }

  assert.equal(insertCount, 0);
});

test('login rejects passwords beyond bcrypt byte 72 instead of accepting a matching prefix', async () => {
  const storedPassword = 'a'.repeat(72);
  const passwordHash = await bcrypt.hash(storedPassword, 4);
  let insertCount = 0;
  const executor = {
    async execute(sql) {
      if (sql.includes('FROM admins')) {
        return [[{ id: 7, username: 'admin', passwordHash }], []];
      }

      if (sql.includes('INSERT INTO admin_sessions')) {
        insertCount += 1;
        return [{ insertId: 1 }, []];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = createAdminAuthService({ executor });

  await assert.rejects(
    service.login('admin', `${storedPassword}b`),
    (error) => error.code === 'INVALID_ADMIN_CREDENTIALS' && error.status === 401,
  );
  assert.equal(insertCount, 0);
});

test('current-admin and logout address sessions by token hash', async () => {
  const calls = [];
  const executor = {
    async execute(sql, parameters) {
      calls.push({ sql, parameters });

      if (sql.includes('INNER JOIN admins')) {
        return [[{ id: 7, username: 'admin' }], []];
      }

      if (sql.startsWith('DELETE FROM admin_sessions')) {
        return [{ affectedRows: 1 }, []];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = createAdminAuthService({ executor });

  assert.deepEqual(await service.getCurrentAdmin(fixedSessionToken), {
    id: '7',
    username: 'admin',
  });
  await service.logout(fixedSessionToken);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].parameters, [hashSessionToken(fixedSessionToken)]);
  assert.deepEqual(calls[1].parameters, [hashSessionToken(fixedSessionToken)]);
  assert.equal(await service.getCurrentAdmin('not-a-valid-token'), null);
  await service.logout('not-a-valid-token');
  assert.equal(calls.length, 2);
});

test('successful login prunes only an expiration-indexed batch and keeps active sessions', async () => {
  const now = new Date('2026-08-04T10:00:00.000Z');
  const activeToken = 'd'.repeat(64);
  const expiredToken = 'e'.repeat(64);
  const sessions = [
    ...Array.from({ length: expiredSessionCleanupBatchSize + 1 }, (_, index) => ({
      tokenHash: `${index}`.padStart(64, '0'),
      expiresAt: new Date(now.getTime() - expiredSessionCleanupBatchSize + index),
      adminId: 7,
    })),
    {
      tokenHash: hashSessionToken(activeToken),
      expiresAt: new Date(now.getTime() + 60_000),
      adminId: 7,
    },
    {
      tokenHash: hashSessionToken(expiredToken),
      expiresAt: new Date(now.getTime() - 60_000),
      adminId: 7,
    },
  ];
  let cleanupStatement = '';
  const executor = {
    async execute(sql, parameters = []) {
      if (sql.includes('FROM admins') && !sql.includes('INNER JOIN')) {
        return [[{ id: 7, username: 'admin', passwordHash: 'test-hash' }], []];
      }

      if (sql.includes('INNER JOIN admins')) {
        const session = sessions.find(
          (candidate) =>
            candidate.tokenHash === parameters[0] && candidate.expiresAt > now,
        );
        return [session ? [{ id: 7, username: 'admin' }] : [], []];
      }

      if (sql.includes('DELETE FROM admin_sessions') && sql.includes('expires_at')) {
        cleanupStatement = sql;
        const expiredSessions = sessions
          .filter((session) => session.expiresAt <= now)
          .sort((first, second) => first.expiresAt - second.expiresAt)
          .slice(0, expiredSessionCleanupBatchSize);

        for (const expiredSession of expiredSessions) {
          sessions.splice(sessions.indexOf(expiredSession), 1);
        }

        return [{ affectedRows: expiredSessions.length }, []];
      }

      if (sql.includes('INSERT INTO admin_sessions')) {
        sessions.push({
          adminId: parameters[0],
          tokenHash: parameters[1],
          expiresAt: parameters[2],
        });
        return [{ insertId: 1 }, []];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  const service = createAdminAuthService({
    executor,
    passwordVerifier: async () => true,
    tokenFactory: () => fixedSessionToken,
    now: () => now,
  });

  assert.equal(await service.getCurrentAdmin(expiredToken), null);
  assert.deepEqual(await service.getCurrentAdmin(activeToken), {
    id: '7',
    username: 'admin',
  });

  await service.login('admin', 'valid-password');

  assert.match(cleanupStatement, /WHERE expires_at <= CURRENT_TIMESTAMP\(3\)/);
  assert.match(cleanupStatement, /ORDER BY expires_at/);
  assert.match(cleanupStatement, new RegExp(`LIMIT ${expiredSessionCleanupBatchSize}$`));
  assert.equal(
    sessions.some((session) => session.tokenHash === hashSessionToken(activeToken)),
    true,
  );
  assert.equal(
    sessions.some((session) => session.tokenHash === hashSessionToken(expiredToken)),
    false,
  );
  assert.equal(
    sessions.filter((session) => session.expiresAt <= now).length,
    2,
  );
  assert.equal(
    sessions.some((session) => session.tokenHash === hashSessionToken(fixedSessionToken)),
    true,
  );
});
