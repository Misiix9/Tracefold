import { fontRuns, fallbackFamilies, withPdfFonts } from './fonts';
import type { RichNode } from '../../domain/types';
import type { ReportOutput, ReportSnapshot } from './types';
import { buildReportModel, richText, reportText } from './model';
import { base64, utf8 } from './binary';
import { csvBytes, htmlBytes, markdownBytes } from './text-renderers';
import { zipSync } from 'fflate';
const safeName = (title: string) =>
  title
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .slice(0, 100) || 'Tracefold report';
const fontCache = new Map<string, Promise<Uint8Array>>();
async function font(name: string) {
  if (!fontCache.has(name))
    fontCache.set(
      name,
      fetch(`/fonts/${name}`).then(async (r) => {
        if (!r.ok) throw new Error('A bundled report font is missing. Reinstall Tracefold.');
        return new Uint8Array(await r.arrayBuffer());
      }),
    );
  return fontCache.get(name)!;
}
export function portableJson(snapshot: ReportSnapshot) {
  return {
    ...snapshot,
    assets: Object.fromEntries(
      Object.entries(snapshot.assets).map(([hash, a]) => [hash, { ...a, bytes: base64(a.bytes) }]),
    ),
  };
}
export function packageBytes(snapshot: ReportSnapshot) {
  const files: Record<string, Uint8Array> = {
    'manifest.json': utf8(
      JSON.stringify({
        ...snapshot,
        kind: 'tracefold-package',
        assets: Object.fromEntries(
          Object.entries(snapshot.assets).map(([hash, { bytes, ...a }]) => [hash, a]),
        ),
      }),
    ),
  };
  for (const a of Object.values(snapshot.assets)) files[a.filename] = a.bytes;
  return zipSync(files, { level: 6 });
}

