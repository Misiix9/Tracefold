import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { emptyEnvironment } from './defaults';
import { getRunCounts, isValidInstant, OUTCOMES, validateOutcome } from './testing';
import type { ExecutionSnapshot, RunCounts, RunSnapshot } from './testing';
import type { AnyEntity, EntityKind, Outcome } from './types';

export type ImportFormat = 'junit' | 'csv' | 'tracefold-json';
export interface ImportIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  row?: number;
  field?: string;
}
export type ColumnReference = string | number;
export interface CsvColumnMapping {
  title: ColumnReference;
  outcome: ColumnReference;
  caseId?: ColumnReference;
  suite?: ColumnReference;
  className?: ColumnReference;
  reason?: ColumnReference;
  notes?: ColumnReference;
  durationMs?: ColumnReference;
  durationSeconds?: ColumnReference;
}
export interface ImportOptions {
  filename: string;
  /** Required caller-supplied instant: previews never use the current clock. */
  importedAt: string;
  existingFingerprints?: readonly string[];
  repeatPolicy?: 'reject' | 'allow';
  csvMapping?: CsvColumnMapping;
  delimiter?: ',' | ';' | '\t';
  outcomeValues?: Record<string, Outcome>;
  /** User-supplied reasons, used only when the source omits a blocked/skipped reason. */
  fallbackReasons?: Partial<Record<'blocked' | 'skipped', string>>;
}
export interface ImportIdentity {
  id: string;
  caseId: string;
  title: string;
  suite: string;
  className: string;
  sourceRow: number;
}
export interface ImportPreview {
  format: ImportFormat;
  filename: string;
  fingerprint: string;
  duplicate: boolean;
  requiresRepeatConfirmation: boolean;
  canImport: boolean;
  issues: ImportIssue[];
  identities: ImportIdentity[];
  executions: ExecutionSnapshot[];
  summary: RunCounts;
  /** A detached result ready for review. Null on any error or unconfirmed repeat. */
  run: RunSnapshot | null;
  /** Validated version-1 records, with original identities retained for the parent import transaction. */
  records: AnyEntity[];
  columns: string[];
  mapping?: CsvColumnMapping;
  /** CSV cells escaped for spreadsheet reuse; execution text is preserved as inert plain text. */
  spreadsheetRows: string[][];
}

const MAX_SOURCE_LENGTH = 5_000_000;
const MAX_ROWS = 50_000;
const MAX_DEPTH = 64;
const error = (code: string, message: string, field?: string, row?: number): ImportIssue => ({
  severity: 'error',
  code,
  message,
  ...(field ? { field } : {}),
  ...(row !== undefined ? { row } : {}),
});
const warning = (code: string, message: string, field?: string, row?: number): ImportIssue => ({
  ...error(code, message, field, row),
  severity: 'warning',
});
const normalizedSource = (source: string) => source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

/** Stable non-security content identity (FNV-1a 64). Filenames and import timestamps do not affect repeats. */
export function importFingerprint(format: ImportFormat, source: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${format}\0${normalizedSource(source)}`))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

/** Formula protection preserves the original cell after an apostrophe, including leading whitespace/control characters. */
export function protectSpreadsheetCell(value: string): string {
  return /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(value) || /^[\t\r\n]/.test(value)
    ? `'${value}`
    : value;
}

interface ParsedCsv {
  rows: { cells: string[]; line: number }[];
  issues: ImportIssue[];
}

/** Strict RFC-4180-style parser: quoted delimiters/newlines and doubled quotes, with useful physical line numbers. */
export function parseCsv(source: string, delimiter: ',' | ';' | '\t' = ','): ParsedCsv {
  if (source.length > MAX_SOURCE_LENGTH)
    return {
      rows: [],
      issues: [error('INPUT_TOO_LARGE', 'CSV exceeds the 5 million character preview limit.')],
    };
  if (![',', ';', '\t'].includes(delimiter))
    return {
      rows: [],
      issues: [error('INVALID_DELIMITER', 'Use comma, semicolon, or tab as the delimiter.')],
    };
  const input = normalizedSource(source);
  const rows: ParsedCsv['rows'] = [];
  const issues: ImportIssue[] = [];
  let cells: string[] = [],
    cell = '',
    state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let line = 1,
    rowLine = 1,
    rowHasContent = false;
  const finishCell = () => {
    cells.push(cell);
    cell = '';
    state = 'start';
  };
  const finishRow = () => {
    finishCell();
    if (rowHasContent) rows.push({ cells, line: rowLine });
    cells = [];
    rowHasContent = false;
    rowLine = line + 1;
  };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (state === 'quoted') {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index++;
        } else state = 'closed';
      } else {
        cell += char;
        if (char === '\n') line++;
      }
      continue;
    }
    if (char === delimiter) {
      rowHasContent = true;
      finishCell();
    } else if (char === '\n') {
      finishRow();
      line++;
    } else if (char === '"' && state === 'start') {
      state = 'quoted';
      rowHasContent = true;
    } else if (state === 'closed' || char === '"') {
      issues.push(
        error(
          'MALFORMED_CSV',
          'Unexpected text or quote outside a quoted CSV field.',
          undefined,
          line,
        ),
      );
      return { rows, issues };
    } else {
      cell += char;
      state = 'plain';
      rowHasContent = true;
    }
    if (rows.length > MAX_ROWS)
      return {
        rows: [],
        issues: [error('TOO_MANY_ROWS', `CSV may contain at most ${MAX_ROWS} result rows.`)],
      };
  }
  if (state === 'quoted')
    issues.push(error('MALFORMED_CSV', 'A quoted CSV field was not closed.', undefined, rowLine));
  else if (rowHasContent || cells.length || cell.length) finishRow();
  return { rows, issues };
}

