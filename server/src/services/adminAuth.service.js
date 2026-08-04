import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';

export const adminSessionTtlMilliseconds = 8 * 60 * 60 * 1000;
export const expiredSessionCleanupBatchSize = 100;

const dummyPasswordHash = '$2b$12$pkS5.KUlCi6AcLMieA9ltuX1HoMezAsWRakkI2/cnOeAiHnMiFU02';
const bcryptMaximumPasswordBytes = 72;
const sessionTokenPattern = /^[a-f0-9]{64}$/;
let databaseModulePromise = null;

async function getDefaultExecutor() {
  databaseModulePromise ??= import('../config/db.js').catch((error) => {
    databaseModulePromise = null;
    throw error;
  });

  const { pool } = await databaseModulePromise;
  return pool;
}

function createAuthenticationError() {
  const error = new Error('Invalid username or password');
  error.code = 'INVALID_ADMIN_CREDENTIALS';
  error.status = 401;
  return error;
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function isValidSessionToken(token) {
  return typeof token === 'string' && sessionTokenPattern.test(token);
}

function toPublicAdmin(row) {
  return {
    id: String(row.id),
    username: row.username,
  };
}

export function createAdminAuthService({
  executor,
  passwordVerifier = bcrypt.compare,
  tokenFactory = () => randomBytes(32).toString('hex'),
  now = () => new Date(),
} = {}) {
  return Object.freeze({
    async login(username, password) {
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      const normalizedUsername = typeof username === 'string' ? username.trim() : '';
      const [rows] = await databaseExecutor.execute(
        `SELECT id, username, password_hash AS passwordHash
           FROM admins
          WHERE username = ?
          LIMIT 1`,
        [normalizedUsername],
      );
      const admin = rows[0];
      const hasSupportedPasswordLength =
        Buffer.byteLength(password, 'utf8') <= bcryptMaximumPasswordBytes;
      const passwordHash =
        admin && hasSupportedPasswordLength ? admin.passwordHash : dummyPasswordHash;
      const isPasswordValid = await passwordVerifier(password, passwordHash);

      if (!admin || !hasSupportedPasswordLength || !isPasswordValid) {
        throw createAuthenticationError();
      }

      const sessionToken = tokenFactory();

      if (!isValidSessionToken(sessionToken)) {
        throw new Error('Session token generation failed.');
      }

      const expiresAt = new Date(now().getTime() + adminSessionTtlMilliseconds);
      await databaseExecutor.execute(
        `DELETE FROM admin_sessions
          WHERE expires_at <= CURRENT_TIMESTAMP(3)
          ORDER BY expires_at
          LIMIT ${expiredSessionCleanupBatchSize}`,
      );
      await databaseExecutor.execute(
        `INSERT INTO admin_sessions (admin_id, token_hash, expires_at)
         VALUES (?, ?, ?)`,
        [admin.id, hashSessionToken(sessionToken), expiresAt],
      );

      return {
        admin: toPublicAdmin(admin),
        sessionToken,
      };
    },

    async getCurrentAdmin(sessionToken) {
      if (!isValidSessionToken(sessionToken)) {
        return null;
      }

      const databaseExecutor = executor ?? (await getDefaultExecutor());
      const [rows] = await databaseExecutor.execute(
        `SELECT admins.id, admins.username
           FROM admin_sessions
           INNER JOIN admins ON admins.id = admin_sessions.admin_id
          WHERE admin_sessions.token_hash = ?
            AND admin_sessions.expires_at > CURRENT_TIMESTAMP(3)
          LIMIT 1`,
        [hashSessionToken(sessionToken)],
      );

      return rows[0] ? toPublicAdmin(rows[0]) : null;
    },

    async logout(sessionToken) {
      if (!isValidSessionToken(sessionToken)) {
        return;
      }

      const databaseExecutor = executor ?? (await getDefaultExecutor());
      await databaseExecutor.execute('DELETE FROM admin_sessions WHERE token_hash = ?', [
        hashSessionToken(sessionToken),
      ]);
    },
  });
}

export const adminAuthService = createAdminAuthService();
