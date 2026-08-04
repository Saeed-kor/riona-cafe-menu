import { createServer } from 'node:http';

import { app } from './app.js';
import { closeDatabasePool } from './config/db.js';
import { env } from './config/env.js';

const httpServer = createServer(app);
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}. Shutting down gracefully.`);

  const shutdownTimeout = setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 10_000);

  shutdownTimeout.unref();

  httpServer.close(async (httpError) => {
    let exitCode = httpError ? 1 : 0;

    try {
      await closeDatabasePool();
    } catch {
      console.error('Database pool could not be closed cleanly.');
      exitCode = 1;
    }

    clearTimeout(shutdownTimeout);
    process.exit(exitCode);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

httpServer.on('error', async (error) => {
  console.error('HTTP server failed to start.', {
    code: error?.code ?? 'UNKNOWN_SERVER_ERROR',
  });

  try {
    await closeDatabasePool();
  } catch {
    console.error('Database pool could not be closed cleanly.');
  }

  process.exit(1);
});

httpServer.listen(env.PORT, () => {
  console.log(`Riona API is listening on port ${env.PORT}.`);
});