const standardOutcomes: Readonly<Record<string, Outcome>> = {
  passed: 'passed',
  pass: 'passed',
  success: 'passed',
  failed: 'failed',
  fail: 'failed',
  error: 'failed',
  blocked: 'blocked',
  skipped: 'skipped',
  skip: 'skipped',
  disabled: 'skipped',
  not_run: 'not_run',
  'not run': 'not_run',
  notrun: 'not_run',
};

function mappedOutcome(value: string, options: ImportOptions): Outcome | undefined {
  const key = value.trim().toLowerCase();
  const custom = options.outcomeValues;
  const customKey =
    custom && Object.keys(custom).find((candidate) => candidate.trim().toLowerCase() === key);
  return customKey !== undefined
    ? custom![customKey]
    : Object.hasOwn(standardOutcomes, key)
      ? standardOutcomes[key]
      : undefined;
}

function parseNumber(
  text: string,
  field: string,
  issues: ImportIssue[],
  row?: number,
  multiplier = 1,
  integer = false,
): number | undefined {
  // Deliberately reject hexadecimal, Infinity, NaN, exponent overflow, negatives and trailing junk.
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim())) {
    issues.push(
      error('INVALID_NUMBER', `${field} must be a finite nonnegative decimal number.`, field, row),
    );
    return undefined;
  }
  const number = Number(text.trim()) * multiplier;
  if (
    !Number.isFinite(number) ||
    number > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(number))
  ) {
    issues.push(
      error(
        'INVALID_NUMBER',
        `${field} is out of range${integer ? ' or not an integer' : ''}.`,
        field,
        row,
      ),
    );
    return undefined;
  }
  return number;
}

function suggestMapping(columns: string[]): CsvColumnMapping | undefined {
  const pick = (...names: string[]) =>
    columns.find((column) => names.includes(column.toLowerCase()));
  const title = pick('title', 'name', 'test', 'test name', 'test_name');
  const outcome = pick('outcome', 'status', 'result');
  if (!title || !outcome) return undefined;
  const mapping: CsvColumnMapping = { title, outcome };
  const optional: [keyof CsvColumnMapping, string[]][] = [
    ['caseId', ['case_id', 'caseid']],
    ['suite', ['suite', 'testsuite']],
    ['className', ['classname', 'class_name']],
    ['reason', ['reason', 'message']],
    ['notes', ['notes']],
    ['durationMs', ['duration_ms', 'durationms']],
    ['durationSeconds', ['time', 'duration_seconds']],
  ];
  for (const [key, aliases] of optional) {
    const column = pick(...aliases);
    if (column) mapping[key] = column;
  }
  return mapping;
}

interface ImportBuilder {
  preview: ImportPreview;
  options: ImportOptions;
  sequence: number;
}
interface IncomingResult {
  title: string;
  outcome: Outcome;
  reason: string;
  notes: string;
  row: number;
  caseId?: string;
  suite?: string;
  className?: string;
  durationMs?: number;
  snapshot?: ExecutionSnapshot;
}

function addResult(builder: ImportBuilder, incoming: IncomingResult): void {
  const { preview, options } = builder;
  if (preview.executions.length >= MAX_ROWS) {
    if (!preview.issues.some((item) => item.code === 'TOO_MANY_ROWS'))
      preview.issues.push(
        error('TOO_MANY_ROWS', `A preview may contain at most ${MAX_ROWS} results.`),
      );
    return;
  }
  builder.sequence++;
  let reason = incoming.reason;
  if ((incoming.outcome === 'skipped' || incoming.outcome === 'blocked') && !reason.trim())
    reason = options.fallbackReasons?.[incoming.outcome]?.trim() ?? '';
  if (!incoming.title.trim())
    preview.issues.push(
      error('TITLE_REQUIRED', 'Every result requires a nonempty test name.', 'title', incoming.row),
    );
  for (const issue of validateOutcome(incoming.outcome, reason))
    preview.issues.push(error(issue.code, issue.message, issue.field, incoming.row));
  const caseId =
    incoming.caseId ||
    `automated:${JSON.stringify([incoming.suite ?? '', incoming.className ?? '', incoming.title])}`;
  const id = `import:${preview.fingerprint}:${builder.sequence}`;
  const execution: ExecutionSnapshot = incoming.snapshot
    ? structuredClone(incoming.snapshot)
    : {
        id,
        caseId,
        caseTitle: incoming.title,
        caseRevision: 0,
        steps: [],
        prerequisites: '',
        outcome: incoming.outcome,
        reason,
        notes: incoming.notes,
        stepResults: {},
        stepReasons: {},
        findingIds: [],
        evidenceIds: [],
        updatedAt: options.importedAt,
        ...(incoming.durationMs !== undefined ? { durationMs: incoming.durationMs } : {}),
      };
  // Existing JSON snapshots remain byte-for-byte equivalent in their historical fields.
  preview.executions.push(execution);
  preview.identities.push({
    id: execution.id,
    caseId: execution.caseId,
    title: execution.caseTitle,
    suite: incoming.suite ?? '',
    className: incoming.className ?? '',
    sourceRow: incoming.row,
  });
}

