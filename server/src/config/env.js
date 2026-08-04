import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const envFilePath = fileURLToPath(new URL('../../.env', import.meta.url));

dotenv.config({ path: envFilePath, quiet: true });

function requireNonEmpty(name) {
  const value = process.env[name];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function parsePort(name, value) {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid environment variable: ${name} must be an integer between 1 and 65535.`,
    );
  }

  const port = Number(value);

  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid environment variable: ${name} must be an integer between 1 and 65535.`,
    );
  }

  return port;
}

function parseClientUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'Invalid environment variable: CLIENT_URL must be a valid HTTP or HTTPS origin.',
    );
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(
      'Invalid environment variable: CLIENT_URL must be a valid HTTP or HTTPS origin.',
    );
  }

  return url.origin;
}

export const env = Object.freeze({
  PORT: parsePort('PORT', requireNonEmpty('PORT')),
  CLIENT_URL: parseClientUrl(requireNonEmpty('CLIENT_URL')),
  DB_HOST: requireNonEmpty('DB_HOST'),
  DB_PORT: parsePort('DB_PORT', requireNonEmpty('DB_PORT')),
  DB_USER: requireNonEmpty('DB_USER'),
  DB_PASSWORD: process.env.DB_PASSWORD ?? '',
  DB_NAME: requireNonEmpty('DB_NAME'),
});
