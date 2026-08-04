import assert from 'node:assert/strict';
import test from 'node:test';

import bcrypt from 'bcryptjs';

import {
  bcryptCost,
  bcryptMaximumPasswordBytes,
  createAdminRecord,
  validatePassword,
} from '../src/scripts/createAdmin.js';

function assertPasswordRejected(password, code) {
  assert.throws(
    () => validatePassword(password, password),
    (error) =>
      error.code === code &&
      error.isSafeToDisplay === true &&
      !error.message.includes(password),
  );
}

test('accepts ASCII and Unicode passwords at exactly 72 UTF-8 bytes', () => {
  const asciiPassword = 'a'.repeat(bcryptMaximumPasswordBytes);
  const unicodePassword = '\u00e9'.repeat(bcryptMaximumPasswordBytes / 2);

  assert.equal(Buffer.byteLength(asciiPassword, 'utf8'), 72);
  assert.equal(Buffer.byteLength(unicodePassword, 'utf8'), 72);
  assert.doesNotThrow(() => validatePassword(asciiPassword, asciiPassword));
  assert.doesNotThrow(() => validatePassword(unicodePassword, unicodePassword));
});

test('rejects ASCII and Unicode passwords over 72 UTF-8 bytes', () => {
  const asciiPassword = 'a'.repeat(bcryptMaximumPasswordBytes + 1);
  const unicodePassword = `${'\u00e9'.repeat(bcryptMaximumPasswordBytes / 2)}a`;

  assert.equal(Buffer.byteLength(asciiPassword, 'utf8'), 73);
  assert.equal(Buffer.byteLength(unicodePassword, 'utf8'), 73);
  assertPasswordRejected(asciiPassword, 'ADMIN_PASSWORD_TOO_LONG');
  assertPasswordRejected(unicodePassword, 'ADMIN_PASSWORD_TOO_LONG');
});

test('keeps the existing 12-character minimum and exact confirmation', () => {
  assertPasswordRejected('a'.repeat(11), 'INVALID_ADMIN_PASSWORD');

  assert.throws(
    () => validatePassword('a'.repeat(12), `${'a'.repeat(11)}b`),
    (error) => error.code === 'ADMIN_PASSWORD_MISMATCH',
  );
});

test('does not trim or normalize the password and keeps bcrypt cost 12', async () => {
  const password = '  preserved exactly  ';
  let passwordHash;
  const executor = {
    async execute(_statement, parameters) {
      passwordHash = parameters[1];
      return [{ insertId: 1 }];
    },
  };

  await createAdminRecord({
    username: 'review_admin',
    password,
    confirmation: password,
    executor,
  });

  assert.equal(bcrypt.getRounds(passwordHash), bcryptCost);
  assert.equal(bcryptCost, 12);
  assert.equal(await bcrypt.compare(password, passwordHash), true);
  assert.equal(await bcrypt.compare(password.trim(), passwordHash), false);
});

test('blocks passwords that differ only after byte 72 before the insert path', async () => {
  const prefix = 'a'.repeat(bcryptMaximumPasswordBytes);
  const passwords = [`${prefix}x`, `${prefix}y`];
  let insertAttempts = 0;
  const executor = {
    async execute() {
      insertAttempts += 1;
      return [{ insertId: 1 }];
    },
  };

  for (const password of passwords) {
    await assert.rejects(
      createAdminRecord({
        username: 'review_admin',
        password,
        confirmation: password,
        executor,
      }),
      (error) => error.code === 'ADMIN_PASSWORD_TOO_LONG',
    );
  }

  assert.equal(insertAttempts, 0);
});
