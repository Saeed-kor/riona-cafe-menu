import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureTestEnvironment,
  testEnvironment,
} from '../test-support/testEnvironment.js';

test('configuration-dependent tests replace invalid ambient values before production validation', async () => {
  Object.assign(process.env, {
    NODE_ENV: 'invalid',
    TRUST_PROXY: 'true',
    PORT: 'not-a-port',
    CLIENT_URL: 'not-a-url',
    DB_HOST: '',
    DB_PORT: 'not-a-port',
    DB_USER: '',
    DB_NAME: '',
  });

  configureTestEnvironment();

  assert.deepEqual(
    Object.fromEntries(Object.keys(testEnvironment).map((name) => [name, process.env[name]])),
    testEnvironment,
  );

  const { createApp } = await import('../src/app.js');
  assert.equal(typeof createApp, 'function');
});