async function pdfBytes(snapshot: ReportSnapshot): Promise<Uint8Array> {
  const module = await import('pdfmake/build/pdfmake');
  const pdf = module.default as unknown as {
    addVirtualFileSystem: (fonts: Record<string, string>) => void;
    addFonts: (fonts: Record<string, Record<string, string>>) => void;
    createPdf: (definition: unknown) => { getBuffer: () => Promise<Uint8Array> };
  };
  const [lexend, lexendBold, newsreader, mono, monoBold, monoItalic, monoBoldItalic] =
    await Promise.all([
      font('Lexend-Report-400.ttf'),
      font('Lexend-Report-600.ttf'),
      font('Newsreader-Report-400.ttf'),
      font('iAWriterMonoS-Regular.ttf'),
      font('iAWriterMonoS-Bold.ttf'),
      font('iAWriterMonoS-Italic.ttf'),
      font('iAWriterMonoS-BoldItalic.ttf'),
    ]);
  const files: Record<string, string> = {
    'Lexend.ttf': base64(lexend),
    'LexendBold.ttf': base64(lexendBold),
    'Newsreader.ttf': base64(newsreader),
    'Mono.ttf': base64(mono),
    'MonoBold.ttf': base64(monoBold),
    'MonoItalic.ttf': base64(monoItalic),
    'MonoBoldItalic.ttf': base64(monoBoldItalic),
  };
  const families: Record<string, Record<string, string>> = {
    Lexend: {
      normal: 'Lexend.ttf',
      bold: 'LexendBold.ttf',
      italics: 'Lexend.ttf',
      bolditalics: 'LexendBold.ttf',
    },
    Newsreader: {
      normal: 'Newsreader.ttf',
      bold: 'Newsreader.ttf',
      italics: 'Newsreader.ttf',
      bolditalics: 'Newsreader.ttf',
    },
    Mono: {
      normal: 'Mono.ttf',
      bold: 'MonoBold.ttf',
      italics: 'MonoItalic.ttf',
      bolditalics: 'MonoBoldItalic.ttf',
    },
  };
  for (const family of fallbackFamilies(reportText(buildReportModel(snapshot)))) {
    const filename =
      family === 'Fallback' ? 'NotoSans-Report-400.ttf' : 'NotoSansCJKjp-Regular.otf';
    files[filename] = base64(await font(filename));
    families[family] = {
      normal: filename,
      bold: filename,
      italics: filename,
      bolditalics: filename,
    };
  }
  pdf.addVirtualFileSystem(files);
  pdf.addFonts(families);
  type Content = Record<string, unknown>;
  const inline = (n: RichNode): Content => ({
    text: n.text ?? (n.content ?? []).map(richText).join(''),
    ...(n.marks?.some((m) => m.type === 'bold') ? { bold: true } : {}),
    ...(n.marks?.some((m) => m.type === 'italic') ? { italics: true } : {}),
    ...(n.marks?.some((m) => m.type === 'code') ? { font: 'Mono', fontSize: 9 } : {}),
  });
  const node = (n: RichNode): Content => {
    const children = n.content ?? [];
    if (n.type === 'table')
      return {
        table: {
          headerRows: children[0]?.content?.every((c) => c.type === 'tableHeader') ? 1 : 0,
          widths: (children[0]?.content ?? []).map((_, i) =>
            children.every((row) => richText(row.content?.[i] ?? { type: 'text' }).length <= 12)
              ? 'auto'
              : '*',
          ),
          body: children.map((r) =>
            (r.content ?? []).map((c) => ({
              stack: (c.content ?? []).map(node),
              margin: [4, 4, 4, 4],
            })),
          ),
        },
        layout: 'lightHorizontalLines',
        margin: [0, 6, 0, 12],
      };
    if (n.type === 'bulletList' || n.type === 'taskList')
      return {
        ul: children.map((c) => ({
          stack: [
            ...(n.type === 'taskList' ? [{ text: c.attrs?.checked ? '[x]' : '[ ]' }] : []),
            ...(c.content ?? []).map(node),
          ],
        })),
        margin: [0, 0, 0, 10],
      };
    if (n.type === 'orderedList')
      return {
        ol: children.map((c) => ({ stack: (c.content ?? []).map(node) })),
        start: n.attrs?.start ?? 1,
        margin: [0, 0, 0, 10],
      };
    if (n.type === 'heading')
      return {
        text: children.map(inline),
        style: Number(n.attrs?.level) <= 2 ? 'heading' : 'subheading',
        keepWithNext: true,
      };
    if (n.type === 'codeBlock')
      return {
        text: richText(n),
        font: 'Mono',
        fontSize: 8.5,
        margin: [8, 6, 8, 12],
        preserveLeadingSpaces: true,
      };
    if (n.type === 'blockquote')
      return { stack: children.map(node), color: '#68635B', margin: [14, 4, 0, 12] };
    if (n.type === 'horizontalRule')
      return {
        canvas: [
          { type: 'line', x1: 0, y1: 0, x2: 450, y2: 0, lineWidth: 0.5, lineColor: '#D8D1C6' },
        ],
        margin: [0, 10, 0, 10],
      };
    if (n.type === 'hardBreak') return { text: '\n' };
    return {
      text:
        n.type === 'text'
          ? inline(n)
          : children.map((c) => (c.type === 'hardBreak' ? { text: '\n' } : inline(c))),
      margin: [0, 0, 0, 8],
    };
  };
  const model = buildReportModel(snapshot);
  const content: Content[] = [
    { text: model.title, style: 'title' },
    { text: model.subtitle, color: '#68635B', fontSize: 9, margin: [0, 0, 0, 22] },
    ...model.summary.map(node),
  ];
  for (const section of model.sections) {
    content.push(
      { text: section.title, style: 'heading', keepWithNext: true },
      ...section.blocks.map(node),
    );
    for (const { asset, caption } of section.evidence) {
      if (asset.mimeType === 'image/png')
        content.push(
          {
            image: `data:image/png;base64,${base64(asset.bytes)}`,
            fit: [470, 520],
            margin: [0, 10, 0, 6],
          },
          { text: caption, fontSize: 9, color: '#68635B', margin: [0, 0, 0, 14] },
        );
      else
        content.push({
          text: new TextDecoder().decode(asset.bytes),
          font: 'Mono',
          fontSize: 8,
          margin: [0, 6, 0, 14],
        });
    }
  }
  const result = await pdf
    .createPdf({
      pageSize: snapshot.options.pageSize,
      pageMargins: [48, 48, 48, 48],
      info: { title: model.title, author: snapshot.options.author, creator: 'Tracefold' },
      defaultStyle: { font: 'Lexend', fontSize: 10, lineHeight: 1.3, color: '#262522' },
      styles: {
        title: { font: 'Newsreader', fontSize: 28, margin: [0, 0, 0, 12] },
        heading: { font: 'Newsreader', fontSize: 21, margin: [0, 20, 0, 10] },
        subheading: { fontSize: 12, bold: true, margin: [0, 12, 0, 8] },
      },
      footer: (current: number, total: number) => ({
        text: `${current} / ${total}`,
        alignment: 'right',
        fontSize: 8,
        color: '#68635B',
        margin: [0, 0, 48, 0],
      }),
      content: withPdfFonts(content),
    })
    .getBuffer();
  return new Uint8Array(result);
}
async function docxBytes(snapshot: ReportSnapshot): Promise<Uint8Array> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    ImageRun,
    HeadingLevel,
    WidthType,
    PageNumber,
    Footer,
  } = await import('docx');
  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const names = {
    Lexend: 'Lexend',
    Newsreader: 'Newsreader',
    Mono: 'iA Writer Mono',
    Fallback: 'Noto Sans',
    CJK: 'Noto Sans CJK JP',
  };
  const runs = (
    n: RichNode,
    preferred: 'Lexend' | 'Newsreader' | 'Mono' = 'Lexend',
  ): InstanceType<typeof TextRun>[] =>
    n.type === 'text'
      ? fontRuns(
          n.text ?? '',
          n.marks?.some((m) => m.type === 'code') ? 'Mono' : preferred,
          false,
        ).map(
          (run) =>
            new TextRun({
              text: run.text,
              bold: n.marks?.some((m) => m.type === 'bold'),
              italics: n.marks?.some((m) => m.type === 'italic'),
              strike: n.marks?.some((m) => m.type === 'strike'),
              font: names[run.font],
            }),
        )
      : n.type === 'hardBreak'
        ? [new TextRun({ break: 1 })]
        : (n.content ?? []).flatMap((child) => runs(child, preferred));
  const node = (n: RichNode, depth = 0): Block[] => {
    if (n.type === 'table')
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: (n.content ?? []).map(
            (r) =>
              new TableRow({
                tableHeader: r.content?.every((c) => c.type === 'tableHeader'),
                children: (r.content ?? []).map(
                  (c) =>
                    new TableCell({ children: (c.content ?? []).flatMap((child) => node(child)) }),
                ),
              }),
          ),
        }),
      ];
    if (['bulletList', 'orderedList', 'taskList'].includes(n.type))
      return (n.content ?? []).flatMap((c, i) => [
        new Paragraph({
          children: [
            new TextRun({
              text:
                n.type === 'orderedList'
                  ? `${i + Number(n.attrs?.start ?? 1)}. `
                  : n.type === 'taskList'
                    ? c.attrs?.checked
                      ? '☑ '
                      : '☐ '
                    : '• ',
            }),
            ...runs(c),
          ],
          indent: { left: 240 + depth * 240 },
          spacing: { after: 100 },
        }),
      ]);
    if (['doc', 'blockquote', 'listItem', 'taskItem'].includes(n.type))
      return (n.content ?? []).flatMap((c) => node(c, depth + 1));
    const heading =
      n.type === 'heading'
        ? Number(n.attrs?.level) <= 2
          ? HeadingLevel.HEADING_2
          : HeadingLevel.HEADING_3
        : undefined;
    return [
      new Paragraph({
        children: runs(n, n.type === 'codeBlock' ? 'Mono' : 'Lexend'),
        heading,
        style: n.type === 'codeBlock' ? 'Code' : undefined,
        spacing: { after: 140 },
        keepNext: !!heading,
      }),
    ];
  };
  const model = buildReportModel(snapshot);
  const children: Block[] = [
    new Paragraph({
      children: runs({ type: 'text', text: model.title }, 'Newsreader'),
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({ children: runs({ type: 'text', text: model.subtitle }), style: 'Subtitle' }),
    ...model.summary.flatMap((n) => node(n)),
  ];
  for (const section of model.sections) {
    children.push(
      new Paragraph({
        children: runs({ type: 'text', text: section.title }, 'Newsreader'),
        heading: HeadingLevel.HEADING_1,
      }),
      ...section.blocks.flatMap((n) => node(n)),
    );
    for (const { asset, caption } of section.evidence) {
      if (asset.mimeType === 'image/png') {
        const ratio = Math.min(1, 600 / (asset.width ?? 600), 650 / (asset.height ?? 650));
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: 'png',
                data: asset.bytes,
                transformation: {
                  width: Math.round((asset.width ?? 600) * ratio),
                  height: Math.round((asset.height ?? 400) * ratio),
                },
                altText: { title: caption, description: caption, name: 'Evidence' },
              }),
            ],
          }),
          new Paragraph({ children: runs({ type: 'text', text: caption }), style: 'Caption' }),
        );
      } else
        children.push(
          new Paragraph({
            children: [
              ...runs({ type: 'text', text: new TextDecoder().decode(asset.bytes) }, 'Mono'),
            ],
          }),
        );
    }
  }
  const letter = snapshot.options.pageSize === 'LETTER';
  const embedded = await Promise.all([
    font('Lexend-Report-400.ttf'),
    font('Newsreader-Report-400.ttf'),
    font('iAWriterMonoS-Regular.ttf'),
  ]);
  const embeddedNames = ['Lexend', 'Newsreader', 'iA Writer Mono'];
  for (const family of fallbackFamilies(reportText(model))) {
    embedded.push(
      await font(family === 'Fallback' ? 'NotoSans-Report-400.ttf' : 'NotoSansCJKjp-Regular.otf'),
    );
    embeddedNames.push(names[family]);
  }
  const doc = new Document({
    fonts: embedded.map((data, i) => ({ name: embeddedNames[i], data: data as unknown as Buffer })),
    creator: snapshot.options.author,
    title: model.title,
    description: 'Prepared locally with Tracefold',
    styles: {
      default: {
        document: {
          run: { font: 'Lexend', size: 21, color: '262522' },
          paragraph: { spacing: { after: 140, line: 300 } },
        },
        title: { run: { font: 'Newsreader', size: 56 } },
        heading1: {
          run: { font: 'Newsreader', size: 42 },
          paragraph: { spacing: { before: 300, after: 160 } },
        },
        heading2: {
          run: { font: 'Lexend', size: 28 },
          paragraph: { spacing: { before: 220, after: 140 } },
        },
      },
      paragraphStyles: [
        { id: 'Code', name: 'Code', basedOn: 'Normal', run: { font: 'iA Writer Mono', size: 18 } },
        {
          id: 'Caption',
          name: 'Caption',
          basedOn: 'Normal',
          run: { font: 'Lexend', size: 18, color: '68635B' },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: letter ? 12240 : 11906, height: letter ? 15840 : 16838 },
            margin: { top: 960, right: 960, bottom: 960, left: 960 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: 'right',
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES],
                    size: 16,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
export async function exportReport(
  snapshot: ReportSnapshot,
  portable = false,
): Promise<ReportOutput> {
  const name = safeName(snapshot.options.title),
    format = snapshot.options.format;
  let bytes: Uint8Array, mimeType: string, extension: string;
  if (portable) {
    bytes = packageBytes(snapshot);
    mimeType = 'application/zip';
    extension = 'tracefold';
  } else if (format === 'pdf') {
    bytes = await pdfBytes(snapshot);
    mimeType = 'application/pdf';
    extension = 'pdf';
  } else if (format === 'docx') {
    bytes = await docxBytes(snapshot);
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    extension = 'docx';
  } else if (format === 'html') {
    let html = new TextDecoder().decode(htmlBytes(snapshot));
    const fonts = await Promise.all([font('lexend.ttf'), font('newsreader.ttf')]);
    html = html
      .replace(
        '<style>',
        `<style>@font-face{font-family:Lexend;src:url(data:font/ttf;base64,${base64(fonts[0])})}@font-face{font-family:Newsreader;src:url(data:font/ttf;base64,${base64(fonts[1])})}`,
      )
      .replace('img-src data:;', 'img-src data:; font-src data:;')
      .replace(
        'color:#182e2c;font:16px/1.6 Georgia,serif',
        'color:#262522;font:15px/1.7 Lexend,sans-serif',
      )
      .replace('font-family:Arial,sans-serif', 'font-family:Newsreader,serif');
    bytes = utf8(html);
    mimeType = 'text/html';
    extension = 'html';
  } else if (format === 'markdown') {
    const files: Record<string, Uint8Array> = { 'report.md': markdownBytes(snapshot) };
    for (const a of Object.values(snapshot.assets)) files[a.filename] = a.bytes;
    bytes = zipSync(files, { level: 6 });
    mimeType = 'application/zip';
    extension = 'markdown.zip';
  } else if (format === 'csv') {
    bytes = csvBytes(snapshot);
    mimeType = 'text/csv';
    extension = 'csv';
  } else {
    bytes = utf8(JSON.stringify(portableJson(snapshot), null, 2));
    mimeType = 'application/json';
    extension = 'json';
  }
  return { bytes, mimeType, filename: `${name}.${extension}`, attachments: [], warnings: [] };
}
