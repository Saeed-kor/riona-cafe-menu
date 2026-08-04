import bcrypt from 'bcryptjs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const bcryptCost = 12;
export const bcryptMaximumPasswordBytes = 72;
const usernamePattern = /^[A-Za-z0-9._-]{3,50}$/;
let databaseModulePromise = null;

function getDatabaseModule() {
  databaseModulePromise ??= import('../config/db.js').catch((error) => {
    databaseModulePromise = null;
    throw error;
  });

  return databaseModulePromise;
}

function createInputError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.isSafeToDisplay = true;
  return error;
}

export function validateUsername(username) {
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';

  if (!usernamePattern.test(normalizedUsername)) {
    throw createInputError(
      'Username must be 3 to 50 characters and use only Latin letters, numbers, dots, hyphens, or underscores.',
      'INVALID_ADMIN_USERNAME',
    );
  }

  return normalizedUsername;
}

export function validatePassword(password, confirmation) {
  if (typeof password !== 'string' || [...password].length < 12) {
    throw createInputError(
      'Password must contain at least 12 characters.',
      'INVALID_ADMIN_PASSWORD',
    );
  }

  if (Buffer.byteLength(password, 'utf8') > bcryptMaximumPasswordBytes) {
    throw createInputError(
      'Password must be at most 72 bytes when encoded as UTF-8.',
      'ADMIN_PASSWORD_TOO_LONG',
    );
  }

  if (password !== confirmation) {
    throw createInputError('Password confirmation does not match.', 'ADMIN_PASSWORD_MISMATCH');
  }
}

export async function createAdminRecord({ username, password, confirmation, executor }) {
  const normalizedUsername = validateUsername(username);
  validatePassword(password, confirmation);
  const passwordHash = await bcrypt.hash(password, bcryptCost);
  const databaseExecutor = executor ?? (await getDatabaseModule()).pool;

  try {
    const [result] = await databaseExecutor.execute(
      'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
      [normalizedUsername, passwordHash],
    );

    return { id: result.insertId, username: normalizedUsername };
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      throw createInputError(
        'An administrator with this username already exists.',
        'ADMIN_USERNAME_EXISTS',
      );
    }

    throw error;
  }
}

function parseUsernameArgument(argumentsList) {
  if (argumentsList.length === 0) {
    return null;
  }

  if (argumentsList.length === 2 && argumentsList[0] === '--username') {
    return argumentsList[1];
  }

  if (argumentsList.length === 1 && argumentsList[0].startsWith('--username=')) {
    return argumentsList[0].slice('--username='.length);
  }

  throw createInputError(
    'Usage: npm run admin:create -- --username <username>',
    'INVALID_ADMIN_ARGUMENTS',
  );
}

async function readVisibleInput(prompt) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

async function readHiddenInput(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw createInputError(
      'Interactive password input requires a terminal.',
      'ADMIN_TERMINAL_REQUIRED',
    );
  }

  let muted = false;
  const mutedOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk, encoding);
      }

      callback();
    },
  });
  mutedOutput.isTTY = true;
  mutedOutput.columns = process.stdout.columns;

  const readline = createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });

  try {
    const answerPromise = readline.question(prompt);
    muted = true;
    const answer = await answerPromise;
    muted = false;
    process.stdout.write('\n');
    return answer;
  } finally {
    muted = false;
    readline.close();
  }
}

async function main() {
  try {
    const usernameArgument = parseUsernameArgument(process.argv.slice(2));
    const username = usernameArgument ?? (await readVisibleInput('Username: '));
    const password = await readHiddenInput('Password: ');
    const confirmation = await readHiddenInput('Confirm password: ');

    await createAdminRecord({ username, password, confirmation });
    console.log('Administrator created successfully.');
  } catch (error) {
    if (error?.isSafeToDisplay) {
      console.error(error.message);
    } else {
      console.error(`Administrator could not be created (${error?.code ?? 'ADMIN_CREATE_FAILED'}).`);
    }

    process.exitCode = 1;
  } finally {
    if (databaseModulePromise) {
      try {
        const { closeDatabasePool } = await databaseModulePromise;
        await closeDatabasePool();
      } catch {
        console.error('The database pool could not be closed cleanly.');
        process.exitCode = 1;
      }
    }
  }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  await main();
}
