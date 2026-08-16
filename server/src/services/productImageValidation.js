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

function createImageError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.isSafeToDisplay = true;
  return error;
}

export function createManagedImageError(message, code, status = 400) {
  return createImageError(message, code, status);
}

export function createProductImageError(message, code, status = 400) {
  return createImageError(message, code, status);
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

async function createCanonicalImage(buffer, format, subject, codePrefix) {
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
    throw createImageError(
      `${subject} exceeds the 5 MiB limit`,
      `${codePrefix}_TOO_LARGE`,
      413,
    );
  }

  return canonicalBuffer;
}

export async function validateManagedImageFile(
  file,
  { subject = 'Image', codePrefix = 'IMAGE' } = {},
) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw createImageError(
      `Exactly one ${subject.toLowerCase()} is required`,
      `${codePrefix}_REQUIRED`,
    );
  }

  if (file.buffer.length === 0) {
    throw createImageError(`${subject} is empty`, `EMPTY_${codePrefix}`);
  }

  if (file.buffer.length > maximumProductImageBytes) {
    throw createImageError(
      `${subject} exceeds the 5 MiB limit`,
      `${codePrefix}_TOO_LARGE`,
      413,
    );
  }

  if (!hasSafeOriginalName(file.originalname)) {
    throw createImageError(
      `${subject} filename is invalid`,
      `INVALID_${codePrefix}_NAME`,
    );
  }

  const format = await detectProductImageFormat(file.buffer);
  const extension = path.extname(file.originalname).toLowerCase();

  if (
    !format ||
    file.mimetype !== format.mimeType ||
    !format.acceptedExtensions.has(extension)
  ) {
    throw createImageError(
      `${subject} must be a valid JPEG, PNG, or WebP file`,
      `INVALID_${codePrefix}_FORMAT`,
    );
  }

  const canonicalBuffer = await createCanonicalImage(
    file.buffer,
    format,
    subject,
    codePrefix,
  );

  return Object.freeze({
    buffer: canonicalBuffer,
    extension: format.extension,
    mimeType: format.mimeType,
  });
}

export function validateProductImageFile(file) {
  return validateManagedImageFile(file, {
    subject: 'Product image',
    codePrefix: 'PRODUCT_IMAGE',
  });
}

export function validateCategoryImageFile(file) {
  return validateManagedImageFile(file, {
    subject: 'Category image',
    codePrefix: 'CATEGORY_IMAGE',
  });
}
