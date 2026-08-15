import sharp from 'sharp';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function pngChunks(buffer) {
  if (!buffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error('Fixture is not a PNG image.');
  }

  const chunks = [];
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;

    if (end > buffer.length) {
      throw new Error('Fixture PNG is truncated.');
    }

    chunks.push({
      data: buffer.subarray(offset + 8, offset + 8 + length),
      end,
      offset,
      type: buffer.toString('ascii', offset + 4, offset + 8),
    });
    offset = end;
  }

  return chunks;
}

function imageSource() {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 87, g: 45, b: 20, alpha: 1 },
    },
  });
}

export function createValidJpeg() {
  return imageSource().jpeg({ quality: 80 }).toBuffer();
}

export function createValidPng() {
  return imageSource().png().toBuffer();
}

export function createValidWebp() {
  return imageSource().webp({ lossless: true }).toBuffer();
}

export function createAnimatedWebp() {
  const frameWidth = 2;
  const frameHeight = 2;
  const channels = 4;
  const frameBytes = frameWidth * frameHeight * channels;
  const firstFrame = Buffer.alloc(frameBytes);
  const secondFrame = Buffer.alloc(frameBytes);

  for (let offset = 0; offset < frameBytes; offset += channels) {
    firstFrame.set([255, 0, 0, 255], offset);
    secondFrame.set([0, 0, 255, 255], offset);
  }

  return sharp(Buffer.concat([firstFrame, secondFrame]), {
    raw: {
      width: frameWidth,
      height: frameHeight * 2,
      channels,
      pageHeight: frameHeight,
    },
  })
    .webp({ delay: [100, 100], loop: 0 })
    .toBuffer();
}

export async function createPngWithExactSize(totalBytes) {
  const base = await createValidPng();
  const payloadBytes = totalBytes - base.length - 12;

  if (payloadBytes < 0) {
    throw new Error('Requested PNG size is too small.');
  }

  const iend = pngChunks(base).find((chunk) => chunk.type === 'IEND');

  return Buffer.concat([
    base.subarray(0, iend.offset),
    pngChunk('ruSt', Buffer.alloc(payloadBytes)),
    base.subarray(iend.offset),
  ]);
}

export function corruptPngCrc(buffer) {
  const corrupted = Buffer.from(buffer);
  const idat = pngChunks(corrupted).find((chunk) => chunk.type === 'IDAT');
  const crcOffset = idat.end - 4;
  corrupted[crcOffset] ^= 0xff;
  return corrupted;
}

export function createPngWithDimensions(buffer, width, height) {
  const chunks = pngChunks(buffer);
  const header = chunks.find((chunk) => chunk.type === 'IHDR');
  const resizedHeader = Buffer.from(header.data);
  resizedHeader.writeUInt32BE(width, 0);
  resizedHeader.writeUInt32BE(height, 4);

  return Buffer.concat([
    pngSignature,
    ...chunks.map((chunk) =>
      chunk.type === 'IHDR'
        ? pngChunk('IHDR', resizedHeader)
        : pngChunk(chunk.type, chunk.data),
    ),
  ]);
}

export function createPngWithInvalidHeader(buffer) {
  return createPngWithDimensions(buffer, 0, 2);
}

export function createPngWithInvalidImageData(buffer) {
  const chunks = pngChunks(buffer);
  const header = chunks.find((chunk) => chunk.type === 'IHDR');

  return Buffer.concat([
    pngSignature,
    pngChunk('IHDR', header.data),
    pngChunk('IDAT', Buffer.from([0x00])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
