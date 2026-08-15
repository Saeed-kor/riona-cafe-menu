import path from 'node:path';

import sharp from 'sharp';

import { maximumProductImageBytes } from '../config/productImages.js';

const maximumProductImagePixels = 16_777_216;
const sharpInputOptions = Object.freeze({
  animated: false,
  failOn: 'warning',
  limitInputChannels: 4,
  limitInputPixels: maximumProductImagePixels,
  pages: 1,
  sequentialRead: true,
  unlimited: false,
});

const supportedFormats = Object.freeze({
  jpeg: Object.freeze({
    extension: '.jpg',
    acceptedExtensions: Object.freeze(new Set(['.jpg', '.jpeg'])),
    mimeType: 'image/jpeg',
  }),
  png: Object.freeze({
    extension: '.png',
    acceptedExtensions: Object.freeze(new Set(['.png'])),
    mimeType: 'image/png',
  }),
  webp: Object.freeze({
    extension: '.webp',
    acceptedExtensions: Object.freeze(new Set(['.webp'])),
    mimeType: 'image/webp',
  }),
});

export function createProductImageError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.isSafeToDisplay = true;
  return error;
}

function hasSafeOriginalName(originalName) {
  return (
    typeof originalName === 'string' &&
    originalName !== '' &&
    originalName === path.posix.basename(originalName) &&
    originalName === path.win32.basename(originalName) &&
    !path.posix.isAbsolute(originalName) &&
    !path.win32.isAbsolute(originalName)
  );
}

export async function detectProductImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }

  try {
    const decoder = sharp(buffer, sharpInputOptions);
    const metadata = await decoder.metadata();
    const format = supportedFormats[metadata.format];

    if (!format || (metadata.pages ?? 1) !== 1) {
      return null;
    }

    // metadata() only parses headers. Producing raw pixels forces libvips to
    // decode the complete payload and reject truncation or corrupt image data.
    await decoder.raw().toBuffer();
    return format;
  } catch {
    return null;
  }
}

async function createCanonicalProductImage(buffer, format) {
  const encoder = sharp(buffer, sharpInputOptions).rotate();
  let canonicalBuffer;

  if (format.extension === '.jpg') {
    canonicalBuffer = await encoder.jpeg().toBuffer();
  } else if (format.extension === '.png') {
    canonicalBuffer = await encoder.png().toBuffer();
  } else {
    canonicalBuffer = await encoder.webp().toBuffer();
  }

  if (canonicalBuffer.length > maximumProductImageBytes) {
    throw createProductImageError(
      'Product image exceeds the 5 MiB limit',
      'PRODUCT_IMAGE_TOO_LARGE',
      413,
    );
  }

  return canonicalBuffer;
}

export async function validateProductImageFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw createProductImageError(
      'Exactly one product image is required',
      'PRODUCT_IMAGE_REQUIRED',
    );
  }

  if (file.buffer.length === 0) {
    throw createProductImageError('Product image is empty', 'EMPTY_PRODUCT_IMAGE');
  }

  if (file.buffer.length > maximumProductImageBytes) {
    throw createProductImageError(
      'Product image exceeds the 5 MiB limit',
      'PRODUCT_IMAGE_TOO_LARGE',
      413,
    );
  }

  if (!hasSafeOriginalName(file.originalname)) {
    throw createProductImageError(
      'Product image filename is invalid',
      'INVALID_PRODUCT_IMAGE_NAME',
    );
  }

  const format = await detectProductImageFormat(file.buffer);
  const extension = path.extname(file.originalname).toLowerCase();

  if (
    !format ||
    file.mimetype !== format.mimeType ||
    !format.acceptedExtensions.has(extension)
  ) {
    throw createProductImageError(
      'Product image must be a valid JPEG, PNG, or WebP file',
      'INVALID_PRODUCT_IMAGE_FORMAT',
    );
  }

  const canonicalBuffer = await createCanonicalProductImage(file.buffer, format);

  return Object.freeze({
    buffer: canonicalBuffer,
    extension: format.extension,
    mimeType: format.mimeType,
  });
}