function readCsv(source: string, builder: ImportBuilder): void {
  const { preview, options } = builder;
  const parsed = parseCsv(source, options.delimiter);
  preview.issues.push(...parsed.issues);
  if (!parsed.rows.length) return;
  const columns = parsed.rows[0].cells.map((column) => column.trim());
  preview.columns = columns;
  if (
    columns.some((column) => !column) ||
    new Set(columns.map((column) => column.toLowerCase())).size !== columns.length
  ) {
    preview.issues.push(
      error(
        'INVALID_HEADERS',
        'CSV headers must be nonempty and unique, ignoring case.',
        undefined,
        parsed.rows[0].line,
      ),
    );
    return;
  }
  preview.spreadsheetRows = parsed.rows.map((row) => row.cells.map(protectSpreadsheetCell));
  const mapping = options.csvMapping ?? suggestMapping(columns);
  preview.mapping = mapping;
  if (!mapping) {
    preview.issues.push(
      error('MAPPING_REQUIRED', 'Map CSV columns to a test title and an outcome.'),
    );
    return;
  }
  const indexes: Partial<Record<keyof CsvColumnMapping, number>> = {};
  for (const [field, column] of Object.entries(mapping)) {
    const index = typeof column === 'number' ? column : columns.indexOf(column);
    if (!Number.isInteger(index) || index < 0 || index >= columns.length)
      preview.issues.push(
        error('UNKNOWN_COLUMN', `Column ${String(column)} does not exist.`, field),
      );
    else indexes[field as keyof CsvColumnMapping] = index;
  }
  if (indexes.title === undefined || indexes.outcome === undefined)
    preview.issues.push(
      error('MAPPING_REQUIRED', 'Map both a title column and an outcome column.'),
    );
  if (indexes.durationMs !== undefined && indexes.durationSeconds !== undefined)
    preview.issues.push(
      error('AMBIGUOUS_DURATION', 'Map duration in either milliseconds or seconds, not both.'),
    );
  if (new Set(Object.values(indexes)).size !== Object.values(indexes).length)
    preview.issues.push(
      error('DUPLICATE_MAPPING', 'A CSV column may map to only one result field.'),
    );
  if (preview.issues.some((item) => item.severity === 'error')) return;
  for (const row of parsed.rows.slice(1)) {
    if (row.cells.length !== columns.length) {
      preview.issues.push(
        error(
          'ROW_WIDTH',
          `Expected ${columns.length} columns; found ${row.cells.length}.`,
          undefined,
          row.line,
        ),
      );
      continue;
    }
    const get = (field: keyof CsvColumnMapping) =>
      indexes[field] === undefined ? '' : row.cells[indexes[field]!];
    const outcome = mappedOutcome(get('outcome'), options);
    if (!outcome || !OUTCOMES.includes(outcome)) {
      preview.issues.push(
        error('INVALID_OUTCOME', `Unrecognized outcome: ${get('outcome')}`, 'outcome', row.line),
      );
      continue;
    }
    const durationField = indexes.durationMs !== undefined ? 'durationMs' : 'durationSeconds';
    const rawDuration = get(durationField);
    const durationMs = rawDuration.trim()
      ? parseNumber(
          rawDuration,
          durationField,
          preview.issues,
          row.line,
          durationField === 'durationSeconds' ? 1000 : 1,
        )
      : undefined;
    if (row.cells.some((value) => protectSpreadsheetCell(value) !== value))
      preview.issues.push(
        warning(
          'FORMULA_TEXT',
          'Formula-like cells are retained as plain text; spreadsheet preview cells are apostrophe-protected.',
          undefined,
          row.line,
        ),
      );
    addResult(builder, {
      title: get('title'),
      outcome,
      reason: get('reason'),
      notes: get('notes'),
      row: row.line,
      caseId: get('caseId'),
      suite: get('suite'),
      className: get('className'),
      durationMs,
    });
  }
}

type XmlNode = { [key: string]: XmlNode[] | Record<string, string> | string };
const tagOf = (node: XmlNode) => Object.keys(node).find((key) => key !== ':@') ?? '';
const childrenOf = (node: XmlNode): XmlNode[] =>
  Array.isArray(node[tagOf(node)]) ? (node[tagOf(node)] as XmlNode[]) : [];
const attributesOf = (node: XmlNode) => (node[':@'] ?? {}) as Record<string, string>;
const textOf = (node: XmlNode): string =>
  typeof node['#text'] === 'string' ? node['#text'] : childrenOf(node).map(textOf).join('');

