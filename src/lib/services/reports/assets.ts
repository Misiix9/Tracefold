import { concatBytes, crc32, decodeUtf8, inflateBounded, sha256 } from './binary';
import { REPORT_LIMITS, requireThat } from './types';
import type { ReportAsset } from './types';
import { zlibSync } from 'fflate';

/** Canonical raster boundary. Annotation redactions must already be flattened into pixels. */
export async function sanitizeAsset(input: Uint8Array, mimeType: string): Promise<ReportAsset> {
  requireThat(
    input.length > 0 && input.length <= REPORT_LIMITS.assetBytes,
    'Missing or oversized evidence',
    'INVALID_ASSET',
  );
  let bytes: Uint8Array;
  let width: number | undefined;
  let height: number | undefined;
  if (mimeType === 'image/png') {
    const clean = sanitizePng(input);
    bytes = clean.bytes;
    width = clean.width;
    height = clean.height;
  } else if (mimeType === 'text/plain') {
    const text = decodeUtf8(input);
    requireThat(
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text),
      'Binary data in text evidence',
    );
    bytes = new Uint8Array(input);
  } else
    throw new Error(
      `Evidence type ${mimeType} needs a native sanitizer; only PNG and UTF-8 text are supported`,
    );
  requireThat(
    bytes.length <= REPORT_LIMITS.assetBytes,
    'Normalized evidence exceeds the sharing size limit',
  );
  const hash = await sha256(bytes);
  return {
    mimeType,
    bytes,
    filename: `assets/${hash}.${mimeType === 'image/png' ? 'png' : 'txt'}`,
    hash,
    size: bytes.length,
    ...(width === undefined ? {} : { width, height }),
  };
}

function sanitizePng(input: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  requireThat(
    input.length >= 57 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a,
    'Invalid PNG signature',
  );
  const compressed: Uint8Array[] = [];
  let at = 8,
    width = 0,
    height = 0,
    channels = 0,
    sawEnd = false,
    sawData = false,
    endedData = false;
  // Restrict to native normalized, noninterlaced 8-bit RGB/RGBA; palette/transparency may hide pixels.
  while (at < input.length) {
    requireThat(at + 12 <= input.length, 'Truncated PNG');
    const size = view.getUint32(at),
      end = at + size + 12;
    requireThat(end <= input.length, 'Truncated PNG chunk');
    const type = String.fromCharCode(...input.subarray(at + 4, at + 8));
    requireThat(
      crc32(input.subarray(at + 4, end - 4)) === view.getUint32(end - 4),
      'PNG checksum mismatch',
    );
    if (at === 8) {
      requireThat(type === 'IHDR' && size === 13, 'Missing PNG header');
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      channels = input[at + 17] === 2 ? 3 : input[at + 17] === 6 ? 4 : 0;
      requireThat(
        width > 0 &&
          height > 0 &&
          width <= REPORT_LIMITS.imageDimension &&
          height <= REPORT_LIMITS.imageDimension &&
          width * height <= REPORT_LIMITS.imagePixels,
        'PNG resource limit exceeded',
      );
      requireThat(
        input[at + 16] === 8 &&
          channels &&
          input[at + 18] === 0 &&
          input[at + 19] === 0 &&
          input[at + 20] === 0,
        'PNG must be normalized 8-bit RGB/RGBA without interlacing',
      );
    } else if (type === 'IDAT') {
      requireThat(!endedData, 'Noncontiguous PNG image data');
      sawData = true;
      compressed.push(input.subarray(at + 8, end - 4));
    } else if (type === 'IEND') {
      requireThat(size === 0 && sawData && end === input.length, 'Invalid PNG end');
      sawEnd = true;
    } else {
      if (sawData) endedData = true;
      requireThat(
        /^[a-z][A-Za-z]{3}$/.test(type) && !['acTL', 'fcTL', 'fdAT', 'tRNS'].includes(type),
        'Unsupported PNG chunk',
      );
      // Strip ALL ancillary metadata, embedded previews and profiles.
    }
    at = end;
  }
  requireThat(sawEnd, 'Missing PNG end');
  const z = concatBytes(compressed);
  requireThat(
    z.length >= 6 &&
      (z[0] & 15) === 8 &&
      z[0] >> 4 <= 7 &&
      ((z[0] << 8) + z[1]) % 31 === 0 &&
      !(z[1] & 32),
    'Invalid PNG zlib header',
  );
  const stride = width * channels + 1,
    pixels = inflateBounded(z.subarray(2, -4), stride * height);
  let a = 1,
    b = 0;
  for (const pixel of pixels) {
    a = (a + pixel) % 65521;
    b = (b + a) % 65521;
  }
  requireThat(
    ((b << 16) | a) >>> 0 ===
      new DataView(z.buffer, z.byteOffset, z.byteLength).getUint32(z.length - 4),
    'PNG pixel checksum mismatch',
  );
  for (let i = 0; i < pixels.length; i += stride)
    requireThat(pixels[i] <= 4, 'Invalid PNG scanline filter');
  // Reconstruct every scanline and encode a fresh stream. Merely copying IDAT
  // can retain padding or hidden compressed payloads after the visible image.
  const normalized = new Uint8Array(pixels.length),
    rowBytes = width * channels;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const row = y * stride,
      filter = pixels[row];
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= channels ? normalized[row + 1 + x - channels] : 0,
        up = y ? normalized[row - stride + 1 + x] : 0,
        upperLeft = y && x >= channels ? normalized[row - stride + 1 + x - channels] : 0;
      const prediction =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, upperLeft)
                : 0;
      normalized[row + 1 + x] = (pixels[row + 1 + x] + prediction) & 255;
    }
  }
  // Fully transparent source pixels must not carry invisible original colors.
  if (channels === 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = y * stride + 1 + x * 4;
        if (normalized[p + 3] === 0) normalized.fill(0, p, p + 3);
      }
  const chunk = (type: string, data: Uint8Array) => {
    const bytes = new Uint8Array(data.length + 12),
      v = new DataView(bytes.buffer);
    v.setUint32(0, data.length);
    bytes.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    bytes.set(data, 8);
    v.setUint32(data.length + 8, crc32(bytes.subarray(4, data.length + 8)));
    return bytes;
  };
  return {
    bytes: concatBytes([
      input.slice(0, 8),
      chunk('IHDR', input.slice(16, 29)),
      chunk('IDAT', zlibSync(normalized, { level: 6 })),
      chunk('IEND', new Uint8Array()),
    ]),
    width,
    height,
  };
}
