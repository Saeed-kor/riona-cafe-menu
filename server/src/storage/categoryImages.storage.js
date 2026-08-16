import {
  categoryImagesDirectory,
  categoryImagesPublicPath,
} from '../config/categoryImages.js';
import { createManagedImageStorage } from './managedImages.storage.js';

export function createCategoryImageStorage({
  rootDirectory = categoryImagesDirectory,
  fileSystem,
  createRandomBytes,
} = {}) {
  return createManagedImageStorage({
    rootDirectory,
    publicPath: categoryImagesPublicPath,
    entityName: 'Category image',
    collisionCode: 'CATEGORY_IMAGE_NAME_COLLISION',
    fileSystem,
    createRandomBytes,
  });
}

export const categoryImageStorage = createCategoryImageStorage();