function unsafeXml(source: string): string | undefined {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))
    return 'DTD and entity declarations are not accepted.';
  const stripped = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(stripped))
    return 'Unknown or unterminated XML entity reference.';
  const validPoint = (value: number) =>
    value === 9 ||
    value === 10 ||
    value === 13 ||
    (value >= 32 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff);
  for (const char of source) if (!validPoint(char.codePointAt(0)!)) return 'Invalid XML character.';
  for (const match of stripped.matchAll(/&#(x[\da-fA-F]+|\d+);/g))
    if (!validPoint(match[1][0] === 'x' ? parseInt(match[1].slice(1), 16) : Number(match[1])))
      return 'Invalid numeric XML character reference.';
  let depth = 0;
  for (const match of stripped.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
    const tag = match[0];
    if (tag.startsWith('</')) depth--;
    else if (!tag.startsWith('<?') && !tag.startsWith('<!') && !tag.endsWith('/>')) depth++;
    if (depth > MAX_DEPTH) return `XML nesting exceeds ${MAX_DEPTH} levels.`;
  }
  return undefined;
}

function readJunit(source: string, builder: ImportBuilder): void {
  const { preview } = builder;
  const unsafe = unsafeXml(source);
  if (unsafe) {
    preview.issues.push(error('UNSAFE_XML', unsafe));
    return;
  }
  const validation = XMLValidator.validate(source, { allowBooleanAttributes: false });
  if (validation !== true) {
    preview.issues.push(error('MALFORMED_XML', validation.err.msg, undefined, validation.err.line));
    return;
  }
  let nodes: XmlNode[];
  try {
    nodes = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: true,
      htmlEntities: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
    }).parse(source) as XmlNode[];
  } catch {
    preview.issues.push(error('MALFORMED_XML', 'The XML parser could not read this document.'));
    return;
  }
  const roots = nodes.filter((node) => tagOf(node) !== '#text');
  if (roots.length !== 1 || !['testsuite', 'testsuites'].includes(tagOf(roots[0]))) {
    preview.issues.push(
      error('INVALID_JUNIT_ROOT', 'JUnit XML must have one testsuite or testsuites root.'),
    );
    return;
  }
  const resultMarkers: { failures: number; errors: number; skipped: number; disabled: number }[] =
    [];
  const visit = (node: XmlNode, suitePath: string[], depth: number): void => {
    if (depth > MAX_DEPTH) {
      preview.issues.push(error('UNSAFE_XML', 'JUnit suites are nested too deeply.'));
      return;
    }
    const tag = tagOf(node),
      attributes = attributesOf(node);
    const suite = attributes.name ? [...suitePath, attributes.name] : suitePath;
    const start = preview.executions.length;
    const markerStart = resultMarkers.length;
    for (const name of ['tests', 'failures', 'errors', 'skipped', 'disabled'] as const)
      if (attributes[name] !== undefined)
        parseNumber(attributes[name], `${tag}.${name}`, preview.issues, undefined, 1, true);
    if (attributes.time !== undefined)
      parseNumber(attributes.time, `${tag}.time`, preview.issues, undefined, 1000);
    for (const child of childrenOf(node)) {
      const name = tagOf(child);
      if (name === 'testsuite' || name === 'testsuites') {
        visit(child, suite, depth + 1);
        continue;
      }
      if (['#text', 'properties', 'system-out', 'system-err'].includes(name)) continue;
      if (name !== 'testcase') {
        preview.issues.push(
          error('UNSUPPORTED_JUNIT_ELEMENT', `Unexpected JUnit element: ${name}.`),
        );
        continue;
      }
      const row = builder.sequence + 1,
        attrs = attributesOf(child),
        parts = childrenOf(child);
      const markers = parts.filter((part) => ['failure', 'error', 'skipped'].includes(tagOf(part)));
      const failed = markers.some((part) => ['failure', 'error'].includes(tagOf(part)));
      const skipped = markers.some((part) => tagOf(part) === 'skipped');
      if (failed && skipped)
        preview.issues.push(
          error(
            'CONFLICTING_OUTCOMES',
            'A testcase cannot contain both a failure/error and a skipped marker.',
            'outcome',
            row,
          ),
        );
      const status = attrs.status?.trim().toLowerCase();
      const explicit =
        status && status !== 'run' ? mappedOutcome(status, builder.options) : undefined;
      if (status && status !== 'run' && !explicit)
        preview.issues.push(
          error('INVALID_OUTCOME', `Unrecognized JUnit status: ${attrs.status}.`, 'outcome', row),
        );
      const resultAttribute = attrs.result?.trim().toLowerCase();
      const explicitResult =
        resultAttribute && resultAttribute !== 'completed'
          ? mappedOutcome(resultAttribute, builder.options)
          : undefined;
      if (resultAttribute && resultAttribute !== 'completed' && !explicitResult)
        preview.issues.push(
          error('INVALID_OUTCOME', `Unrecognized JUnit result: ${attrs.result}.`, 'outcome', row),
        );
      const outcome: Outcome = failed
        ? 'failed'
        : skipped
          ? 'skipped'
          : (explicitResult ?? explicit ?? 'passed');
      if ((failed || skipped) && explicit && explicit !== outcome)
        preview.issues.push(
          error(
            'CONFLICTING_OUTCOMES',
            'JUnit status contradicts its result marker.',
            'outcome',
            row,
          ),
        );
      if (
        (explicitResult && explicitResult !== outcome) ||
        (explicitResult && explicit && explicitResult !== explicit)
      )
        preview.issues.push(
          error(
            'CONFLICTING_OUTCOMES',
            'JUnit result contradicts its status or result marker.',
            'outcome',
            row,
          ),
        );
      for (const part of parts)
        if (
          ![
            '#text',
            'failure',
            'error',
            'skipped',
            'system-out',
            'system-err',
            'properties',
          ].includes(tagOf(part))
        )
          preview.issues.push(
            error(
              'UNSUPPORTED_JUNIT_ELEMENT',
              `Unexpected testcase element: ${tagOf(part)}.`,
              undefined,
              row,
            ),
          );
      const reason = markers
        .map((part) => [attributesOf(part).message, textOf(part)].filter(Boolean).join('\n'))
        .join('\n')
        .trim();
      const notes = parts
        .filter((part) => ['system-out', 'system-err'].includes(tagOf(part)))
        .map((part) => `${tagOf(part)}:\n${textOf(part)}`)
        .join('\n');
      const durationMs =
        attrs.time === undefined
          ? undefined
          : parseNumber(attrs.time, 'testcase.time', preview.issues, row, 1000);
      resultMarkers.push({
        failures:
          markers.some((part) => tagOf(part) === 'failure') ||
          (outcome === 'failed' && !markers.some((part) => tagOf(part) === 'error'))
            ? 1
            : 0,
        errors: markers.some((part) => tagOf(part) === 'error') ? 1 : 0,
        skipped: outcome === 'skipped' ? 1 : 0,
        disabled: status === 'disabled' ? 1 : 0,
      });
      addResult(builder, {
        title: attrs.name ?? '',
        caseId: attrs.id,
        className: attrs.classname,
        suite: suite.join(' / '),
        outcome,
        reason,
        notes,
        durationMs,
        row,
      });
    }
    const actual = preview.executions.length - start;
    if (
      attributes.tests !== undefined &&
      Number.isSafeInteger(Number(attributes.tests)) &&
      Number(attributes.tests) !== actual
    )
      preview.issues.push(
        error(
          'JUNIT_COUNT_MISMATCH',
          `${suite.join(' / ') || tag} declares ${attributes.tests} tests but contains ${actual} testcase results.`,
          'tests',
        ),
      );
    for (const key of ['failures', 'errors', 'skipped', 'disabled'] as const) {
      const count = resultMarkers
        .slice(markerStart)
        .reduce((total, marker) => total + marker[key], 0);
      if (
        attributes[key] !== undefined &&
        Number.isSafeInteger(Number(attributes[key])) &&
        Number(attributes[key]) !== count
      )
        preview.issues.push(
          error(
            'JUNIT_COUNT_MISMATCH',
            `${suite.join(' / ') || tag} declares ${attributes[key]} ${key} but its results contain ${count}.`,
            key,
          ),
        );
    }
  };
  visit(roots[0], [], 0);
}

