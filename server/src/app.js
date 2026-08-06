import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createAdminCategoriesRouter } from './routes/adminCategories.routes.js';
import { createAdminAuthRouter } from './routes/adminAuth.routes.js';
import { createAdminProductsRouter } from './routes/adminProducts.routes.js';
import healthRouter from './routes/health.routes.js';

export function createApp({
  adminAuthService,
  adminCategoriesService,
  adminProductsService,
  loginLimiter,
  trustProxy = env.TRUST_PROXY,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.use(
    cors({
      origin(requestOrigin, callback) {
        const isAllowed = !requestOrigin || requestOrigin === env.CLIENT_URL;
        callback(null, isAllowed);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(
    '/api/admin/auth',
    createAdminAuthRouter({
      authService: adminAuthService,
      isProduction: env.NODE_ENV === 'production',
      loginLimiter,
    }),
  );
  app.use(
    '/api/admin/categories',
    createAdminCategoriesRouter({
      authService: adminAuthService,
      categoriesService: adminCategoriesService,
    }),
  );
  app.use(
    '/api/admin/products',
    createAdminProductsRouter({
      authService: adminAuthService,
      productsService: adminProductsService,
    }),
  );
  app.use('/api/health', healthRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
