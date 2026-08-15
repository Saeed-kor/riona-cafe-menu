import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { maximumProductImageBytes } from '../src/config/productImages.js';
import {
  detectProductImageFormat,
  validateProductImageFile,
} from '../src/services/productImageValidation.js';
import {
  corruptPngCrc,
  createAnimatedWebp,
  createPngWithExactSize,
  createPngWithDimensions,
  createPngWithInvalidHeader,
  createPngWithInvalidImageData,
  createValidJpeg,
  createValidPng,
  createValidWebp,
} from '../test-support/productImageFixtures.js';

const [validJpeg, validPng, validWebp, animatedWebp] = await Promise.all([
  createValidJpeg(),
  createValidPng(),
  createValidWebp(),
  createAnimatedWebp(),
]);

function uploadFile(buffer, originalname, mimetype) {
  return { buffer, originalname, mimetype };
}

test('accepts decodable JPEG, PNG, and WebP files with canonical output', async () => {
  for (const [buffer, originalname, mimetype, extension, expectedFormat] of [
    [validJpeg, 'coffee.JPEG', 'image/jpeg', '.jpg', 'jpeg'],
    [validPng, 'coffee.png', 'image/png', '.png', 'png'],
    [validWebp, 'coffee.webp', 'image/webp', '.webp', 'webp'],
  ]) {
    const validated = await validateProductImageFile(
      uploadFile(buffer, originalname, mimetype),
    );
    const metadata = await sharp(validated.buffer).metadata();

    assert.notEqual(validated.buffer, buffer);
    assert.equal(validated.extension, extension);
    assert.equal(validated.mimeType, mimetype);
    assert.equal(metadata.format, expectedFormat);
    assert.equal(metadata.pages ?? 1, 1);
    assert.equal('originalname' in validated, false);
    assert.equal((await detectProductImageFormat(buffer))?.extension, extension);
  }
});

test('removes trailing non-image payloads from every canonical output', async () => {
  const marker = Buffer.from('RIONA_TRAILING_PAYLOAD_MUST_NOT_SURVIVE');

  for (const [buffer, originalname, mimetype, expectedFormat] of [
    [validJpeg, 'coffee.jpg', 'image/jpeg', 'jpeg'],
    [validPng, 'coffee.png', 'image/png', 'png'],
    [validWebp, 'coffee.webp', 'image/webp', 'webp'],
  ]) {
    const input = Buffer.concat([buffer, marker]);
    const validated = await validateProductImageFile(
      uploadFile(input, originalname, mimetype),
    );
    const metadata = await sharp(validated.buffer).metadata();

    assert.equal(validated.buffer.includes(marker), false);
    assert.equal(metadata.format, expectedFormat);
    assert.equal(metadata.pages ?? 1, 1);
  }
});

test('rejects corrupt or non-decodable PNG, JPEG, and WebP payloads', async () => {
  const malformedFiles = [
    uploadFile(corruptPngCrc(validPng), 'crc.png', 'image/png'),
    uploadFile(createPngWithInvalidHeader(validPng), 'header.png', 'image/png'),
    uploadFile(
      createPngWithDimensions(validPng, 100_000, 100_000),
      'pixel-bomb.png',
      'image/png',
    ),
    uploadFile(createPngWithInvalidImageData(validPng), 'data.png', 'image/png'),
    uploadFile(validJpeg.subarray(0, validJpeg.length - 10), 'truncated.jpg', 'image/jpeg'),
    uploadFile(validWebp.subarray(0, validWebp.length - 4), 'truncated.webp', 'image/webp'),
    uploadFile(
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from('not a PNG'),
      ]),
      'magic.png',
      'image/png',
    ),
  ];

  for (const file of malformedFiles) {
    await assert.rejects(
      validateProductImageFile(file),
      (error) =>
        error.status === 400 &&
        error.code === 'INVALID_PRODUCT_IMAGE_FORMAT' &&
        error.isSafeToDisplay === true,
    );
  }
});

test('rejects a real multi-frame WebP through the production validator', async () => {
  const metadata = await sharp(animatedWebp, { animated: true }).metadata();

  assert.equal(metadata.format, 'webp');
  assert.ok(Number(metadata.pages) > 1);
  await assert.rejects(
    validateProductImageFile(
      uploadFile(animatedWebp, 'animated.webp', 'image/webp'),
    ),
    (error) =>
      error.status === 400 &&
      error.code === 'INVALID_PRODUCT_IMAGE_FORMAT' &&
      error.isSafeToDisplay === true,
  );
});

test('rejects missing, empty, spoofed, SVG, and unknown files', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const invalidFiles = [
    null,
    uploadFile(Buffer.alloc(0), 'empty.png', 'image/png'),
    uploadFile(Buffer.from('not an image'), 'fake.png', 'application/octet-stream'),
    uploadFile(Buffer.from('not an image'), 'fake.bin', 'image/png'),
    uploadFile(Buffer.from('not an image'), 'fake.png', 'image/png'),
    uploadFile(validPng, 'fake.jpg', 'image/png'),
    uploadFile(validPng, 'fake.png', 'image/jpeg'),
    uploadFile(svg, 'active.svg', 'image/svg+xml'),
    uploadFile(svg, 'renamed.png', 'image/png'),
    uploadFile(Buffer.from([1, 2, 3, 4]), 'unknown.webp', 'image/webp'),
  ];

  for (const file of invalidFiles) {
    await assert.rejects(
      validateProductImageFile(file),
      (error) => error.status === 400 && error.isSafeToDisplay === true,
    );
  }
});

test('accepts exactly 5 MiB and rejects one byte more with 413', async () => {
  const exactLimit = await createPngWithExactSize(maximumProductImageBytes);
  const validated = await validateProductImageFile(
    uploadFile(exactLimit, 'limit.png', 'image/png'),
  );

  assert.ok(validated.buffer.length <= maximumProductImageBytes);
  assert.equal((await sharp(validated.buffer).metadata()).format, 'png');
  await assert.rejects(
    validateProductImageFile(
      uploadFile(
        Buffer.concat([exactLimit, Buffer.from([0])]),
        'over.png',
        'image/png',
      ),
    ),
    (error) => error.status === 413 && error.code === 'PRODUCT_IMAGE_TOO_LARGE',
  );
});

test('rejects traversal and absolute original filenames', async () => {
  for (const originalname of [
    '../coffee.png',
    '..\\coffee.png',
    '/tmp/coffee.png',
    'C:\\temp\\coffee.png',
    '\\\\server\\share\\coffee.png',
  ]) {
    await assert.rejects(
      validateProductImageFile(uploadFile(validPng, originalname, 'image/png')),
      (error) =>
        error.status === 400 && error.code === 'INVALID_PRODUCT_IMAGE_NAME',
    );
  }
});

export { validJpeg, validPng, validWebp };