// Small explicit schema combinators keep JSON imports typed without adding a schema runtime dependency.
type Check = (value: unknown, field: string, issues: ImportIssue[]) => boolean;
const bad = (field: string, issues: ImportIssue[], expected: string) => {
  issues.push(error('INVALID_JSON_FIELD', `Expected ${expected}.`, field));
  return false;
};
const string: Check = (value, field, issues) =>
  typeof value === 'string' || bad(field, issues, 'text');
const nonempty: Check = (value, field, issues) =>
  (typeof value === 'string' && !!value.trim()) || bad(field, issues, 'nonempty text');
const boolean: Check = (value, field, issues) =>
  typeof value === 'boolean' || bad(field, issues, 'a boolean');
const number: Check = (value, field, issues) =>
  (typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER) ||
  bad(field, issues, 'a finite nonnegative number');
const integer: Check = (value, field, issues) =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
  bad(field, issues, 'a nonnegative integer');
const instant: Check = (value, field, issues) =>
  (typeof value === 'string' && isValidInstant(value)) ||
  bad(field, issues, 'an ISO timestamp with a timezone');
const optional =
  (check: Check): Check =>
  (value, field, issues) =>
    value === undefined || check(value, field, issues);
const nullable =
  (check: Check): Check =>
  (value, field, issues) =>
    value === null || check(value, field, issues);
const oneOf =
  (...values: (string | number)[]): Check =>
  (value, field, issues) =>
    values.includes(value as string) || bad(field, issues, values.join(' / '));
const objectValue = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const object =
  (fields: Record<string, Check>): Check =>
  (value, field, issues) => {
    if (!objectValue(value)) return bad(field, issues, 'an object');
    let valid = true;
    for (const [key, check] of Object.entries(fields))
      if (!check(value[key], `${field}.${key}`, issues)) valid = false;
    for (const key of Object.keys(value))
      if (!Object.hasOwn(fields, key)) {
        issues.push(
          error(
            'UNKNOWN_JSON_FIELD',
            'Unsupported field; it would otherwise be silently discarded.',
            `${field}.${key}`,
          ),
        );
        valid = false;
      }
    return valid;
  };
const array =
  (check: Check): Check =>
  (value, field, issues) => {
    if (!Array.isArray(value) || value.length > MAX_ROWS)
      return bad(field, issues, `an array of at most ${MAX_ROWS} items`);
    let valid = true;
    value.forEach((item, index) => {
      if (!check(item, `${field}[${index}]`, issues)) valid = false;
    });
    return valid;
  };
const dictionary =
  (check: Check): Check =>
  (value, field, issues) => {
    if (!objectValue(value)) return bad(field, issues, 'an object');
    let valid = true;
    for (const [key, item] of Object.entries(value))
      if (!check(item, `${field}.${key}`, issues)) valid = false;
    return valid;
  };
const inert: Check = () => true; // The entire parsed tree is checked for unsafe keys/numbers/depth before schemas run.
const strings = array(string),
  ids = array(nonempty);
