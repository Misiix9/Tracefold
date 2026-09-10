import { describe, it, expect } from 'vitest';
import { imageDimensions } from './image-dimensions';
function png(width: number, height: number) {
  const b = new Uint8Array(33),
    v = new DataView(b.buffer);
  v.setUint32(0, 0x89504e47);
  v.setUint32(4, 0x0d0a1a0a);
  v.setUint32(8, 13);
  b.set([73, 72, 68, 82], 12);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}
describe('image decoder allocation boundary', () => {
  it('accepts supported image dimensions from a header before pixel decoding', () => {
    expect(imageDimensions(png(1440, 900), 'image/png')).toEqual({ width: 1440, height: 900 });
  });
  it('rejects oversized images before decoding', () => {
    for (const [w, h] of [
      [8193, 1],
      [4001, 4000],
      [0, 2],
      [0xffffffff, 0xffffffff],
    ])
      expect(() => imageDimensions(png(w, h), 'image/png')).toThrow();
  });
  it('rejects invalid signatures and truncated formats', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      expect(() => imageDimensions(new Uint8Array(10), mime)).toThrow();
  });
  it('reads JPEG frame dimensions after optional segments', () => {
    const bytes = new Uint8Array([
      255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 3, 132, 5, 160, 1, 1, 0x11, 0,
    ]);
    expect(imageDimensions(bytes, 'image/jpeg')).toEqual({ width: 1440, height: 900 });
  });
  it('rejects GIF frames larger than their logical canvas', () => {
    const bytes = new Uint8Array([
      71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 255, 127, 1, 0, 0, 2, 0, 59,
    ]);
    expect(() => imageDimensions(bytes, 'image/gif')).toThrow();
  });
});
