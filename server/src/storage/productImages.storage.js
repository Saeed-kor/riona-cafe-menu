import { randomBytes } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  productImagesDirectory,
  productImagesPublicPath,
} from '../config/productImages.js';

const managedFilenamePattern = /^[a-f0-9]{32}\.(?:jpg|png|webp)$/;
const managedExtensions = new Set(['.jpg', '.png', '.webp']);
const maximumFilenameAttempts = 5;

const defaultFileSystem = Object.freeze({ link, mkdir, rm, writeFile });

function combineStorageErrors(primaryError, cleanupErrors) {
  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  return new AggregateError(
    [primaryError, ...cleanupErrors],
    'Product image storage failed and cleanup was incomplete.',
    { cause: primaryError },
  );
}

export function createProductImageStorage({
  rootDirectory = productImagesDirectory,
  fileSystem = defaultFileSystem,
  createRandomBytes = randomBytes,
} = {}) {
  const resolvedRoot = path.resolve(rootDirectory);
  const temporaryDirectory = path.join(resolvedRoot, '.tmp');

  function resolveManagedPublicPath(publicPath) {
    if (typeof publicPath !== 'string') {
      return null;
    }

    const prefix = `${productImagesPublicPath}/`;

    if (!publicPath.startsWith(prefix)) {
      return null;
    }

    const filename = publicPath.slice(prefix.length);

    if (!managedFilenamePattern.test(filename)) {
      return null;
    }

    const absolutePath = path.resolve(resolvedRoot, filename);
    const relativePath = path.relative(resolvedRoot, absolutePath);

    if (
      relativePath === '' ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath) ||
      path.dirname(absolutePath) !== resolvedRoot
    ) {
      return null;
    }

    return absolutePath;
  }

  return Object.freeze({
    rootDirectory: resolvedRoot,

    resolveManagedPublicPath,

    async store(image) {
      if (
        !image ||
        !Buffer.isBuffer(image.buffer) ||
        !managedExtensions.has(image.extension)
      ) {
        throw new Error('Product image storage input is invalid.');
      }

      await fileSystem.mkdir(temporaryDirectory, { recursive: true });

      for (let attempt = 0; attempt < maximumFilenameAttempts; attempt += 1) {
        const randomName = createRandomBytes(16).toString('hex');

        if (!/^[a-f0-9]{32}$/.test(randomName)) {
          throw new Error('Secure product image filename could not be generated.');
        }

        const filename = `${randomName}${image.extension}`;
        const temporaryPath = path.join(temporaryDirectory, `${randomName}.tmp`);
        const finalPath = path.join(resolvedRoot, filename);
        let ownsTemporaryFile = false;
        let publishedFinalFile = false;

        try {
          await fileSystem.writeFile(temporaryPath, image.buffer, {
            flag: 'wx',
            mode: 0o600,
          });
          ownsTemporaryFile = true;
          await fileSystem.link(temporaryPath, finalPath);
          publishedFinalFile = true;
          await fileSystem.rm(temporaryPath, { force: true });
          ownsTemporaryFile = false;

          return Object.freeze({
            publicPath: `${productImagesPublicPath}/${filename}`,
          });
        } catch (primaryError) {
          const cleanupErrors = [];

          if (publishedFinalFile) {
            try {
              await fileSystem.rm(finalPath, { force: true });
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }

          if (ownsTemporaryFile) {
            try {
              await fileSystem.rm(temporaryPath, { force: true });
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }

          const isCollision = primaryError?.code === 'EEXIST';

          if (
            isCollision &&
            !publishedFinalFile &&
            cleanupErrors.length === 0 &&
            attempt + 1 < maximumFilenameAttempts
          ) {
            continue;
          }

          if (
            isCollision &&
            !publishedFinalFile &&
            cleanupErrors.length === 0
          ) {
            const collisionError = new Error(
              'A unique product image filename could not be allocated.',
            );
            collisionError.code = 'PRODUCT_IMAGE_NAME_COLLISION';
            throw collisionError;
          }

          throw combineStorageErrors(primaryError, cleanupErrors);
        }
      }

      throw new Error('A unique product image filename could not be allocated.');
    },

    async remove(publicPath) {
      const absolutePath = resolveManagedPublicPath(publicPath);

      if (!absolutePath) {
        return false;
      }

      await fileSystem.rm(absolutePath, { force: true });
      return true;
    },
  });
}

export const productImageStorage = createProductImageStorage();
