import { describe, it, expect } from 'vitest';
import { fontRuns, withPdfFonts } from './fonts';
describe('report glyph preservation', () => {
  it('uses Lexend for supported text and bundled fallback for other scripts', () => {
    const runs = fontRuns('Árvíztűrő Δοκιμή Тест 測試', 'Lexend');
    expect(runs.map((r) => r.text).join('')).toBe('Árvíztűrő Δοκιμή Тест 測試');
    expect(runs[0].font).toBe('Lexend');
    expect(runs.some((r) => r.font === 'Fallback')).toBe(true);
  });
  it('carries heading and code fonts through nested content', () => {
    expect(withPdfFonts({ style: 'heading', text: 'Title' })).toEqual({
      style: 'heading',
      text: [{ text: 'Title', font: 'Newsreader' }],
    });
    expect(withPdfFonts({ font: 'Mono', text: 'let x = 1' })).toEqual({
      font: 'Mono',
      text: [{ text: 'let x = 1', font: 'Mono' }],
    });
  });
  it('blocks unsupported characters instead of silently exporting boxes', () => {
    expect(() => fontRuns('\u{10FFFF}', 'Lexend')).toThrow('U+10FFFF');
  });
});
