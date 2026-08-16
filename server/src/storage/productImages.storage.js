import {
  productImagesDirectory,
  productImagesPublicPath,
} from '../config/productImages.js';
import { createManagedImageStorage } from './managedImages.storage.js';

export function createProductImageStorage({
  rootDirectory = productImagesDirectory,
  fileSystem,
  createRandomBytes,
} = {}) {
  return createManagedImageStorage({
    rootDirectory,
    publicPath: productImagesPublicPath,
    entityName: 'Product image',
    collisionCode: 'PRODUCT_IMAGE_NAME_COLLISION',
    fileSystem,
    createRandomBytes,
  });
}

export const productImageStorage = createProductImageStorage();
