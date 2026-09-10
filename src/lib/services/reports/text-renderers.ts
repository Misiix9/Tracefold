import type { RichNode } from '../../domain/types';
import { base64, utf8 } from './binary';
import { buildReportModel, richText } from './model';
import type { ReportModel } from './model';
import type { ReportSnapshot } from './types';

export const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const escapeMarkdown = (text: string): string =>
  escapeHtml(text).replace(/([\\`*_[\]{}()#+.!|~>-])/g, '\\$1');
export function richHtml(n: RichNode): string {
  const content = (n.content ?? []).map(richHtml).join('');
  if (n.type === 'text')
    return (n.marks ?? []).reduce(
      (text, m) => {
        const tag = (
          { bold: 'strong', italic: 'em', strike: 's', code: 'code', underline: 'u' } as Record<
            string,
            string
          >
        )[m.type];
        return tag ? `<${tag}>${text}</${tag}>` : text;
      },
      escapeHtml(n.text ?? ''),
    );
  if (n.type === 'hardBreak') return '<br>';
  if (n.type === 'horizontalRule') return '<hr>';
  if (n.type === 'heading') return `<h${n.attrs?.level}>${content}</h${n.attrs?.level}>`;
  if (n.type === 'codeBlock') return `<pre><code>${content}</code></pre>`;
  if (n.type === 'taskItem') return `<li>${n.attrs?.checked ? '[x]' : '[ ]'} ${content}</li>`;
  if (n.type === 'orderedList') return `<ol start="${n.attrs?.start ?? 1}">${content}</ol>`;
  const tag = (
    {
      paragraph: 'p',
      bulletList: 'ul',
      taskList: 'ul',
      listItem: 'li',
      blockquote: 'blockquote',
      table: 'table',
      tableRow: 'tr',
      tableCell: 'td',
      tableHeader: 'th',
    } as Record<string, string>
  )[n.type];
  return tag ? `<${tag}>${content}</${tag}>` : content;
}
export function richMarkdown(n: RichNode): string {
  const children = n.content ?? [],
    content = children.map(richMarkdown).join('');
  if (n.type === 'text')
    return (n.marks ?? []).reduce(
      (s, m) =>
        m.type === 'bold'
          ? `**${s}**`
          : m.type === 'italic'
            ? `*${s}*`
            : m.type === 'strike'
              ? `~~${s}~~`
              : s,
      escapeMarkdown(n.text ?? ''),
    );
  if (n.type === 'hardBreak') return '  \n';
  if (n.type === 'horizontalRule') return '\n---\n\n';
  if (n.type === 'heading') return `${'#'.repeat(Number(n.attrs?.level) || 2)} ${content}\n\n`;
  if (n.type === 'codeBlock') {
    const code = richText(n),
      fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((s) => s.length + 1)));
    return `${fence}\n${code}\n${fence}\n\n`;
  }
  if (n.type === 'paragraph') return `${content}\n\n`;
  if (['bulletList', 'orderedList', 'taskList'].includes(n.type))
    return (
      children
        .map((c, i) => {
          const marker =
            n.type === 'orderedList'
              ? `${Number(n.attrs?.start ?? 1) + i}. `
              : n.type === 'taskList'
                ? `- [${c.attrs?.checked ? 'x' : ' '}] `
                : '- ';
          return (
            marker +
            richMarkdown(c)
              .trimEnd()
              .replaceAll('\n', `\n${' '.repeat(marker.length)}`) +
            '\n'
          );
        })
        .join('') + '\n'
    );
  if (n.type === 'blockquote')
    return (
      content
        .trimEnd()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n') + '\n\n'
    );
  if (n.type === 'table') {
    const rows = children.map(
      (r) =>
        `| ${(r.content ?? []).map((c) => richMarkdown(c).trim().replaceAll('\n', '<br>')).join(' | ')} |`,
    );
    rows.splice(1, 0, `| ${(children[0]?.content ?? []).map(() => '---').join(' | ')} |`);
    return rows.join('\n') + '\n\n';
  }
  return content;
}
export function htmlBytes(
  snapshot: ReportSnapshot,
  model: ReportModel = buildReportModel(snapshot),
): Uint8Array {
  const body = model.sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2>${s.blocks.map(richHtml).join('')}${s.evidence
          .map((e) =>
            e.asset.mimeType === 'image/png'
              ? `<figure><img src="data:image/png;base64,${base64(e.asset.bytes)}" alt="${escapeHtml(e.caption)}"><figcaption>${escapeHtml(e.caption)}</figcaption></figure>`
              : `<pre>${escapeHtml(new TextDecoder().decode(e.asset.bytes))}</pre>`,
          )
          .join('')}</section>`,
    )
    .join('');
  return utf8(
    `<!doctype html><html lang="${snapshot.options.language ?? 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(model.title)}</title><style>body{max-width:54rem;margin:3rem auto;padding:0 1.5rem;color:#182e2c;font:16px/1.6 Georgia,serif}h1,h2,h3{font-family:Arial,sans-serif;line-height:1.25}section{margin-top:2.5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f3;padding:1rem;font:13px/1.5 monospace}p,td,th{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #bccac4;padding:.5rem;vertical-align:top;text-align:left}img{max-width:100%;height:auto}figure{margin:1rem 0}figcaption{font-size:.875rem}@page{size:${snapshot.options.pageSize === 'LETTER' ? 'letter' : 'A4'};margin:18mm}@media print{body{margin:0;max-width:none}h2,h3{break-after:avoid}thead{display:table-header-group}}</style></head><body><h1>${escapeHtml(model.title)}</h1><p>${escapeHtml(model.subtitle)}</p>${model.summary.map(richHtml).join('')}${body}</body></html>`,
  );
}
export function markdownBytes(
  snapshot: ReportSnapshot,
  model: ReportModel = buildReportModel(snapshot),
): Uint8Array {
  return utf8(
    `# ${escapeMarkdown(model.title)}\n\n${escapeMarkdown(model.subtitle)}\n\n${model.summary.map(richMarkdown).join('')}${model.sections.map((s) => `## ${escapeMarkdown(s.title)}\n\n${s.blocks.map(richMarkdown).join('')}${s.evidence.map((e) => `${e.asset.mimeType === 'image/png' ? '!' : ''}[${escapeMarkdown(e.caption)}](${e.asset.filename})\n\n`).join('')}`).join('')}`,
  );
}
/** Prefix BEFORE RFC4180 quoting; leading whitespace/control/full-width operators cannot bypass protection. */
export function csvCell(value: string): string {
  const dangerous =
    /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+\-@＝＋－＠]/u.test(
      value,
    ) || /^[\t\r\n]/.test(value);
  return `"${(dangerous ? "'" + value : value).replaceAll('"', '""')}"`;
}
export function csvBytes(snapshot: ReportSnapshot): Uint8Array {
  const rows = [
    ['kind', 'title', 'body_markdown', 'details_json', 'tags'],
    ...snapshot.records.map((r) => [
      r.kind,
      r.title,
      richMarkdown(r.body),
      JSON.stringify(r.data),
      r.tags.join(', '),
    ]),
  ];
  return utf8('\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
}
