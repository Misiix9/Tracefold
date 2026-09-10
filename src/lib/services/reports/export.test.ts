import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { createEntity, defaultData, textDoc } from '../../domain/defaults';
import type { Project, RichNode } from '../../domain/types';
import { assembleReportSnapshot } from './snapshot';
import { exportReport } from './export';
const at = '2026-09-09T12:00:00.000Z';
const project: Project = {
  id: 'fixture',
  name: 'Checkout investigation',
  description: '',
  prefix: 'QA',
  color: '#783D49',
  createdAt: at,
  updatedAt: at,
  revision: 1,
  archived: false,
};
const p = (text: string): RichNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
async function fixture() {
  const body: RichNode = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'A clear account of the test' }],
      },
      p(
        'The basket keeps its contents after an interrupted payment. Accented text: ő, ű, é, Å, Straße, français. Greek: Δοκιμή. Cyrillic: Тест. CJK: 測試.',
      ),
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Expected: ', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'Return safely to checkout.', marks: [{ type: 'italic' }] },
        ],
      },
      {
        type: 'codeBlock',
        content: [
          { type: 'text', text: 'POST /checkout\n  request_id: "qa-42"\n  result: retry_allowed' },
        ],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: ['Step', 'Action', 'Expected'].map((text) => ({
              type: 'tableHeader',
              content: [p(text)],
            })),
          },
          ...Array.from({ length: 42 }, (_, i) => ({
            type: 'tableRow',
            content: [
              String(i + 1),
              `Check recovery variation ${i + 1}`,
              i % 2
                ? 'Keep every item in the basket and show a clear retry action.'
                : 'Show the original address without losing the selected delivery option.',
            ].map((text) => ({ type: 'tableCell', content: [p(text)] })),
          })),
        ],
      },
      p('End of the recorded walkthrough. PUBLIC_EXPORT_SENTINEL'),
    ],
  };
  const note = createEntity(
    project.id,
    'document',
    'Payment recovery walkthrough',
    defaultData('document'),
    body,
  );
  const privateNote = createEntity(
    project.id,
    'document',
    'PRIVATE_EXPORT_SENTINEL',
    { ...defaultData('document'), private: true },
    textDoc('PRIVATE_EXPORT_SENTINEL'),
  );
  return assembleReportSnapshot({
    project,
    records: [note, privateNote],
    options: {
      format: 'pdf',
      title: 'Payment recovery',
      author: 'QA team',
      pageSize: 'A4',
      includeEvidence: false,
      includePrivate: false,
      includeHistory: false,
      scope: 'project',
      entityIds: [],
    },
    generatedAt: at,
    readAsset: async () => {
      throw new Error('Unexpected asset');
    },
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('real report files', () => {
  it('embeds local fonts and retains public content in every export', async () => {
    vi.stubGlobal(
      'fetch',
      async (path: string) =>
        new Response(await readFile(resolve('public', path.replace(/^\//, '')))),
    );
    const base = await fixture();
    const directory = process.env.TRACEFOLD_EXPORT_FIXTURES;
    if (directory) await mkdir(directory, { recursive: true });
    for (const format of ['pdf', 'docx', 'html', 'markdown', 'csv', 'json'] as const) {
      const report = await exportReport({ ...base, options: { ...base.options, format } });
      expect(report.bytes.length).toBeGreaterThan(100);
      if (directory) await writeFile(resolve(directory, report.filename), report.bytes);
      let text = new TextDecoder().decode(report.bytes);
      if (format === 'docx') {
        const archive = unzipSync(report.bytes);
        expect(Object.keys(archive).filter((path) => path.endsWith('.odttf'))).toHaveLength(5);
        text = Object.entries(archive)
          .filter(([name]) => name.endsWith('.xml'))
          .map(([, bytes]) => new TextDecoder().decode(bytes))
          .join('\n');
        expect(text).toContain('Lexend');
        expect(text).toContain('Newsreader');
      } else if (format === 'markdown')
        text = new TextDecoder().decode(unzipSync(report.bytes)['report.md']);
      if (format === 'pdf') expect(text.startsWith('%PDF-')).toBe(true);
      else expect(text.replaceAll('\\', '')).toContain('PUBLIC_EXPORT_SENTINEL');
      expect(text).not.toContain('PRIVATE_EXPORT_SENTINEL');
    }
    const letter = await exportReport({
      ...base,
      options: { ...base.options, pageSize: 'LETTER' },
    });
    if (directory) await writeFile(resolve(directory, 'Payment recovery Letter.pdf'), letter.bytes);
  }, 30000);
});
