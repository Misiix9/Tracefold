import { describe, expect, it } from 'vitest';
import { emptyDoc, emptyEnvironment } from './defaults';
import {
  importFingerprint,
  parseCsv,
  previewCsvImport,
  previewImport,
  previewJunitImport,
  previewTracefoldJsonImport,
  protectSpreadsheetCell,
} from './imports';
import type { ImportOptions, ImportPreview } from './imports';
import type { ExecutionSnapshot, RunSnapshot } from './testing';
import type { Entity, Outcome } from './types';

const at = '2026-09-09T10:00:00.000Z';
const options: ImportOptions = { filename: 'results.xml', importedAt: at };
const codes = (preview: ImportPreview) => preview.issues.map((issue) => issue.code);
function historicalExecution(id = 'original-execution'): ExecutionSnapshot {
  return {
    id,
    caseId: 'original-case',
    caseTitle: 'Original case title',
    caseRevision: 7,
    prerequisites: 'Original setup',
    steps: [{ id: 'original-step', action: 'Original action', expected: 'Original expectation' }],
    requirementIds: ['original-requirement'],
    datasetId: 'original-dataset',
    dataset: { name: 'Original dataset', values: { locale: 'hu-HU' } },
    outcome: 'failed',
    reason: '',
    notes: 'Original failure',
    stepResults: { 'original-step': 'failed' },
    stepReasons: {},
    findingIds: ['original-finding'],
    evidenceIds: ['original-evidence'],
    updatedAt: '2026-08-01T10:00:00Z',
    durationMs: 25,
  };
}
function historicalRun(): RunSnapshot {
  return {
    state: 'completed',
    environment: { ...emptyEnvironment(), build: 'original-build', extra: { theme: 'dark' } },
    executions: [historicalExecution()],
    conclusion: 'Original conclusion',
    exclusions: 'Original exclusion',
    startedAt: '2026-08-01T09:00:00Z',
    completedAt: '2026-08-01T11:00:00Z',
  };
}
function runRecord(id = 'run'): Entity<'run'> {
  return {
    id,
    kind: 'run',
    projectId: 'original-project',
    title: 'Historical run',
    data: historicalRun(),
    body: emptyDoc(),
    tags: ['original'],
    revision: 4,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

describe('JUnit preview', () => {
  const junit = `<?xml version="1.0" encoding="UTF-8"?>
    <testsuites name="CI" tests="4" failures="1" errors="1" skipped="1">
      <testsuite name="Core" tests="3" time="1.25">
        <properties><property name="branch" value="main"/></properties>
        <testcase name="loads &amp; saves" classname="Record" time="0.125"><system-out><![CDATA[<b>plain log</b>]]></system-out></testcase>
        <testcase name="persists" classname="Record" time="0"><failure message="Expected saved value">line 12 &lt;detail&gt;</failure></testcase>
        <testcase name="offline" classname="Record"><skipped message="Fixture unavailable"/></testcase>
      </testsuite>
      <testsuite name="Backend" tests="1"><testsuite name="Storage"><testcase name="opens"><error message="Database unavailable"/></testcase></testsuite></testsuite>
    </testsuites>`;

  it('maps nested suites, assertion failures, errors, skipped reasons, entities, log text and seconds', () => {
    const preview = previewJunitImport(junit, options);
    expect(preview.issues).toEqual([]);
    expect(preview.canImport).toBe(true);
    expect(preview.summary).toMatchObject({
      total: 4,
      outcomes: { passed: 1, failed: 2, skipped: 1 },
      passRate: { numerator: 1, denominator: 3 },
    });
    expect(preview.executions[0]).toMatchObject({
      caseTitle: 'loads & saves',
      durationMs: 125,
      notes: 'system-out:\n<b>plain log</b>',
    });
    expect(preview.executions[1]).toMatchObject({
      outcome: 'failed',
      durationMs: 0,
      reason: 'Expected saved value\nline 12 <detail>',
    });
    expect(preview.executions[2].reason).toBe('Fixture unavailable');
    expect(preview.identities[3].suite).toBe('CI / Backend / Storage');
    expect(preview.run?.source).toEqual({
      format: 'junit',
      filename: options.filename,
      fingerprint: preview.fingerprint,
      importedAt: at,
    });
    expect(preview.run?.state).toBe('completed');
  });

  it('preserves repeated names as separate deterministic execution identities', () => {
    const xml =
      '<testsuite name="suite"><testcase classname="A" name="same"/><testcase classname="A" name="same"/><testcase classname="B" name="same"/></testsuite>';
    const one = previewJunitImport(xml, options),
      two = previewJunitImport(xml, options);
    expect(one).toEqual(two);
    expect(one.executions).toHaveLength(3);
    expect(new Set(one.executions.map((execution) => execution.id)).size).toBe(3);
    expect(one.executions[0].caseId).toBe(one.executions[1].caseId);
    expect(one.executions[2].caseId).not.toBe(one.executions[0].caseId);
  });

  it('requires actual explanations for skipped/blocked results, with explicit user fallbacks', () => {
    const xml = '<testsuite><testcase name="not available"><skipped/></testcase></testsuite>';
    const blocked = previewJunitImport(xml, options);
    expect(blocked.canImport).toBe(false);
    expect(blocked.run).toBeNull();
    expect(codes(blocked)).toContain('REASON_REQUIRED');
    const allowed = previewJunitImport(xml, {
      ...options,
      fallbackReasons: { skipped: 'Runner has no device attached' },
    });
    expect(allowed.canImport).toBe(true);
    expect(allowed.executions[0].reason).toBe('Runner has no device attached');
    expect(
      previewJunitImport(
        '<testsuite><testcase name="blocked" status="blocked"/></testsuite>',
        options,
      ).canImport,
    ).toBe(false);
  });

  it.each([
    '<testsuite><testcase name="x"></testsuite>',
    '<testsuite><testcase name="x"/></testsuite><testsuite/>',
    '<testcase name="x"/>',
    '<html><testcase name="x"/></html>',
    '<testsuite><testcase name="x"><script>bad()</script></testcase></testsuite>',
    '<testsuite><testcase name="x" status="mystery"/></testsuite>',
    '<testsuite><testcase name="x" result="unknown"/></testsuite>',
    '<testsuite><testcase name="x"><failure/><skipped message="no"/></testcase></testsuite>',
    '<testsuite><testcase name="x" status="passed"><failure/></testcase></testsuite>',
    '<testsuite><testcase name="x" result="passed"><error/></testcase></testsuite>',
    '<testsuite><testcase/></testsuite>',
  ])('blocks malformed or ambiguous results rather than claiming success: %s', (xml) => {
    const preview = previewJunitImport(xml, options);
    expect(preview.canImport).toBe(false);
    expect(preview.run).toBeNull();
    expect(preview.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it.each([
    '',
    ' \n\t',
    '<?xml version="1.0"?><testsuite tests="0"/>',
    '<testsuites/>',
    '<!-- no results -->',
    '<testsuite tests="0"><properties><property name="pass" value="true"/></properties></testsuite>',
  ])('never reports empty XML as successful: %s', (source) => {
    const preview = previewJunitImport(source, options);
    expect(preview.canImport).toBe(false);
    expect(preview.summary.total).toBe(0);
    expect(preview.summary.passRate.value).toBeNull();
  });

  it.each([
    '<!DOCTYPE testsuite SYSTEM "file:///etc/passwd"><testsuite><testcase name="x"/></testsuite>',
    '<!DOCTYPE testsuite [<!ENTITY steal SYSTEM "https://example.invalid/secret">]><testsuite><testcase name="&steal;"/></testsuite>',
    '<!DOCTYPE testsuite [<!ENTITY a "ha"><!ENTITY b "&a;&a;&a;&a;">]><testsuite><testcase name="&b;"/></testsuite>',
    '<testsuite><testcase name="&unknown;"/></testsuite>',
    '<testsuite><testcase name="&#0;"/></testsuite>',
    '<testsuite><testcase name="&#x110000;"/></testsuite>',
    '<testsuite><testcase name="\u0000"/></testsuite>',
    '<testsuite><testcase name="\uD800"/></testsuite>',
    `${'<testsuite>'.repeat(66)}<testcase name="deep"/>${'</testsuite>'.repeat(66)}`,
    '<testsuite xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd"/></testsuite>',
  ])('rejects hostile XML without resolving external resources', (xml) => {
    const preview = previewJunitImport(xml, options);
    expect(preview.canImport).toBe(false);
    expect(preview.run).toBeNull();
  });

  it.each(['NaN', 'Infinity', '-1', '1ms', '1e309', '0x10', '', '9007199254741'])(
    'rejects invalid testcase time %s',
    (duration) => {
      const preview = previewJunitImport(
        `<testsuite><testcase name="x" time="${duration}"/></testsuite>`,
        options,
      );
      expect(preview.canImport).toBe(false);
      expect(codes(preview)).toContain('INVALID_NUMBER');
    },
  );

  it.each([
    '<testsuite tests="2"><testcase name="x"/></testsuite>',
    '<testsuite failures="1"><testcase name="x"/></testsuite>',
    '<testsuite errors="1"><testcase name="x"/></testsuite>',
    '<testsuite skipped="1"><testcase name="x"/></testsuite>',
    '<testsuite tests="1.5"><testcase name="x"/></testsuite>',
    '<testsuite time="-2"><testcase name="x"/></testsuite>',
  ])('rejects incomplete or invalid suite totals: %s', (xml) => {
    expect(previewJunitImport(xml, options).canImport).toBe(false);
  });
});

describe('CSV mapping and text safety', () => {
  it('handles quoted commas, doubled quotes, multiline notes and Windows line endings', () => {
    const csv =
      '\uFEFFtitle,outcome,reason,notes,duration_ms\r\n"Save, then reload",passed,,"line 1\r\nline 2 says ""saved""",0\r\n"Offline",blocked,"No device, yet",,12.5\r\n';
    const preview = previewCsvImport(csv, { ...options, filename: 'results.csv' });
    expect(preview.issues).toEqual([]);
    expect(preview.canImport).toBe(true);
    expect(preview.executions).toHaveLength(2);
    expect(preview.executions[0]).toMatchObject({
      caseTitle: 'Save, then reload',
      notes: 'line 1\nline 2 says "saved"',
      durationMs: 0,
    });
    expect(preview.executions[1]).toMatchObject({ reason: 'No device, yet', durationMs: 12.5 });
    expect(preview.identities.map((row) => row.sourceRow)).toEqual([2, 4]);
  });

  it('supports explicit named/zero-based mapping, custom statuses, seconds and alternate delimiters', () => {
    const csv =
      'Scenario;Verdict;Seconds;Explanation;External ID\nCheckout;OK;.25;;C-7\nCheckout;WAIT;0;Environment maintenance;C-7';
    const preview = previewCsvImport(csv, {
      ...options,
      delimiter: ';',
      csvMapping: {
        title: 0,
        outcome: 'Verdict',
        durationSeconds: 2,
        reason: 'Explanation',
        caseId: 4,
      },
      outcomeValues: { OK: 'passed', WAIT: 'blocked' },
    });
    expect(preview.canImport).toBe(true);
    expect(preview.executions[0]).toMatchObject({
      caseId: 'C-7',
      outcome: 'passed',
      durationMs: 250,
    });
    expect(preview.executions[1].outcome).toBe('blocked');
    expect(preview.executions[0].id).not.toBe(preview.executions[1].id);
  });

  it.each([
    '=HYPERLINK("https://example.invalid","click")',
    '+SUM(A1:A2)',
    '-cmd',
    '@SUM(1)',
    '  =1+1',
    '\t=1+1',
    '\r=1',
    '\n=1',
  ])('keeps %s inert and provides protected spreadsheet text', (value) => {
    expect(protectSpreadsheetCell(value)).toBe(`'${value}`);
    const quoted = `"${value.replace(/"/g, '""')}"`;
    const preview = previewCsvImport(`title,outcome,notes\n${quoted},passed,${quoted}`, options);
    expect(preview.canImport).toBe(true);
    expect(codes(preview)).toContain('FORMULA_TEXT');
    expect(preview.executions[0].caseTitle).toBe(value.replace(/\r\n?/g, '\n'));
    expect(preview.spreadsheetRows[1][0]).toBe(`'${value.replace(/\r\n?/g, '\n')}`);
  });

  it('does not change harmless text or treat an HTML-looking title as markup', () => {
    expect(protectSpreadsheetCell('A normal title')).toBe('A normal title');
    const preview = previewCsvImport('title,outcome\n<img src=x onerror=bad()>,passed', options);
    expect(preview.executions[0].caseTitle).toBe('<img src=x onerror=bad()>');
    expect(preview.canImport).toBe(true);
  });

  it.each([
    'title,outcome\n"unterminated,passed',
    'title,outcome\nwrong"quote,passed',
    'title,outcome\n"closed"junk,passed',
    'title,outcome\none,passed,extra',
    'title,outcome\none',
    'title,title\none,passed',
    'title,\none,passed',
    'title,outcome\n,passed',
    'title,outcome\none,unknown',
    'title,outcome\none,',
    'title,outcome\none,skipped',
    'title,outcome\none,blocked',
    'title,outcome',
    '',
    'title,outcome\n,,',
  ])('blocks malformed, empty or unexplained CSV: %s', (csv) => {
    const preview = previewCsvImport(csv, options);
    expect(preview.canImport).toBe(false);
    expect(preview.run).toBeNull();
  });

  it.each(['-1', 'NaN', 'Infinity', '1s', '1e999', '0xA'])(
    'rejects invalid CSV duration %s',
    (duration) => {
      const preview = previewCsvImport(`title,outcome,duration_ms\nA,passed,${duration}`, options);
      expect(preview.canImport).toBe(false);
      expect(codes(preview)).toContain('INVALID_NUMBER');
    },
  );

  it('exposes mapping errors and never silently imports only the valid part of a file', () => {
    expect(codes(previewCsvImport('Scenario,Verdict\nA,passed', options))).toContain(
      'MAPPING_REQUIRED',
    );
    expect(
      codes(
        previewCsvImport('title,outcome\nA,passed', {
          ...options,
          csvMapping: { title: 'missing', outcome: 'outcome' },
        }),
      ),
    ).toContain('UNKNOWN_COLUMN');
    expect(
      codes(
        previewCsvImport('title,outcome\nA,passed', {
          ...options,
          csvMapping: { title: 0, outcome: 0 },
        }),
      ),
    ).toContain('DUPLICATE_MAPPING');
    const partial = previewCsvImport('title,outcome\nA,passed\nB,unknown\nC,failed', options);
    expect(partial.canImport).toBe(false);
    expect(partial.summary).toMatchObject({ total: 2, outcomes: { passed: 1, failed: 1 } });
    expect(partial.issues.find((issue) => issue.code === 'INVALID_OUTCOME')?.row).toBe(3);
  });

  it('does not silently merge ambiguous duration columns and rejects out-of-bounds mapping indexes', () => {
    expect(
      codes(previewCsvImport('title,outcome,duration_ms,time\nA,passed,2,3', options)),
    ).toContain('AMBIGUOUS_DURATION');
    for (const index of [-1, 0.5, 100])
      expect(
        previewCsvImport('title,outcome\nA,passed', {
          ...options,
          csvMapping: { title: index, outcome: 1 },
        }).canImport,
      ).toBe(false);
    expect(parseCsv('a,b\n1,2', '|' as ',').issues[0].code).toBe('INVALID_DELIMITER');
  });
});

describe('versioned Tracefold JSON', () => {
  it('previews a historical run without rewriting its snapshots, environment or original record', () => {
    const original = runRecord();
    const source = JSON.stringify({ schemaVersion: 1, records: [original], generatedAt: at });
    const preview = previewTracefoldJsonImport(source, options);
    expect(preview.issues).toEqual([]);
    expect(preview.canImport).toBe(true);
    expect(preview.records).toEqual([original]);
    expect(preview.executions).toEqual(original.data.executions);
    expect(preview.run?.environment).toEqual(original.data.environment);
    expect(preview.run?.startedAt).toBe(original.data.startedAt);
    expect(preview.run?.source?.fingerprint).toBe(preview.fingerprint);
    preview.executions[0].steps[0].action = 'Changed preview';
    expect(preview.records[0]).toEqual(original);
    expect(preview.run?.executions[0].steps[0].action).toBe('Original action');
    expect(source).toBe(JSON.stringify({ schemaVersion: 1, records: [original], generatedAt: at }));
  });

  it('supports run and execution envelopes, and preserves multiple run environments instead of flattening history', () => {
    expect(
      previewTracefoldJsonImport(
        JSON.stringify({ schemaVersion: 1, run: historicalRun() }),
        options,
      ).canImport,
    ).toBe(true);
    expect(
      previewTracefoldJsonImport(
        JSON.stringify({ schemaVersion: 1, executions: [historicalExecution()] }),
        options,
      ).canImport,
    ).toBe(true);
    const second = runRecord('second');
    second.data.environment.build = 'another-build';
    const preview = previewTracefoldJsonImport(
      JSON.stringify({ schemaVersion: 1, records: [runRecord(), second] }),
      options,
    );
    expect(preview.canImport).toBe(true);
    expect(preview.records).toHaveLength(2);
    expect(preview.summary.total).toBe(2);
    expect(preview.run).toBeNull();
  });

  it('accepts a real document-only JSON handoff while rejecting empty record arrays', () => {
    const record: Entity<'document'> = {
      ...runRecord(),
      kind: 'document',
      data: { evidenceIds: [], private: false, fields: { reviewed: false, count: 0 } },
    };
    const preview = previewTracefoldJsonImport(
      JSON.stringify({ schemaVersion: 1, records: [record] }),
      options,
    );
    expect(preview.canImport).toBe(true);
    expect(preview.records).toHaveLength(1);
    expect(preview.run).toBeNull();
    expect(previewTracefoldJsonImport('{"schemaVersion":1,"records":[]}', options).canImport).toBe(
      false,
    );
  });

  it('rejects empty run records and inconsistent completion history', () => {
    const record = runRecord();
    record.data.executions = [];
    expect(
      codes(
        previewTracefoldJsonImport(
          JSON.stringify({ schemaVersion: 1, records: [record] }),
          options,
        ),
      ),
    ).toContain('NO_RESULTS');
    const invalidRuns = [
      { ...historicalRun(), completedAt: undefined },
      { ...historicalRun(), state: 'active' },
      { ...historicalRun(), completedAt: '2026-07-01T10:00:00Z' },
      { ...historicalRun(), executions: [{ ...historicalExecution(), updatedAt: at }] },
    ];
    for (const run of invalidRuns)
      expect(
        codes(previewTracefoldJsonImport(JSON.stringify({ schemaVersion: 1, run }), options)),
      ).toContain('INVALID_RUN_HISTORY');
  });

  it('preserves execution-only timestamps and produces a run that passes its own history validation', () => {
    const preview = previewTracefoldJsonImport(
      JSON.stringify({ schemaVersion: 1, executions: [historicalExecution()] }),
      options,
    );
    expect(preview.canImport).toBe(true);
    expect(preview.run?.startedAt).toBe(historicalExecution().updatedAt);
    expect(
      previewTracefoldJsonImport(JSON.stringify({ schemaVersion: 1, run: preview.run }), options)
        .canImport,
    ).toBe(true);
  });

  it.each([
    '{}',
    'null',
    '[]',
    '{"schemaVersion":2,"records":[]}',
    '{"schemaVersion":1}',
    '{"schemaVersion":1,"records":[],"run":{}}',
    '{"schemaVersion":1,"executions":[{}]}',
    '{"schemaVersion":1,"records":[{"kind":"mystery"}]}',
    '{broken',
    '{"schemaVersion":1,"run":{"state":"completed"}}',
  ])('rejects unsupported/malformed schemas: %s', (json) => {
    expect(previewTracefoldJsonImport(json, options).canImport).toBe(false);
  });

  it.each([
    '{"schemaVersion":1,"executions":[],"__proto__":{"polluted":true}}',
    '{"schemaVersion":1,"executions":[],"constructor":{"prototype":{"polluted":true}}}',
    '{"schemaVersion":1,"executions":[],"value":1e999}',
  ])('rejects prototype pollution and nonfinite JSON values', (json) => {
    const preview = previewTracefoldJsonImport(json, options);
    expect(preview.canImport).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('blocks active rich content and dangerous links', () => {
    const record = runRecord();
    record.body = {
      type: 'doc',
      content: [
        {
          type: 'text',
          text: 'Click',
          marks: [{ type: 'link', attrs: { href: ' java\nscript:alert(1)' } }],
        },
      ],
    };
    expect(
      codes(
        previewTracefoldJsonImport(
          JSON.stringify({ schemaVersion: 1, records: [record] }),
          options,
        ),
      ),
    ).toContain('UNSAFE_JSON');
    record.body = { type: 'script', text: 'alert(1)' };
    expect(
      previewTracefoldJsonImport(JSON.stringify({ schemaVersion: 1, records: [record] }), options)
        .canImport,
    ).toBe(false);
  });

  it('validates duplicate identities, status values, numeric fields, and step reasons in imported snapshots', () => {
    const first = historicalExecution();
    const preview = (executions: unknown[]) =>
      previewTracefoldJsonImport(JSON.stringify({ schemaVersion: 1, executions }), options);
    expect(codes(preview([first, first]))).toContain('DUPLICATE_EXECUTION');
    expect(preview([{ ...first, outcome: 'unknown' as Outcome }]).canImport).toBe(false);
    expect(preview([{ ...first, durationMs: -5 }]).canImport).toBe(false);
    expect(preview([{ ...first, caseRevision: 1.5 }]).canImport).toBe(false);
    expect(codes(preview([{ ...first, stepResults: { 'original-step': 'blocked' } }]))).toContain(
      'REASON_REQUIRED',
    );
    expect(
      preview([
        {
          ...first,
          stepResults: { 'original-step': 'blocked' },
          stepReasons: { 'original-step': 'Unavailable prerequisite' },
        },
      ]).canImport,
    ).toBe(true);
    expect(codes(preview([{ ...first, stepResults: { alien: 'passed' } }]))).toContain(
      'UNKNOWN_STEP',
    );
    expect(codes(preview([{ ...first, stepReasons: { alien: 'why' } }]))).toContain('UNKNOWN_STEP');
    expect(
      codes(
        previewTracefoldJsonImport(
          JSON.stringify({ schemaVersion: 1, records: [runRecord(), runRecord()] }),
          options,
        ),
      ),
    ).toContain('DUPLICATE_RECORD');
  });

  it('rejects unknown record fields instead of discarding data silently', () => {
    const preview = previewTracefoldJsonImport(
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...runRecord(), unexpected: 'important data' }],
      }),
      options,
    );
    expect(preview.canImport).toBe(false);
    expect(codes(preview)).toContain('UNKNOWN_JSON_FIELD');
  });
});

describe('repeat imports and bounded previews', () => {
  it('fingerprints normalized content independently of filename, time or CSV mapping', () => {
    const csv = 'title,outcome\nA,passed\n';
    expect(importFingerprint('csv', csv)).toBe(
      importFingerprint('csv', `\uFEFF${csv.replace(/\n/g, '\r\n')}`),
    );
    expect(importFingerprint('junit', csv)).not.toBe(importFingerprint('csv', csv));
    const initial = previewCsvImport(csv, options);
    const repeated = previewCsvImport(csv, {
      ...options,
      filename: 'renamed.csv',
      importedAt: '2026-09-10T10:00:00Z',
      existingFingerprints: [initial.fingerprint],
      csvMapping: { title: 0, outcome: 1 },
    });
    expect(repeated).toMatchObject({
      duplicate: true,
      canImport: false,
      requiresRepeatConfirmation: true,
      run: null,
    });
    expect(repeated.executions).toHaveLength(1);
    expect(codes(repeated)).toContain('REPEAT_IMPORT');
    const allowed = previewCsvImport(csv, {
      ...options,
      existingFingerprints: [initial.fingerprint],
      repeatPolicy: 'allow',
    });
    expect(allowed).toMatchObject({
      duplicate: true,
      canImport: true,
      requiresRepeatConfirmation: false,
    });
    expect(allowed.run).not.toBeNull();
  });

  it('still rejects malformed content when a repeat is allowed', () => {
    const xml = '<testsuite/>';
    const initial = previewJunitImport(xml, options);
    expect(
      previewJunitImport(xml, {
        ...options,
        existingFingerprints: [initial.fingerprint],
        repeatPolicy: 'allow',
      }).canImport,
    ).toBe(false);
  });

  it('bounds input, rejects invalid timestamps and exposes unsupported formats', () => {
    expect(codes(previewCsvImport('x'.repeat(5_000_001), options))).toContain('INPUT_TOO_LARGE');
    expect(
      codes(previewCsvImport('title,outcome\nA,passed', { ...options, importedAt: 'not a date' })),
    ).toContain('INVALID_TIMESTAMP');
    expect(codes(previewImport('unknown' as 'csv', 'some content', options))).toContain(
      'UNSUPPORTED_FORMAT',
    );
  });
});
