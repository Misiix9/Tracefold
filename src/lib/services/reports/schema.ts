import type { AnyEntity, EntityKind, RichNode } from '../../domain/types';
import { REPORT_LIMITS, requireThat } from './types';

type Parser = (value: unknown, strict: boolean) => unknown;
const str: Parser = (v) => {
  requireThat(
    typeof v === 'string' &&
      v.length <= REPORT_LIMITS.textLength &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v),
    'Invalid text',
  );
  return v;
};
const num: Parser = (v) => {
  requireThat(typeof v === 'number' && Number.isFinite(v) && v >= 0, 'Invalid number');
  return v;
};
const integer: Parser = (v) => {
  requireThat(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0, 'Invalid integer');
  return v;
};
const bool: Parser = (v) => {
  requireThat(typeof v === 'boolean', 'Invalid boolean');
  return v;
};
const literal =
  (expected: unknown): Parser =>
  (v) => {
    requireThat(v === expected, 'Invalid constant');
    return v;
  };
const choice =
  (...values: string[]): Parser =>
  (v) => {
    requireThat(typeof v === 'string' && values.includes(v), 'Invalid enum');
    return v;
  };
const optional =
  (parse: Parser): Parser =>
  (v, s) =>
    v === undefined ? undefined : parse(v, s);
const arr =
  (parse: Parser, max = 10_000): Parser =>
  (v, s) => {
    requireThat(Array.isArray(v) && v.length <= max, 'Invalid array');
    return v.map((x) => parse(x, s));
  };
export function object(value: unknown): Record<string, unknown> {
  requireThat(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    'Expected plain object',
  );
  return value as Record<string, unknown>;
}
const obj =
  (fields: Record<string, Parser>): Parser =>
  (v, s) => {
    const source = object(v);
    if (s)
      requireThat(
        Object.keys(source).every((k) => Object.hasOwn(fields, k)),
        'Unexpected schema field',
      );
    return Object.fromEntries(
      Object.entries(fields).flatMap(([k, parse]) => {
        const value = parse(source[k], s);
        return value === undefined ? [] : [[k, value]];
      }),
    );
  };
const map: Parser = (v, s) => {
  const o = object(v);
  requireThat(Object.keys(o).length <= 1000, 'Too many map entries');
  return Object.fromEntries(
    Object.entries(o).map(([k, value]) => {
      requireThat(
        !['__proto__', 'constructor', 'prototype'].includes(k) && k.length <= 256,
        'Invalid map key',
      );
      return [k, str(value, s)];
    }),
  );
};
const strings = arr(str),
  empty = arr(str, 0),
  emptyObject = obj({});
const environment = obj({
  build: str,
  platform: str,
  browser: str,
  device: str,
  locale: str,
  extra: emptyObject,
});
const priority = choice('high', 'normal', 'low');
const outcome = choice('passed', 'failed', 'blocked', 'skipped', 'not_run');
const step = obj({ id: str, action: str, expected: str });
const stepResults: Parser = (v, s) =>
  Object.fromEntries(
    Object.entries(map(v, s) as Record<string, string>).map(([k, v]) => [k, outcome(v, s)]),
  );
