import { fileURLToPath } from 'node:url';

export const categoryImagesPublicPath = '/uploads/categories';
export const categoryImagesDirectory = fileURLToPath(
  new URL('../../uploads/categories/', import.meta.url),
);
