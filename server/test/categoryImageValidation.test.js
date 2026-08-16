import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { maximumProductImageBytes } from '../src/config/productImages.js';
import { validateCategoryImageFile } from '../src/services/productImageValidation.js';
import {
  createAnimatedWebp,
  createPngWithDimensions,
  createPngWithExactSize,
  createValidJpeg,
  createValidPng,
  createValidWebp,
} from '../test-support/productImageFixtures.js';

function uploadFile(buffer, originalname, mimetype) {
  return { buffer, originalname, mimetype };
}

test('category validation canonicalizes JPEG, PNG, and WebP and removes trailing payloads', async () => {
  const marker = Buffer.from('RIONA_CATEGORY_TRAILING_PAYLOAD');
  const fixtures = await Promise.all([
    createValidJpeg(),
    createValidPng(),
    createValidWebp(),
  ]);

  for (const [buffer, originalname, mimetype, expectedFormat] of [
    [fixtures[0], 'category.jpeg', 'image/jpeg', 'jpeg'],
    [fixtures[1], 'category.png', 'image/png', 'png'],
    [fixtures[2], 'category.webp', 'image/webp', 'webp'],
  ]) {
    const validated = await validateCategoryImageFile(
      uploadFile(Buffer.concat([buffer, marker]), originalname, mimetype),
    );
    const metadata = await sharp(validated.buffer).metadata();

    assert.equal(validated.buffer.includes(marker), false);
    assert.equal(metadata.format, expectedFormat);
    assert.equal(metadata.pages ?? 1, 1);
  }
});

test('category validation rejects animated and excessive-pixel images with category-safe errors', async () => {
  const [animatedWebp, validPng] = await Promise.all([
    createAnimatedWebp(),
    createValidPng(),
  ]);

  for (const file of [
    uploadFile(animatedWebp, 'animated.webp', 'image/webp'),
    uploadFile(
      createPngWithDimensions(validPng, 100_000, 100_000),
      'pixel-bomb.png',
      'image/png',
    ),
  ]) {
    await assert.rejects(
      validateCategoryImageFile(file),
      (error) =>
        error.status === 400 &&
        error.code === 'INVALID_CATEGORY_IMAGE_FORMAT' &&
        error.isSafeToDisplay === true,
    );
  }
});

test('category validation enforces the shared 5 MiB boundary with category error codes', async () => {
  const exactLimit = await createPngWithExactSize(maximumProductImageBytes);
  const validated = await validateCategoryImageFile(
    uploadFile(exactLimit, 'limit.png', 'image/png'),
  );

  assert.ok(validated.buffer.length <= maximumProductImageBytes);
  await assert.rejects(
    validateCategoryImageFile(
      uploadFile(
        Buffer.concat([exactLimit, Buffer.from([0])]),
        'over.png',
        'image/png',
      ),
    ),
    (error) =>
      error.status === 413 && error.code === 'CATEGORY_IMAGE_TOO_LARGE',
  );
});
