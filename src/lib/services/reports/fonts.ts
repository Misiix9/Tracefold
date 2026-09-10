import coverage from './font-coverage.json';
import { ReportError } from './types';
export type ReportFont = keyof typeof coverage;
export function supports(font: ReportFont, character: string) {
  const cp = character.codePointAt(0)!;
  if (cp === 9 || cp === 10 || cp === 13) return true;
  const ranges = coverage[font];
  let low = 0,
    high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1,
      [start, end] = ranges[mid];
    if (cp < start) high = mid - 1;
    else if (cp > end) low = mid + 1;
    else return true;
  }
  return false;
}
export function fontRuns(
  text: string,
  preferred: ReportFont,
  strict = true,
): { text: string; font: ReportFont }[] {
  const runs: { text: string; font: ReportFont }[] = [];
  for (const character of text) {
    const font = supports(preferred, character)
      ? preferred
      : supports('Fallback', character)
        ? 'Fallback'
        : supports('CJK', character)
          ? 'CJK'
          : undefined;
    if (!font && strict)
      throw new ReportError(
        'UNSUPPORTED_GLYPH',
        `The PDF fonts do not include U+${character.codePointAt(0)!.toString(16).toUpperCase()}. Export an editable DOCX or HTML file to preserve this text with your system fonts.`,
      );
    const selected = font ?? preferred,
      last = runs.at(-1);
    if (last?.font === selected) last.text += character;
    else runs.push({ text: character, font: selected });
  }
  return runs.length ? runs : [{ text: '', font: preferred }];
}
export function fallbackFamilies(text: string): ('Fallback' | 'CJK')[] {
  const found = new Set<'Fallback' | 'CJK'>();
  for (const preferred of ['Lexend', 'Newsreader', 'Mono'] as const)
    for (const run of fontRuns(text, preferred, false))
      if (run.font === 'Fallback' || run.font === 'CJK') found.add(run.font);
  return [...found];
}
/** pdfmake has no automatic fallback: preserve font selection through tables and inline runs. */
export function withPdfFonts(value: unknown, parent: ReportFont = 'Lexend'): unknown {
  if (Array.isArray(value)) return value.map((v) => withPdfFonts(v, parent));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const preferred =
    (object.font as ReportFont | undefined) ??
    (['title', 'heading'].includes(String(object.style)) ? 'Newsreader' : parent);
  return Object.fromEntries(
    Object.entries(object).map(([key, v]) => [
      key,
      key === 'text' && typeof v === 'string' ? fontRuns(v, preferred) : withPdfFonts(v, preferred),
    ]),
  );
}
