import { fileURLToPath } from 'node:url';

export const maximumProductImageBytes = 5 * 1024 * 1024;
export const productImagesPublicPath = '/uploads/products';
export const productImagesDirectory = fileURLToPath(
  new URL('../../uploads/products/', import.meta.url),
);
