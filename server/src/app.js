import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import {
  categoryImagesDirectory as defaultCategoryImagesDirectory,
  categoryImagesPublicPath,
} from './config/categoryImages.js';
import {
  productImagesDirectory as defaultProductImagesDirectory,
  productImagesPublicPath,
} from './config/productImages.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { createAdminCategoriesRouter } from './routes/adminCategories.routes.js';
import { createAdminCategoryImagesRouter } from './routes/adminCategoryImages.routes.js';
import { createAdminAuthRouter } from './routes/adminAuth.routes.js';
import { createAdminProductImagesRouter } from './routes/adminProductImages.routes.js';
import { createAdminProductsRouter } from './routes/adminProducts.routes.js';
import healthRouter from './routes/health.routes.js';

export function createApp({
  adminAuthService,
  adminCategoryImagesService,
  adminCategoriesService,
  adminProductImagesService,
  adminProductsService,
  categoryImagesDirectory = defaultCategoryImagesDirectory,
  loginLimiter,
  productImagesDirectory = defaultProductImagesDirectory,
  trustProxy = env.TRUST_PROXY,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.options('/api/admin/products/:productId/image', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.options('/api/admin/categories/:categoryId/image', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.use(
    cors({
      origin(requestOrigin, callback) {
        const isAllowed = !requestOrigin || requestOrigin === env.CLIENT_URL;
        callback(null, isAllowed);
      },
      credentials: true,
    }),
  );
  app.use(
    categoryImagesPublicPath,
    express.static(categoryImagesDirectory, {
      dotfiles: 'deny',
      fallthrough: true,
      index: false,
    }),
  );
  app.use(
    productImagesPublicPath,
    express.static(productImagesDirectory, {
      dotfiles: 'deny',
      fallthrough: true,
      index: false,
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
    createAdminCategoryImagesRouter({
      authService: adminAuthService,
      categoryImagesService: adminCategoryImagesService,
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
    createAdminProductImagesRouter({
      authService: adminAuthService,
      productImagesService: adminProductImagesService,
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
