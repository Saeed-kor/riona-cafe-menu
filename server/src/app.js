import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import healthRouter from './routes/health.routes.js';

const app = express();

app.disable('x-powered-by');
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

app.use('/api/health', healthRouter);

app.use(notFound);
app.use(errorHandler);

export { app };
