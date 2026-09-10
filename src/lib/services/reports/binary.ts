import { Inflate } from 'fflate';
import { requireThat } from './types';

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function fromBase64(text: string, max: number): Uint8Array {
  requireThat(
    text.length <= Math.ceil(max / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text),
    'Invalid or oversized base64',
  );
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  requireThat(bytes.length <= max && base64(bytes) === text, 'Noncanonical base64');
  return bytes;
}
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
/** Feed small compressed chunks: a forged declared size cannot force an unbounded allocation. */
export function inflateBounded(bytes: Uint8Array, expected: number): Uint8Array {
  const output = new Uint8Array(expected);
  let count = 0;
  const stream = new Inflate((chunk) => {
    requireThat(count + chunk.length <= expected, 'Decompressed data exceeds declared bound');
    output.set(chunk, count);
    count += chunk.length;
  });
  for (let i = 0; i < bytes.length; i += 256)
    stream.push(bytes.subarray(i, i + 256), i + 256 >= bytes.length);
  requireThat(count === expected, 'Decompressed size mismatch');
  return output;
}
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}
