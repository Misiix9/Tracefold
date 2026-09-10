export const MAX_IMAGE_PIXELS = 16_000_000,
  MAX_IMAGE_EDGE = 8192;
function valid(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error('The image has invalid dimensions.');
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS)
    throw new Error('Choose an image up to 16 megapixels and 8,192 pixels on each edge.');
  return { width, height };
}
/** Bound decoder work from encoded headers before asking the browser to decode pixels. */
export function imageDimensions(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at: number, length: number) => {
    if (at < 0 || at + length > bytes.length) throw new Error('The image header is incomplete.');
  };
  const ascii = (at: number, length: number) => {
    need(at, length);
    return String.fromCharCode(...bytes.subarray(at, at + length));
  };
  if (mime === 'image/png') {
    need(0, 33);
    if (
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 ||
      ascii(12, 4) !== 'IHDR'
    )
      throw new Error('Invalid PNG header.');
    return valid(view.getUint32(16), view.getUint32(20));
  }
  if (mime === 'image/jpeg') {
    need(0, 2);
    if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid JPEG header.');
    let at = 2;
    while (at < bytes.length) {
      need(at, 2);
      if (bytes[at++] !== 255) throw new Error('Invalid JPEG segment.');
      while (bytes[at] === 255) at++;
      need(at, 1);
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      need(at, 2);
      const length = view.getUint16(at);
      if (length < 2) throw new Error('Invalid JPEG segment size.');
      need(at, length);
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        need(at, 8);
        return valid(view.getUint16(at + 5), view.getUint16(at + 3));
      }
      at += length;
    }
    throw new Error('The JPEG has no readable frame dimensions.');
  }
  if (mime === 'image/gif') {
    if (!['GIF87a', 'GIF89a'].includes(ascii(0, 6))) throw new Error('Invalid GIF header.');
    need(6, 7);
    const size = valid(view.getUint16(6, true), view.getUint16(8, true));
    let at = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0),
      frames = 0;
    const blocks = () => {
      while (true) {
        need(at, 1);
        const length = bytes[at++];
        if (!length) break;
        need(at, length);
        at += length;
      }
    };
    while (at < bytes.length) {
      const marker = bytes[at++];
      if (marker === 59) break;
      if (marker === 33) {
        need(at, 1);
        at++;
        blocks();
      } else if (marker === 44) {
        need(at, 9);
        const x = view.getUint16(at, true),
          y = view.getUint16(at + 2, true),
          frame = valid(view.getUint16(at + 4, true), view.getUint16(at + 6, true));
        if (x + frame.width > size.width || y + frame.height > size.height || ++frames > 1000)
          throw new Error('GIF frames exceed the supported canvas or frame count.');
        const packed = bytes[at + 8];
        at += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0);
        need(at, 1);
        at++;
        blocks();
      } else throw new Error('Invalid GIF block.');
    }
    if (!frames) throw new Error('The GIF has no image frame.');
    return size;
  }
  if (mime === 'image/webp') {
    need(0, 20);
    if (
      ascii(0, 4) !== 'RIFF' ||
      ascii(8, 4) !== 'WEBP' ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      throw new Error('Invalid WebP header.');
    let at = 12,
      size: { width: number; height: number } | undefined;
    while (at + 8 <= bytes.length) {
      const kind = ascii(at, 4),
        length = view.getUint32(at + 4, true),
        start = at + 8;
      need(start, length);
      if (kind === 'VP8X') {
        need(start, 10);
        if (bytes[start] & 2)
          throw new Error('For animated WebP, export the frame you need as PNG before importing.');
        const u24 = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
        size = valid(u24(start + 4) + 1, u24(start + 7) + 1);
      }
      if (kind === 'VP8 ') {
        need(start, 10);
        if (ascii(start + 3, 3) !== '\x9d\x01\x2a') throw new Error('Invalid WebP frame.');
        const frame = valid(
          view.getUint16(start + 6, true) & 0x3fff,
          view.getUint16(start + 8, true) & 0x3fff,
        );
        if (size && (size.width !== frame.width || size.height !== frame.height))
          throw new Error('WebP frame size mismatch.');
        return frame;
      }
      if (kind === 'VP8L') {
        need(start, 5);
        if (bytes[start] !== 47) throw new Error('Invalid lossless WebP frame.');
        const bits = view.getUint32(start + 1, true);
        const frame = valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        if (size && (size.width !== frame.width || size.height !== frame.height))
          throw new Error('WebP frame size mismatch.');
        return frame;
      }
      at = start + length + (length % 2);
    }
    throw new Error('The WebP has no readable image frame.');
  }
  throw new Error('Import a PNG, JPEG, WebP, or GIF image.');
}