const environment = object({
  build: string,
  platform: string,
  browser: string,
  device: string,
  locale: string,
  extra: dictionary(string),
});
const step = object({ id: nonempty, action: string, expected: string });
const outcome = oneOf(...OUTCOMES);
const execution = object({
  id: nonempty,
  caseId: nonempty,
  caseTitle: nonempty,
  caseRevision: integer,
  prerequisites: string,
  steps: array(step),
  datasetId: optional(nonempty),
  dataset: optional(object({ name: string, values: dictionary(string) })),
  requirementIds: optional(ids),
  outcome,
  reason: string,
  notes: string,
  stepResults: dictionary(outcome),
  stepReasons: optional(dictionary(string)),
  findingIds: ids,
  evidenceIds: ids,
  updatedAt: instant,
  durationMs: optional(number),
});
const run = object({
  state: oneOf('active', 'completed'),
  environment,
  executions: array(execution),
  conclusion: string,
  exclusions: string,
  startedAt: instant,
  completedAt: optional(instant),
  source: optional(
    object({ format: nonempty, filename: string, fingerprint: nonempty, importedAt: instant }),
  ),
});
const retest = object({
  id: nonempty,
  at: instant,
  environment,
  outcome,
  notes: string,
  evidenceIds: ids,
});
const richNode: Check = (value, field, issues) => {
  const check = object({
    type: oneOf(
      'doc',
      'paragraph',
      'text',
      'heading',
      'bulletList',
      'orderedList',
      'listItem',
      'taskList',
      'taskItem',
      'blockquote',
      'codeBlock',
      'hardBreak',
      'horizontalRule',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
      'image',
    ),
    text: optional(string),
    attrs: optional(dictionary(inert)),
    marks: optional(
      array(
        object({
          type: oneOf(
            'bold',
            'italic',
            'strike',
            'code',
            'underline',
            'link',
            'textStyle',
            'highlight',
            'subscript',
            'superscript',
          ),
          attrs: optional(dictionary(inert)),
        }),
      ),
    ),
    content: optional(array(richNode)),
  });
  return check(value, field, issues);
};
const templateField = object({
  id: nonempty,
  label: nonempty,
  type: oneOf('text', 'multiline', 'number', 'date', 'checkbox', 'select', 'multiselect'),
  required: boolean,
  options: optional(strings),
});
const dataChecks: Record<EntityKind, Check> = {
  document: object({
    templateId: optional(string),
    private: optional(boolean),
    evidenceIds: ids,
    category: optional(string),
    fields: optional(dictionary(inert)),
  }),
  session: object({
    charter: string,
    state: oneOf('active', 'paused', 'completed'),
    startedAt: instant,
    endedAt: optional(instant),
    environment,
    focusAreas: array(object({ text: string, checked: boolean })),
    conclusion: string,
    exclusions: string,
    durationSeconds: number,
  }),
  entry: object({
    sessionId: nonempty,
    category: oneOf('observation', 'passed', 'issue', 'question', 'idea'),
    expected: string,
    actual: string,
    evidenceIds: ids,
    findingId: optional(string),
    private: boolean,
  }),
  finding: object({
    code: string,
    status: oneOf('open', 'in_progress', 'ready_for_retest', 'resolved', 'deferred'),
    severity: oneOf('blocker', 'critical', 'major', 'minor', 'trivial'),
    priority: oneOf('urgent', 'high', 'normal', 'low'),
    type: oneOf('defect', 'improvement', 'risk'),
    steps: strings,
    expected: string,
    actual: string,
    impact: string,
    environment,
    frequency: string,
    suspectedCause: string,
    confirmedCause: string,
    workaround: string,
    resolution: string,
    relatedIds: ids,
    evidenceIds: ids,
    caseIds: ids,
    retests: array(retest),
    owner: string,
    component: string,
  }),
  case: object({
    prerequisites: string,
    steps: array(step),
    folder: string,
    requirementIds: ids,
    datasets: array(object({ id: nonempty, name: string, values: dictionary(string) })),
    priority: oneOf('high', 'normal', 'low'),
    automated: boolean,
  }),
  run,
  requirement: object({
    code: string,
    description: string,
    acceptanceCriteria: string,
    priority: oneOf('high', 'normal', 'low'),
    owner: string,
  }),
  evidence: object({
    assetId: nonempty,
    filename: string,
    mimeType: nonempty,
    size: integer,
    hash: nonempty,
    width: optional(number),
    height: optional(number),
    caption: string,
    annotations: array(
      object({
        id: nonempty,
        tool: oneOf('arrow', 'rectangle', 'ellipse', 'highlight', 'text', 'number', 'redact'),
        x: number,
        y: number,
        width: number,
        height: number,
        color: string,
        text: optional(string),
        stroke: optional(number),
      }),
    ),
    crop: optional(object({ x: number, y: number, width: number, height: number })),
    private: boolean,
    originalAssetId: optional(string),
    sanitizedAssetId: optional(string),
    source: oneOf('capture', 'paste', 'import'),
    timestampReferences: optional(array(object({ seconds: number, label: string }))),
  }),
  template: object({
    targetKind: oneOf('document', 'session', 'finding', 'case'),
    description: string,
    icon: string,
    builtIn: boolean,
    fields: array(templateField),
    sections: array(object({ id: nonempty, title: nonempty, guidance: string })),
    defaults: dictionary(inert),
  }),
};

function inspectJson(value: unknown, issues: ImportIssue[], field = '$', depth = 0): boolean {
  if (depth > MAX_DEPTH) {
    issues.push(error('UNSAFE_JSON', `JSON nesting exceeds ${MAX_DEPTH} levels.`, field));
    return false;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    issues.push(error('INVALID_NUMBER', 'JSON numbers must be finite.', field));
    return false;
  }
  if (typeof value !== 'object' || value === null) return true;
  let valid = true;
  for (const [key, child] of Object.entries(value)) {
    if (
      ['__proto__', 'prototype', 'constructor', 'innerHTML', 'outerHTML', 'srcdoc'].includes(key) ||
      /^on[a-z]+$/i.test(key)
    ) {
      issues.push(error('UNSAFE_JSON', `Unsafe object key: ${key}.`, `${field}.${key}`));
      valid = false;
    }
    if (['href', 'src'].includes(key) && typeof child === 'string') {
      const normalized = child.replace(/[\s\u0000-\u001f\u007f]+/g, '');
      if (/^(?:javascript|vbscript|data|file):/i.test(normalized) || normalized.startsWith('//')) {
        issues.push(
          error(
            'UNSAFE_JSON',
            'Active content and local-file URLs are not accepted.',
            `${field}.${key}`,
          ),
        );
        valid = false;
      }
    }
    if (!inspectJson(child, issues, `${field}.${key}`, depth + 1)) valid = false;
  }
  return valid;
}

