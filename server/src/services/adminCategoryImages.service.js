import { categoryImageStorage as defaultStorage } from '../storage/categoryImages.storage.js';
import { createAdminEntityImagesService } from './adminEntityImages.service.js';
import {
  createCategoryNotFoundError,
  parseCategoryId,
  selectCategoryById,
} from './adminCategories.service.js';
import {
  logCategoryImageCleanupFailure,
  removeCategoryImageAfterCommit,
} from './categoryImageCleanup.js';

let databaseModulePromise = null;

async function getDefaultExecutor() {
  databaseModulePromise ??= import('../config/db.js').catch((error) => {
    databaseModulePromise = null;
    throw error;
  });

  const { pool } = await databaseModulePromise;
  return pool;
}

async function updateCategoryImagePath(connection, categoryId, imagePath) {
  if (imagePath === null) {
    await connection.execute(
      'UPDATE categories SET image_path = NULL WHERE id = ?',
      [categoryId],
    );
    return;
  }

  await connection.execute(
    'UPDATE categories SET image_path = ? WHERE id = ?',
    [imagePath, categoryId],
  );
}

export function createAdminCategoryImagesService({
  executor,
  storage = defaultStorage,
  logger = console,
} = {}) {
  const imageService = createAdminEntityImagesService({
    executor,
    getDefaultExecutor,
    storage,
    logger,
    parseId: parseCategoryId,
    selectById: selectCategoryById,
    updateImagePath: updateCategoryImagePath,
    createNotFoundError: createCategoryNotFoundError,
    removeAfterCommit: removeCategoryImageAfterCommit,
    logCleanupFailure: logCategoryImageCleanupFailure,
    operationName: 'Category image',
    unknownCommitCode: 'CATEGORY_IMAGE_COMMIT_OUTCOME_UNKNOWN',
    replaceReloadErrorMessage: 'Updated category image could not be loaded.',
    removeReloadErrorMessage: 'Category without image could not be loaded.',
    resolveVerifiedReplaceCommit: true,
    verifyRemoveCommit: true,
    resolveVerifiedRemoveCommit: true,
    discardOnRollbackFailure: true,
  });

  return Object.freeze({
    ...imageService,

    async assertExists(categoryIdValue) {
      const categoryId = parseCategoryId(categoryIdValue);
      const databaseExecutor = executor ?? (await getDefaultExecutor());
      const category = await selectCategoryById(databaseExecutor, categoryId);

      if (!category) {
        throw createCategoryNotFoundError();
      }

      return category;
    },
  });
}

export const adminCategoryImagesService = createAdminCategoryImagesService();
