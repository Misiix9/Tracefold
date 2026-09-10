import type { AnyEntity, RichNode } from '../../domain/types';
import type { ReportAsset, ReportSnapshot } from './types';
import { translate, codeLabel, date, number } from '../../i18n/i18n.svelte';
import { isPresetPrimary } from './presets';

export interface ReportSection {
  id: string;
  kind: AnyEntity['kind'];
  title: string;
  blocks: RichNode[];
  evidence: { asset: ReportAsset; caption: string }[];
}
export interface ReportModel {
  title: string;
  subtitle: string;
  sections: ReportSection[];
  summary: RichNode[];
}
const p = (text: string): RichNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (text: string): RichNode => ({
  type: 'heading',
  attrs: { level: 3 },
  content: [{ type: 'text', text }],
});
const table = (headers: string[], rows: string[][]): RichNode => ({
  type: 'table',
  content: [headers, ...rows].map((row, i) => ({
    type: 'tableRow',
    content: row.map((text) => ({ type: i ? 'tableCell' : 'tableHeader', content: [p(text)] })),
  })),
});
const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (s) => s.toUpperCase());

/** Same ordered, structured content drives all visual report renderers. No HTML is accepted as rich text. */
export function buildReportModel(snapshot: ReportSnapshot): ReportModel {
  const language = snapshot.options.language ?? 'en';
  const t = (key: string, values?: Record<string, string | number>) =>
    translate(key, language, values);
  const code = (value: string) => codeLabel(value, language);
  const localDate = (value: string) =>
    date(value, { dateStyle: 'medium', timeStyle: 'short' }, language);
  const labeledTable = (headers: string[], rows: string[][]) =>
    table(
      headers.map((key) => t(key)),
      rows,
    );
  const preset = snapshot.options.preset ?? 'release';
  const order = [
    'document',
    'session',
    'entry',
    'finding',
    'requirement',
    'case',
    'run',
    'evidence',
    'template',
  ];
  const ordered = [...snapshot.records].sort((a, b) => {
    const primary =
      Number(isPresetPrimary(b.kind, preset)) - Number(isPresetPrimary(a.kind, preset));
    if (primary) return primary;
    if (a.kind !== b.kind) return order.indexOf(a.kind) - order.indexOf(b.kind);
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
  const recordTitles = new Map(snapshot.records.map((record) => [record.id, record.title]));
  const sections = ordered.map((r) => {
    const blocks: RichNode[] = [...(r.body.content ?? [])];
    const field = (name: string, value: unknown) => {
      if (value !== '' && value !== undefined)
        blocks.push(
          h(t(name)),
          p(typeof value === 'boolean' ? t(value ? 'Yes' : 'No') : String(value)),
        );
    };
    const fields = (data: object, keys: string[]) =>
      keys.forEach((key) => {
        let value = (data as Record<string, unknown>)[key];
        if (typeof value === 'string' && value) {
          if (
            ['status', 'state', 'severity', 'priority', 'type', 'targetKind', 'outcome'].includes(
              key,
            )
          )
            value = code(value);
          else if (['startedAt', 'endedAt', 'completedAt'].includes(key)) value = localDate(value);
        }
        field(label(key), value);
      });
    const env = (data: object) => {
      const rows = Object.entries(data)
        .filter(([k, v]) => k !== 'extra' && v)
        .map(([k, v]) => [t(label(k)), String(v)]);
      if (rows.length) blocks.push(h(t('Environment')), labeledTable(['Field', 'Value'], rows));
    };
    switch (r.kind) {
      case 'document':
        field('Category', r.data.category);
        if (r.data.templateFields?.length) {
          const rows = r.data.templateFields.map((definition) => {
            const value = r.data.fields?.[definition.id];
            return [
              definition.label,
              value === undefined || value === null
                ? t('Not recorded')
                : typeof value === 'boolean'
                  ? t(value ? 'Yes' : 'No')
                  : Array.isArray(value)
                    ? value.join(', ')
                    : String(value),
            ];
          });
          blocks.unshift(h(t('Custom fields')), labeledTable(['Field', 'Value'], rows));
        }
        break;
      case 'entry':
        field('Recorded at', localDate(r.createdAt));
        fields(r.data, ['category', 'expected', 'actual']);
        break;
      case 'session':
        fields(r.data, [
          'charter',
          'state',
          'startedAt',
          'endedAt',
          'durationSeconds',
          'conclusion',
          'exclusions',
        ]);
        env(r.data.environment);
        if (r.data.focusAreas.length)
          blocks.push(
            h(t('Focus areas')),
            labeledTable(
              ['Area', 'Covered'],
              r.data.focusAreas.map((a) => [a.text, t(a.checked ? 'Yes' : 'No')]),
            ),
          );
        break;
      case 'finding':
        field(
          'Linked cases',
          r.data.caseIds
            .map((id) => recordTitles.get(id))
            .filter(Boolean)
            .join(', '),
        );
        field(
          'Related findings',
          r.data.relatedIds
            .map((id) => recordTitles.get(id))
            .filter(Boolean)
            .join(', '),
        );
        field(
          'Duplicate of',
          r.data.duplicateOf ? recordTitles.get(r.data.duplicateOf) : undefined,
        );
        field(
          'Source observation',
          r.data.sourceEntryId ? recordTitles.get(r.data.sourceEntryId) : undefined,
        );
        fields(r.data, [
          'code',
          'status',
          'severity',
          'priority',
          'type',
          'owner',
          'component',
          'frequency',
        ]);
        if (r.data.status === 'resolved')
          blocks.push(
            p(
              t(
                [...r.data.retests].sort((a, b) => b.at.localeCompare(a.at))[0]?.outcome ===
                  'passed'
                  ? 'Resolution verified by the latest recorded retest.'
                  : 'Resolution unverified by a passing retest.',
              ),
            ),
          );
        if (r.data.steps.length)
          blocks.push(h(t('Steps')), {
            type: 'orderedList',
            attrs: { start: 1 },
            content: r.data.steps.map((s) => ({ type: 'listItem', content: [p(s)] })),
          });
        fields(r.data, [
          'expected',
          'actual',
          'impact',
          'suspectedCause',
          'confirmedCause',
          'workaround',
          'resolution',
        ]);
        env(r.data.environment);
        for (const retest of r.data.retests) {
          blocks.push(
            h(t('Retest · {date}', { date: localDate(retest.at) })),
            p(t('Outcome: {outcome}', { outcome: code(retest.outcome) })),
          );
          field('Notes', retest.notes);
          env(retest.environment);
        }
        break;
      case 'case':
        fields(r.data, ['prerequisites', 'folder', 'priority', 'automated']);
        if (r.data.steps.length)
          blocks.push(
            h(t('Test steps')),
            labeledTable(
              ['Action', 'Expected'],
              r.data.steps.map((s) => [s.action, s.expected]),
            ),
          );
        for (const d of r.data.datasets) {
          blocks.push(h(t('Dataset: {name}', { name: d.name })));
          if (Object.keys(d.values).length)
            blocks.push(labeledTable(['Field', 'Value'], Object.entries(d.values)));
        }
        break;
      case 'run':
        fields(r.data, ['state', 'startedAt', 'completedAt', 'conclusion', 'exclusions']);
        env(r.data.environment);
        for (const e of r.data.executions) {
          blocks.push(h(e.caseTitle), p(t('Outcome: {outcome}', { outcome: code(e.outcome) })));
          fields(e, ['reason', 'notes', 'prerequisites', 'durationMs']);
          if (e.steps.length)
            blocks.push(
              labeledTable(
                ['Action', 'Expected', 'Outcome', 'Reason'],
                e.steps.map((s) => [
                  s.action,
                  s.expected,
                  code(e.stepResults[s.id] ?? 'not_run'),
                  e.stepReasons?.[s.id] ?? '',
                ]),
              ),
            );
          if (e.dataset) {
            blocks.push(h(t('Dataset: {name}', { name: e.dataset.name })));
            if (Object.keys(e.dataset.values).length)
              blocks.push(labeledTable(['Field', 'Value'], Object.entries(e.dataset.values)));
          }
        }
        break;
      case 'requirement':
        fields(r.data, ['code', 'description', 'acceptanceCriteria', 'priority', 'owner']);
        break;
      case 'evidence':
        field('Caption', r.data.caption);
        break;
      case 'template':
        fields(r.data, ['description', 'targetKind']);
        for (const s of r.data.sections) blocks.push(h(s.title), p(s.guidance));
        if (r.data.fields.length)
          blocks.push(
            labeledTable(
              ['Field', 'Type', 'Required', 'Options'],
              r.data.fields.map((f) => [
                f.label,
                code(f.type),
                t(f.required ? 'Yes' : 'No'),
                (f.options ?? []).join(', '),
              ]),
            ),
          );
        break;
    }
    if (r.tags.length) field('Tags', r.tags.join(', '));
    const evidence =
      r.kind === 'evidence'
        ? [{ asset: snapshot.assets[r.data.assetId], caption: r.data.caption || r.title }]
        : [];
    return { id: r.id, kind: r.kind, title: r.title, blocks, evidence };
  });
  const executions = snapshot.records.flatMap((r) => (r.kind === 'run' ? r.data.executions : []));
  const summary: RichNode[] = [];
  if (preset === 'finding' || preset === 'release') {
    const findings = snapshot.records.filter((r) => r.kind === 'finding');
    if (findings.length)
      summary.push(
        h(t('Finding overview')),
        labeledTable(
          ['Status', 'Count'],
          ['open', 'in_progress', 'ready_for_retest', 'resolved', 'deferred'].map((status) => [
            code(status),
            `${findings.filter((f) => f.data.status === status).length}/${findings.length}`,
          ]),
        ),
      );
  }
  if (preset === 'walkthrough') {
    summary.push(
      p(
        t('Walkthrough documents: {count}', {
          count: snapshot.records.filter((r) => r.kind === 'document').length,
        }),
      ),
    );
  }
  if (preset === 'session') {
    const sessions = snapshot.records.filter((r) => r.kind === 'session');
    summary.push(
      h(t('Session overview')),
      labeledTable(
        ['Session', 'State', 'Duration (minutes)'],
        sessions.map((session) => [
          session.title,
          code(session.data.state),
          number(session.data.durationSeconds / 60, { maximumFractionDigits: 1 }, language),
        ]),
      ),
    );
  }
  if (executions.length) {
    const passed = executions.filter((e) => e.outcome === 'passed').length,
      failed = executions.filter((e) => e.outcome === 'failed').length;
    summary.push(
      p(
        ['passed', 'failed', 'blocked', 'skipped', 'not_run']
          .map(
            (outcome) =>
              `${code(outcome)}: ${executions.filter((e) => e.outcome === outcome).length}/${executions.length}.`,
          )
          .join(' ') +
          ` ${t('Pass rate over pass/fail')}: ${passed + failed ? `${number(passed / (passed + failed), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }, language)} (${passed}/${passed + failed})` : t('N/A (0 pass/fail results)')}.`,
      ),
    );
  }
  if (preset === 'coverage' || preset === 'release') {
    const requirements = snapshot.records.filter((r) => r.kind === 'requirement');
    const cases = snapshot.records.filter((r) => r.kind === 'case');
    if (requirements.length)
      summary.push(
        labeledTable(
          ['Requirement', 'Linked cases', 'Gap'],
          requirements.map((r) => {
            const links = cases.filter((c) => c.data.requirementIds.includes(r.id));
            return [
              r.title,
              String(links.length),
              links.length ? '' : t('No linked case in this report'),
            ];
          }),
        ),
      );
  }
  return {
    title: snapshot.options.title || snapshot.project.name,
    subtitle: [
      snapshot.project.name,
      snapshot.options.author,
      snapshot.options.audience,
      snapshot.options.build && `${t('Build')} ${snapshot.options.build}`,
      localDate(snapshot.generatedAt),
    ]
      .filter(Boolean)
      .join(' · '),
    summary,
    sections,
  };
}
export function richText(node: RichNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? [])
    .map(richText)
    .join(
      ['paragraph', 'heading', 'codeBlock'].includes(node.type)
        ? ''
        : node.type === 'tableRow'
          ? '\t'
          : '\n',
    );
}

/** Font scanning excludes binary evidence and includes log text without serializing byte arrays. */
export function reportText(model: ReportModel): string {
  return [
    model.title,
    model.subtitle,
    ...model.summary.map(richText),
    ...model.sections.flatMap((section) => [
      section.title,
      ...section.blocks.map(richText),
      ...section.evidence.flatMap(({ asset, caption }) => [
        caption,
        asset.mimeType === 'text/plain' ? new TextDecoder().decode(asset.bytes) : '',
      ]),
    ]),
  ].join('\n');
}
