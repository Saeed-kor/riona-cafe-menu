import { Router } from 'express';

import { checkDatabaseConnection } from '../config/db.js';

const router = Router();

router.get('/', async (_request, response) => {
  try {
    await checkDatabaseConnection();

    response.status(200).json({
      success: true,
      message: 'Riona API and database are running',
    });
  } catch (error) {
    console.error('Database health check failed.', {
      code: error?.code ?? 'UNKNOWN_DATABASE_ERROR',
    });

    response.status(503).json({
      success: false,
      message: 'Riona API is temporarily unavailable',
    });
  }
});

export default router;