function validateExecutions(
  executions: ExecutionSnapshot[],
  issues: ImportIssue[],
  field: string,
): void {
  const ids = new Set<string>();
  executions.forEach((execution, index) => {
    const prefix = `${field}[${index}]`;
    if (ids.has(execution.id))
      issues.push(
        error('DUPLICATE_EXECUTION', 'Execution IDs must be unique within a run.', `${prefix}.id`),
      );
    ids.add(execution.id);
    issues.push(
      ...validateOutcome(execution.outcome, execution.reason).map((item) =>
        error(item.code, item.message, `${prefix}.${item.field}`),
      ),
    );
    const steps = new Set(execution.steps.map((step) => step.id));
    if (steps.size !== execution.steps.length)
      issues.push(
        error('DUPLICATE_STEP', 'Step IDs must be unique within an execution.', `${prefix}.steps`),
      );
    for (const [id, result] of Object.entries(execution.stepResults)) {
      if (!steps.has(id))
        issues.push(
          error(
            'UNKNOWN_STEP',
            'Step result references a step outside its snapshot.',
            `${prefix}.stepResults.${id}`,
          ),
        );
      issues.push(
        ...validateOutcome(result, execution.stepReasons?.[id] ?? '').map((item) =>
          error(item.code, item.message, `${prefix}.steps.${id}.${item.field}`),
        ),
      );
    }
    for (const id of Object.keys(execution.stepReasons ?? {}))
      if (!steps.has(id))
        issues.push(
          error(
            'UNKNOWN_STEP',
            'Step reason references a step outside its snapshot.',
            `${prefix}.stepReasons.${id}`,
          ),
        );
  });
}

function validateRunHistory(data: RunSnapshot, issues: ImportIssue[], field: string): void {
  if (!data.executions.length)
    issues.push(
      error(
        'NO_RESULTS',
        'A run must contain at least one execution snapshot.',
        `${field}.executions`,
      ),
    );
  if (data.state === 'completed' && !data.completedAt)
    issues.push(
      error(
        'INVALID_RUN_HISTORY',
        'A completed run requires its completion timestamp.',
        `${field}.completedAt`,
      ),
    );
  if (data.state === 'active' && data.completedAt)
    issues.push(
      error(
        'INVALID_RUN_HISTORY',
        'An active run cannot already have a completion timestamp.',
        `${field}.completedAt`,
      ),
    );
  if (data.completedAt && Date.parse(data.completedAt) < Date.parse(data.startedAt))
    issues.push(
      error(
        'INVALID_RUN_HISTORY',
        'Run completion cannot precede its start.',
        `${field}.completedAt`,
      ),
    );
  for (const [index, execution] of data.executions.entries()) {
    if (
      Date.parse(execution.updatedAt) < Date.parse(data.startedAt) ||
      (data.completedAt && Date.parse(execution.updatedAt) > Date.parse(data.completedAt))
    ) {
      issues.push(
        error(
          'INVALID_RUN_HISTORY',
          'Execution timestamp falls outside the run history.',
          `${field}.executions[${index}].updatedAt`,
        ),
      );
    }
  }
}

function readJson(source: string, builder: ImportBuilder): void {
  const { preview } = builder;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    preview.issues.push(error('MALFORMED_JSON', 'This file is not valid JSON.'));
    return;
  }
  if (!inspectJson(value, preview.issues)) return;
  if (!objectValue(value) || value.schemaVersion !== 1) {
    preview.issues.push(error('UNSUPPORTED_SCHEMA', 'Tracefold JSON requires schemaVersion: 1.'));
    return;
  }
  const containers = ['records', 'run', 'executions'].filter((key) => Object.hasOwn(value, key));
  if (containers.length !== 1) {
    preview.issues.push(
      error('INVALID_JSON_CONTAINER', 'Supply exactly one of records, run, or executions.'),
    );
    return;
  }
  const collect = (executions: ExecutionSnapshot[], field: string) => {
    validateExecutions(executions, preview.issues, field);
    for (const execution of executions)
      addResult(builder, {
        title: execution.caseTitle,
        outcome: execution.outcome,
        reason: execution.reason,
        notes: execution.notes,
        row: builder.sequence + 1,
        snapshot: execution,
      });
  };
  if (containers[0] === 'executions') {
    if (array(execution)(value.executions, '$.executions', preview.issues))
      collect(value.executions as ExecutionSnapshot[], '$.executions');
  } else if (containers[0] === 'run') {
    if (run(value.run, '$.run', preview.issues)) {
      const data = value.run as unknown as RunSnapshot;
      validateRunHistory(data, preview.issues, '$.run');
      collect(data.executions, '$.run.executions');
      preview.run = structuredClone(data);
    }
  } else {
    if (!Array.isArray(value.records) || value.records.length > MAX_ROWS) {
      preview.issues.push(
        error('INVALID_JSON_CONTAINER', `records must be an array of at most ${MAX_ROWS} records.`),
      );
      return;
    }
    const ids = new Set<string>();
    for (const [index, record] of value.records.entries()) {
      const field = `$.records[${index}]`;
      if (
        !objectValue(record) ||
        typeof record.kind !== 'string' ||
        !Object.hasOwn(dataChecks, record.kind)
      ) {
        preview.issues.push(
          error('INVALID_ENTITY_KIND', 'Unsupported Tracefold record kind.', `${field}.kind`),
        );
        continue;
      }
      const check = object({
        id: nonempty,
        projectId: nonempty,
        kind: oneOf(record.kind),
        title: string,
        body: richNode,
        tags: strings,
        data: dataChecks[record.kind as EntityKind],
        revision: integer,
        createdAt: instant,
        updatedAt: instant,
        deletedAt: nullable(instant),
      });
      if (!check(record, field, preview.issues)) continue;
      if (ids.has(record.id as string))
        preview.issues.push(
          error('DUPLICATE_RECORD', 'Record identities must be unique.', `${field}.id`),
        );
      ids.add(record.id as string);
      const entity = record as unknown as AnyEntity;
      preview.records.push(structuredClone(entity));
      if (entity.kind === 'run') {
        validateRunHistory(entity.data, preview.issues, `${field}.data`);
        collect(entity.data.executions, `${field}.data.executions`);
      }
      if (entity.kind === 'finding') {
        const seen = new Set<string>();
        for (const retest of entity.data.retests) {
          if (seen.has(retest.id))
            preview.issues.push(
              error('DUPLICATE_RETEST', 'Retest IDs must be unique.', `${field}.data.retests`),
            );
          seen.add(retest.id);
          if (retest.outcome === 'not_run')
            preview.issues.push(
              error(
                'RETEST_NOT_RUN',
                'A retest must record an actual outcome.',
                `${field}.data.retests`,
              ),
            );
          preview.issues.push(
            ...validateOutcome(retest.outcome, retest.notes).map((item) =>
              error(item.code, item.message, `${field}.data.retests`),
            ),
          );
        }
      }
      if (entity.kind === 'evidence')
        preview.issues.push(
          warning(
            'ASSET_BYTES_REQUIRED',
            'JSON contains evidence metadata only. Verify and import its asset bytes in the parent transaction.',
            `${field}.data.assetId`,
          ),
        );
    }
    const runs = preview.records.filter(
      (record): record is Extract<AnyEntity, { kind: 'run' }> => record.kind === 'run',
    );
    if (runs.length === 1) preview.run = structuredClone(runs[0].data);
  }
}

