import dotenv from 'dotenv';
import { isIP } from 'node:net';
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

function parseNodeEnvironment(value) {
  const normalizedValue = value?.trim() || 'development';

  if (!['development', 'test', 'production'].includes(normalizedValue)) {
    throw new Error(
      'Invalid environment variable: NODE_ENV must be development, test, or production.',
    );
  }

  return normalizedValue;
}

function isValidProxyAddress(value) {
  const separatorIndex = value.lastIndexOf('/');

  if (separatorIndex === -1) {
    return isIP(value) !== 0;
  }

  const address = value.slice(0, separatorIndex);
  const prefix = value.slice(separatorIndex + 1);
  const addressVersion = isIP(address);

  if (addressVersion === 0 || !/^\d+$/.test(prefix)) {
    return false;
  }

  const maximumPrefix = addressVersion === 4 ? 32 : 128;
  return Number(prefix) <= maximumPrefix;
}

export function parseTrustProxy(value) {
  const normalizedValue = value?.trim() || 'false';

  if (normalizedValue.toLowerCase() === 'false') {
    return false;
  }

  if (normalizedValue.toLowerCase() === 'true') {
    throw new Error(
      'Invalid environment variable: TRUST_PROXY must not grant trust to every proxy.',
    );
  }

  if (/^\d+$/.test(normalizedValue)) {
    const hopCount = Number(normalizedValue);

    if (!Number.isSafeInteger(hopCount) || hopCount > 255) {
      throw new Error(
        'Invalid environment variable: TRUST_PROXY hop count must be between 0 and 255.',
      );
    }

    return hopCount;
  }

  const trustedAddresses = normalizedValue.split(',').map((entry) => entry.trim());

  if (
    trustedAddresses.some((entry) => entry === '' || !isValidProxyAddress(entry))
  ) {
    throw new Error(
      'Invalid environment variable: TRUST_PROXY must contain only proxy IP or CIDR values.',
    );
  }

  return Object.freeze(trustedAddresses);
}

export const env = Object.freeze({
  NODE_ENV: parseNodeEnvironment(process.env.NODE_ENV),
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  PORT: parsePort('PORT', requireNonEmpty('PORT')),
  CLIENT_URL: parseClientUrl(requireNonEmpty('CLIENT_URL')),
  DB_HOST: requireNonEmpty('DB_HOST'),
  DB_PORT: parsePort('DB_PORT', requireNonEmpty('DB_PORT')),
  DB_USER: requireNonEmpty('DB_USER'),
  DB_PASSWORD: process.env.DB_PASSWORD ?? '',
  DB_NAME: requireNonEmpty('DB_NAME'),
});
