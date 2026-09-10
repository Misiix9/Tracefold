import { describe, it, expect } from 'vitest';
import { zlibSync, unzlibSync } from 'fflate';
import { sanitizeAsset } from './assets';
import { concatBytes, crc32, utf8 } from './binary';
function chunk(type: string, data: Uint8Array) {
  const b = new Uint8Array(data.length + 12),
    v = new DataView(b.buffer);
  v.setUint32(0, data.length);
  b.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  b.set(data, 8);
  v.setUint32(data.length + 8, crc32(b.subarray(4, data.length + 8)));
  return b;
}
function png(raw: Uint8Array, metadata = false) {
  const header = new Uint8Array(13),
    v = new DataView(header.buffer);
  v.setUint32(0, 2);
  v.setUint32(4, 1);
  header.set([8, 6, 0, 0, 0], 8);
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(metadata ? [chunk('tEXt', utf8('Note\0PRIVATE_PIXEL_SENTINEL'))] : []),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}
function decoded(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at < bytes.length) {
    const size = v.getUint32(at);
    if (new TextDecoder().decode(bytes.subarray(at + 4, at + 8)) === 'IDAT')
      return unzlibSync(bytes.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  throw new Error('Missing pixels');
}
describe('canonical sharing pixels', () => {
  it('removes metadata and invisible RGB values while retaining visible pixels', async () => {
    const clean = await sanitizeAsset(
      png(new Uint8Array([0, 83, 69, 67, 0, 0, 0, 0, 255]), true),
      'image/png',
    );
    expect(new TextDecoder().decode(clean.bytes)).not.toContain('PRIVATE_PIXEL_SENTINEL');
    expect([...decoded(clean.bytes)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 255]);
  });
  it('decodes Sub-filtered pixels and re-encodes a stable canonical stream', async () => {
    const original = png(new Uint8Array([1, 10, 20, 30, 255, 30, 30, 30, 0]));
    const first = await sanitizeAsset(original, 'image/png'),
      second = await sanitizeAsset(first.bytes, 'image/png');
    expect([...decoded(first.bytes)]).toEqual([0, 10, 20, 30, 255, 40, 50, 60, 255]);
    expect(second.hash).toBe(first.hash);
    expect(second.bytes).toEqual(first.bytes);
  });
  it('rejects corrupt source pixels before producing an export', async () => {
    const bytes = png(new Uint8Array([0, 1, 2, 3, 255, 4, 5, 6, 255]));
    bytes[bytes.length - 16] ^= 1;
    await expect(sanitizeAsset(bytes, 'image/png')).rejects.toThrow();
  });
});