/**
 * Parse and validate offline results without saving or executing anything. Any malformed row blocks the whole import.
 * JUnit: testsuite/testsuites; CSV: named or zero-based mapped columns; JSON: schemaVersion 1 plus records, run, or executions.
 * Repeated content requires repeatPolicy: 'allow'. CSV remapping does not bypass the content fingerprint.
 */
export function previewImport(
  format: ImportFormat,
  source: string,
  options: ImportOptions,
): ImportPreview {
  const fingerprint = source.length <= MAX_SOURCE_LENGTH ? importFingerprint(format, source) : '';
  const duplicate = !!fingerprint && (options.existingFingerprints ?? []).includes(fingerprint);
  const preview: ImportPreview = {
    format,
    filename: options.filename,
    fingerprint,
    duplicate,
    requiresRepeatConfirmation: duplicate && options.repeatPolicy !== 'allow',
    canImport: false,
    issues: [],
    identities: [],
    executions: [],
    summary: getRunCounts([]),
    run: null,
    records: [],
    columns: [],
    spreadsheetRows: [],
  };
  if (!isValidInstant(options.importedAt))
    preview.issues.push(
      error('INVALID_TIMESTAMP', 'Supply a valid import timestamp with a timezone.', 'importedAt'),
    );
  if (source.length > MAX_SOURCE_LENGTH)
    preview.issues.push(
      error('INPUT_TOO_LARGE', 'Input exceeds the 5 million character preview limit.'),
    );
  const normalized = normalizedSource(source);
  if (!normalized.trim()) preview.issues.push(error('EMPTY_INPUT', 'The file is empty.'));
  if (duplicate)
    preview.issues.push(
      warning(
        'REPEAT_IMPORT',
        options.repeatPolicy === 'allow'
          ? 'This content was imported before; another import was explicitly allowed.'
          : 'This content was imported before. Explicitly allow a repeat before importing.',
      ),
    );
  if (!preview.issues.some((item) => item.severity === 'error')) {
    const builder = { preview, options, sequence: 0 };
    if (format === 'junit') readJunit(normalized, builder);
    else if (format === 'csv') readCsv(normalized, builder);
    else if (format === 'tracefold-json') readJson(normalized, builder);
    else preview.issues.push(error('UNSUPPORTED_FORMAT', 'Choose junit, csv, or tracefold-json.'));
    if (!preview.executions.length && !preview.records.length)
      preview.issues.push(
        error('NO_RESULTS', 'No importable test results or Tracefold records were found.'),
      );
  }
  // Even blocked previews provide trustworthy counts for the valid, visible results.
  preview.summary = getRunCounts(preview.executions);
  preview.canImport =
    !preview.requiresRepeatConfirmation &&
    !preview.issues.some((item) => item.severity === 'error');
  if (!preview.canImport) preview.run = null;
  else if (!preview.run && preview.executions.length && !preview.records.length)
    preview.run = {
      state: 'completed',
      environment: emptyEnvironment(),
      executions: structuredClone(preview.executions),
      conclusion: '',
      exclusions: '',
      // Execution-only JSON has historical timestamps but no run boundaries: use their range, never rewrite results.
      startedAt:
        format === 'tracefold-json'
          ? preview.executions.reduce(
              (earliest, execution) =>
                Date.parse(execution.updatedAt) < Date.parse(earliest)
                  ? execution.updatedAt
                  : earliest,
              preview.executions[0].updatedAt,
            )
          : options.importedAt,
      completedAt:
        format === 'tracefold-json'
          ? preview.executions.reduce(
              (latest, execution) =>
                Date.parse(execution.updatedAt) > Date.parse(latest) ? execution.updatedAt : latest,
              preview.executions[0].updatedAt,
            )
          : options.importedAt,
      source: { format, filename: options.filename, fingerprint, importedAt: options.importedAt },
    };
  if (preview.run)
    preview.run.source = {
      format,
      filename: options.filename,
      fingerprint,
      importedAt: options.importedAt,
    };
  return preview;
}

/** Format-specific convenience exports use the same validation and repeat policy. */
export const previewJunitImport = (source: string, options: ImportOptions): ImportPreview =>
  previewImport('junit', source, options);
export const previewCsvImport = (source: string, options: ImportOptions): ImportPreview =>
  previewImport('csv', source, options);
export const previewTracefoldJsonImport = (source: string, options: ImportOptions): ImportPreview =>
  previewImport('tracefold-json', source, options);