const templateField = obj({
  id: str,
  label: str,
  type: choice('text', 'multiline', 'number', 'date', 'checkbox', 'select', 'multiselect'),
  required: bool,
  options: optional(strings),
});
const fieldValues: Parser = (value, strict) => {
  const source = object(value);
  requireThat(Object.keys(source).length <= 100, 'Too many custom fields');
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      requireThat(
        /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) &&
          !['__proto__', 'constructor', 'prototype'].includes(key),
        'Invalid custom field ID',
      );
      if (typeof value === 'string') return [key, str(value, strict)];
      if (typeof value === 'boolean' || value === null) return [key, value];
      if (typeof value === 'number' && Number.isFinite(value)) return [key, value];
      if (Array.isArray(value)) return [key, arr(str, 100)(value, strict)];
      throw new Error('Invalid custom field value');
    }),
  );
};
const dataSchemas: Record<EntityKind, Parser> = {
  document: obj({
    evidenceIds: strings,
    private: literal(false),
    category: optional(str),
    fields: optional(fieldValues),
    templateFields: optional(arr(templateField, 100)),
  }),
  session: obj({
    charter: str,
    state: choice('active', 'paused', 'completed'),
    startedAt: str,
    endedAt: optional(str),
    environment,
    focusAreas: arr(obj({ text: str, checked: bool })),
    conclusion: str,
    exclusions: str,
    durationSeconds: num,
    timeboxMinutes: optional(num),
  }),
  entry: obj({
    sessionId: str,
    category: choice('observation', 'passed', 'issue', 'question', 'idea'),
    expected: str,
    actual: str,
    evidenceIds: strings,
    findingId: optional(str),
    caseId: optional(str),
    private: literal(false),
  }),
  finding: obj({
    private: optional(literal(false)),
    sourceEntryId: optional(str),
    duplicateOf: optional(str),
    code: str,
    status: choice('open', 'in_progress', 'ready_for_retest', 'resolved', 'deferred'),
    severity: choice('blocker', 'critical', 'major', 'minor', 'trivial'),
    priority: choice('urgent', 'high', 'normal', 'low'),
    type: choice('defect', 'improvement', 'risk'),
    steps: strings,
    expected: str,
    actual: str,
    impact: str,
    environment,
    frequency: str,
    suspectedCause: str,
    confirmedCause: str,
    workaround: str,
    resolution: str,
    relatedIds: strings,
    evidenceIds: strings,
    caseIds: strings,
    retests: arr(obj({ id: str, at: str, environment, outcome, notes: str, evidenceIds: strings })),
    owner: str,
    component: str,
  }),
  case: obj({
    private: optional(literal(false)),
    sourceEntryId: optional(str),
    evidenceIds: optional(strings),
    prerequisites: str,
    steps: arr(step),
    folder: str,
    requirementIds: strings,
    datasets: arr(obj({ id: str, name: str, values: map })),
    priority,
    automated: bool,
  }),
  run: obj({
    private: optional(literal(false)),
    state: choice('active', 'completed'),
    environment,
    executions: arr(
      obj({
        id: str,
        caseId: str,
        caseTitle: str,
        caseRevision: integer,
        steps: arr(step),
        prerequisites: str,
        dataset: optional(obj({ name: str, values: map })),
        outcome,
        reason: str,
        notes: str,
        stepResults,
        stepReasons: optional(map),
        datasetId: optional(str),
        requirementIds: optional(strings),
        findingIds: strings,
        evidenceIds: strings,
        updatedAt: str,
        durationMs: optional(num),
      }),
    ),
    conclusion: str,
    exclusions: str,
    startedAt: str,
    completedAt: optional(str),
  }),
  requirement: obj({ code: str, description: str, acceptanceCriteria: str, priority, owner: str }),
  evidence: obj({
    assetId: str,
    filename: str,
    mimeType: choice('image/png', 'text/plain'),
    size: num,
    hash: str,
    width: optional(num),
    height: optional(num),
    caption: str,
    annotations: empty,
    private: literal(false),
    sanitizedAssetId: str,
    source: literal('import'),
    timestampReferences: optional(arr(obj({ seconds: num, label: str }))),
  }),
  template: obj({
    targetKind: choice('document', 'session', 'finding', 'case'),
    description: str,
    icon: str,
    builtIn: literal(false),
    fields: arr(
      obj({
        id: str,
        label: str,
        type: choice('text', 'multiline', 'number', 'date', 'checkbox', 'select', 'multiselect'),
        required: bool,
        options: optional(strings),
      }),
    ),
    sections: arr(obj({ id: str, title: str, guidance: str })),
    defaults: emptyObject,
  }),
};
export const entityKinds = Object.keys(dataSchemas) as EntityKind[];
export function parseData(kind: EntityKind, data: unknown, strict = true): AnyEntity['data'] {
  return dataSchemas[kind](data, strict) as AnyEntity['data'];
}
const allowedNodes = [
  'doc',
  'paragraph',
  'heading',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'blockquote',
  'hardBreak',
  'horizontalRule',
  'text',
];
/** Unknown/hidden nodes are dropped as a whole, never flattened into visible text. Links become inert text. */
export function sanitizeRichDocument(value: unknown, strict = false): RichNode {
  let count = 0;
  const visit = (value: unknown, depth: number): RichNode | null => {
    requireThat(
      ++count <= REPORT_LIMITS.nodes && depth <= REPORT_LIMITS.depth,
      'Rich text resource limit exceeded',
    );
    const n = object(value),
      type = str(n.type, strict) as string;
    if (!allowedNodes.includes(type)) {
      requireThat(!strict, 'Unsupported rich node');
      return null;
    }
    const result: RichNode = { type };
    if (type === 'text') {
      result.text = str(n.text, strict) as string;
      if (n.marks !== undefined) {
        requireThat(Array.isArray(n.marks) && n.marks.length <= 20, 'Invalid text marks');
        const marks = n.marks
          .map(object)
          .filter((m) => ['bold', 'italic', 'strike', 'code', 'underline'].includes(String(m.type)))
          .map((m) => ({ type: String(m.type) }));
        if (marks.length) result.marks = marks;
      }
    } else if (!['hardBreak', 'horizontalRule'].includes(type)) {
      requireThat(n.content === undefined || Array.isArray(n.content), 'Invalid rich content');
      const content = ((n.content ?? []) as unknown[])
        .map((c) => visit(c, depth + 1))
        .filter((c): c is RichNode => c !== null);
      result.content = content;
      if (type === 'heading') {
        const level = object(n.attrs ?? {}).level ?? 2;
        requireThat(
          Number.isInteger(level) && Number(level) >= 1 && Number(level) <= 6,
          'Invalid heading level',
        );
        result.attrs = { level };
      }
      if (type === 'orderedList') {
        const start = object(n.attrs ?? {}).start ?? 1;
        requireThat(
          Number.isInteger(start) && Number(start) >= 1 && Number(start) <= 1_000_000,
          'Invalid list start',
        );
        result.attrs = { start };
      }
      if (type === 'taskItem')
        result.attrs = { checked: bool(object(n.attrs ?? {}).checked ?? false, strict) };
      if (['paragraph', 'heading', 'codeBlock'].includes(type))
        requireThat(
          content.every((c) => ['text', 'hardBreak'].includes(c.type)),
          'Invalid inline structure',
        );
      if (['bulletList', 'orderedList', 'taskList'].includes(type))
        requireThat(
          content.every((c) => c.type === (type === 'taskList' ? 'taskItem' : 'listItem')),
          'Invalid list structure',
        );
      if (type === 'table')
        requireThat(
          content.length > 0 &&
            content.every(
              (c) => c.type === 'tableRow' && c.content?.length === content[0].content?.length,
            ) &&
            (content[0].content?.length ?? 0) > 0 &&
            (content[0].content?.length ?? 0) <= 20,
          'Table must be rectangular with 1–20 columns',
        );
      if (type === 'tableRow')
        requireThat(
          content.every((c) => ['tableCell', 'tableHeader'].includes(c.type)),
          'Invalid table row',
        );
    }
    if (strict)
      requireThat(
        canonical(n) === canonical(result),
        'Unexpected rich text attribute or structure',
      );
    return result;
  };
  const doc = visit(value, 0);
  requireThat(doc?.type === 'doc', 'Expected rich document');
  return doc;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function parseRecord(value: unknown): AnyEntity {
  const v = object(value);
  requireThat(entityKinds.includes(v.kind as EntityKind), 'Unknown record kind');
  const kind = v.kind as EntityKind;
  const record = obj({
    id: str,
    projectId: literal('project'),
    kind: literal(kind),
    title: str,
    body: (value) => sanitizeRichDocument(value, true),
    tags: strings,
    data: dataSchemas[kind],
    revision: integer,
    createdAt: str,
    updatedAt: str,
    deletedAt: literal(null),
  })(v, true) as AnyEntity;
  requireThat(/^record-[1-9]\d*$/.test(record.id), 'Invalid portable record ID');
  if (record.kind === 'run')
    for (const e of record.data.executions) {
      requireThat(
        !['blocked', 'skipped'].includes(e.outcome) || e.reason.trim(),
        'Blocked/skipped execution needs a reason',
      );
      requireThat(
        Object.keys(e.stepResults).every((k) => e.steps.some((s) => s.id === k)),
        'Dangling step result',
      );
      requireThat(
        Object.keys(e.stepReasons ?? {}).every((k) => e.steps.some((s) => s.id === k)),
        'Dangling step reason',
      );
      for (const [id, result] of Object.entries(e.stepResults))
        requireThat(
          !['blocked', 'skipped'].includes(result) || e.stepReasons?.[id]?.trim(),
          'Blocked/skipped step needs a reason',
        );
      requireThat(
        new Set(e.steps.map((s) => s.id)).size === e.steps.length,
        'Duplicate execution step',
      );
    }
  const unique = (ids: string[]) =>
    requireThat(new Set(ids).size === ids.length, 'Duplicate nested ID');
  if (record.kind === 'case') {
    unique(record.data.steps.map((s) => s.id));
    unique(record.data.datasets.map((s) => s.id));
  }
  if (record.kind === 'run') unique(record.data.executions.map((e) => e.id));
  if (record.kind === 'finding') unique(record.data.retests.map((e) => e.id));
  return record;
}
export function parseProject(value: unknown) {
  return obj({
    id: literal('project'),
    name: str,
    description: str,
    prefix: str,
    color: str,
    createdAt: str,
    updatedAt: str,
    archived: literal(false),
    revision: literal(0),
  })(value, true) as import('../../domain/types').Project;
}
export function parseOptions(value: unknown) {
  return obj({
    language: optional(choice('hu', 'en')),
    format: choice('pdf', 'docx', 'html', 'markdown', 'csv', 'json'),
    title: str,
    author: str,
    pageSize: choice('A4', 'LETTER'),
    includeEvidence: bool,
    includePrivate: literal(false),
    includeHistory: literal(false),
    scope: literal('project'),
    entityIds: empty,
    audience: optional(str),
    build: optional(str),
    preset: optional(choice('finding', 'walkthrough', 'session', 'run', 'coverage', 'release')),
  })(value, true) as import('./types').SnapshotOptions;
}
