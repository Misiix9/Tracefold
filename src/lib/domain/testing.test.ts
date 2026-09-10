import { describe, expect, it } from 'vitest';
import { emptyDoc, emptyEnvironment } from './defaults';
import {
  appendFindingRetest,
  createExecutionSnapshots,
  createRunSnapshot,
  getFindingVerification,
  getRequirementsCoverage,
  getRunCounts,
  isValidInstant,
  transitionFinding,
  updateExecution,
  updateRunExecution,
  updateRunStep,
  updateStepOutcome,
} from './testing';
import type { ExecutionSnapshot, ValidationResult } from './testing';
import type {
  DataMap,
  Entity,
  EntityKind,
  FindingData,
  Outcome,
  Retest,
  RunData,
  TemplateData,
} from './types';
import {
  BUILT_IN_TEMPLATES,
  getBuiltInTemplates,
  templateBody,
  validateTemplateValues,
} from './templates';

const at = '2026-09-09T10:00:00.000Z';
const later = '2026-09-10T10:00:00.000Z';
const unwrap = <T>(result: ValidationResult<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
};
function entity<K extends EntityKind>(
  kind: K,
  id: string,
  data: DataMap[K],
  projectId = 'project',
): Entity<K> {
  return {
    kind,
    id,
    projectId,
    title: id,
    body: emptyDoc(),
    data,
    tags: [],
    revision: 3,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}
function testCase(id = 'case'): Entity<'case'> {
  return entity('case', id, {
    prerequisites: 'Signed in as editor',
    steps: [
      { id: 'open', action: 'Open the record', expected: 'Record is visible' },
      { id: 'save', action: 'Save the change', expected: 'Change persists' },
    ],
    folder: 'Core',
    requirementIds: ['req'],
    datasets: [],
    priority: 'high',
    automated: false,
  });
}
function execution(): ExecutionSnapshot {
  return unwrap(createExecutionSnapshots([testCase()], { runId: 'run', at }))[0];
}
function finding(): FindingData {
  return {
    code: 'TF-1',
    status: 'open',
    severity: 'major',
    priority: 'high',
    type: 'defect',
    steps: ['Save the change'],
    expected: 'Change persists',
    actual: 'Change disappears',
    impact: 'Lost work',
    environment: { ...emptyEnvironment(), build: 'original' },
    frequency: '2 / 2',
    suspectedCause: 'Write race',
    confirmedCause: '',
    workaround: '',
    resolution: '',
    relatedIds: [],
    evidenceIds: ['original-screenshot'],
    caseIds: ['case'],
    retests: [],
    owner: 'Tester',
    component: 'Records',
  };
}
const retest = (outcome: Outcome = 'passed'): Retest => ({
  id: 'retest-1',
  at: later,
  environment: { ...emptyEnvironment(), build: 'fixed' },
  outcome,
  notes: 'Repeated original steps',
  evidenceIds: ['new-screenshot'],
});
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('execution snapshots and validation', () => {
  it('freezes historical case revisions, datasets, requirement links, steps and environment by value', () => {
    const source = testCase();
    source.data.datasets = [
      { id: 'en', name: 'English', values: { locale: 'en-GB' } },
      { id: 'hu', name: 'Hungarian', values: { locale: 'hu-HU' } },
    ];
    const environment = { ...emptyEnvironment(), build: '1.0', extra: { theme: 'dark' } };
    const run = unwrap(createRunSnapshot([source], environment, { runId: 'historical', at }));
    const original = structuredClone(run);
    source.title = 'Edited title';
    source.revision = 4;
    source.data.steps[0].action = 'Different action';
    source.data.prerequisites = 'Administrator';
    source.data.requirementIds.push('new-requirement');
    source.data.datasets[0].values.locale = 'de-DE';
    source.data.datasets[1].name = 'Renamed';
    environment.build = '2.0';
    environment.extra.theme = 'light';
    expect(run).toEqual(original);
    expect(run.executions.map((item) => item.datasetId)).toEqual(['en', 'hu']);
    expect(run.executions.map((item) => item.caseRevision)).toEqual([3, 3]);
    expect(run.executions[0].stepResults).toEqual({ open: 'not_run', save: 'not_run' });
    run.executions[0].steps[0].expected = 'Only this result changes';
    expect(run.executions[1].steps[0].expected).toBe('Record is visible');
  });

  it('creates one execution without datasets and deterministic distinct IDs for awkward case/dataset IDs', () => {
    const source = testCase('case:a/b');
    expect(createExecutionSnapshots([source], { runId: 'run:a', at })).toEqual(
      createExecutionSnapshots([source], { runId: 'run:a', at }),
    );
    const initial = unwrap(createExecutionSnapshots([source], { runId: 'run:a', at }));
    expect(initial).toHaveLength(1);
    expect(initial[0].dataset).toBeUndefined();
    source.data.datasets = [
      { id: 'a:b', name: 'Same name', values: {} },
      { id: 'a/b', name: 'Same name', values: {} },
    ];
    const snapshots = unwrap(createExecutionSnapshots([source], { runId: 'run:a', at }));
    expect(new Set(snapshots.map((item) => item.id)).size).toBe(2);
    expect(snapshots[0].id).not.toBe(
      unwrap(createExecutionSnapshots([source], { runId: 'other', at }))[0].id,
    );
  });

  it('rejects empty runs, duplicate/deleted cases, mixed projects and duplicate nested IDs', () => {
    expect(createExecutionSnapshots([], { runId: 'run', at }).ok).toBe(false);
    const source = testCase();
    expect(createExecutionSnapshots([source, source], { runId: 'run', at }).ok).toBe(false);
    source.deletedAt = at;
    expect(createExecutionSnapshots([source], { runId: 'run', at }).ok).toBe(false);
    source.deletedAt = null;
    source.data.steps.push({ ...source.data.steps[0] });
    expect(createExecutionSnapshots([source], { runId: 'run', at }).ok).toBe(false);
    const other = testCase('other');
    other.projectId = 'other-project';
    expect(createExecutionSnapshots([testCase(), other], { runId: 'run', at }).ok).toBe(false);
    const duplicateDataset = testCase();
    duplicateDataset.data.datasets = [
      { id: 'x', name: 'A', values: {} },
      { id: 'x', name: 'B', values: {} },
    ];
    expect(createExecutionSnapshots([duplicateDataset], { runId: 'run', at }).ok).toBe(false);
  });

  it.each(['blocked', 'skipped'] as Outcome[])(
    'requires an explicit reason for %s and does not reuse an unrelated previous reason',
    (outcome) => {
      const source = execution();
      expect(updateExecution(source, { outcome, reason: '  ' }, later).ok).toBe(false);
      const updated = unwrap(
        updateExecution(source, { outcome, reason: 'Service unavailable' }, later),
      );
      expect(updated.reason).toBe('Service unavailable');
      expect(source.outcome).toBe('not_run');
      const other = outcome === 'blocked' ? 'skipped' : 'blocked';
      expect(updateExecution(updated, { outcome: other }, later).ok).toBe(false);
      expect(unwrap(updateExecution(updated, { notes: 'Follow-up' }, later)).reason).toBe(
        'Service unavailable',
      );
      expect(updateExecution(updated, { reason: '' }, later).ok).toBe(false);
    },
  );

  it('updates detached results and deduplicates repeated links to the same finding', () => {
    const source = freeze(execution());
    const changed = unwrap(
      updateExecution(
        source,
        {
          outcome: 'failed',
          findingIds: ['finding', 'finding'],
          evidenceIds: ['shot', 'shot'],
          notes: 'Observed failure',
          durationMs: 0,
        },
        later,
      ),
    );
    expect(changed.findingIds).toEqual(['finding']);
    expect(changed.evidenceIds).toEqual(['shot']);
    expect(changed.durationMs).toBe(0);
    expect(changed.caseRevision).toBe(source.caseRevision);
    expect(source.outcome).toBe('not_run');
    expect(source.findingIds).toEqual([]);
    changed.steps[0].action = 'Attempted history change';
    expect(source.steps[0].action).toBe('Open the record');
    expect(updateExecution(source, { caseTitle: 'Rewrite' } as never, later).ok).toBe(false);
    expect(updateExecution(source, { outcome: 'unknown' as Outcome }, later).ok).toBe(false);
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid duration %s',
    (durationMs) => {
      expect(updateExecution(execution(), { durationMs }, later).ok).toBe(false);
    },
  );

  it('preserves independent step reasons and requires known snapshot step IDs', () => {
    const source = freeze(execution());
    expect(updateStepOutcome(source, 'open', 'blocked', '', later).ok).toBe(false);
    expect(updateStepOutcome(source, 'missing', 'passed', '', later).ok).toBe(false);
    const first = unwrap(
      updateStepOutcome(source, 'open', 'blocked', 'Record cannot be loaded', later),
    );
    const second = unwrap(
      updateStepOutcome(first, 'save', 'skipped', 'Prerequisite blocked', later),
    );
    expect(second.stepReasons).toEqual({
      open: 'Record cannot be loaded',
      save: 'Prerequisite blocked',
    });
    expect(second.stepResults).toEqual({ open: 'blocked', save: 'skipped' });
    expect(second.outcome).toBe('not_run');
    expect(first.stepResults.save).toBe('not_run');
    expect(unwrap(updateStepOutcome(second, 'open', 'passed', '', later)).stepReasons?.open).toBe(
      '',
    );
  });

  it('validates run-scoped identity and rejects all updates to completed runs', () => {
    const run = unwrap(createRunSnapshot([testCase()], emptyEnvironment(), { runId: 'run', at }));
    const id = run.executions[0].id;
    const updated = unwrap(updateRunExecution(freeze(run), id, { outcome: 'passed' }, later));
    expect(updated.executions[0].outcome).toBe('passed');
    expect(run.executions[0].outcome).toBe('not_run');
    expect(updateRunExecution(run, 'missing', {}, later).ok).toBe(false);
    const completed: RunData = { ...updated, state: 'completed', completedAt: later };
    expect(updateRunExecution(completed, id, { outcome: 'failed' }, later).ok).toBe(false);
    expect(updateRunStep(completed, id, 'open', 'failed', '', later).ok).toBe(false);
  });

  it.each([
    '',
    '2026-02-30T10:00:00Z',
    '2026-09-09',
    '2026-09-09T24:00:00Z',
    '2026-09-09T10:00:00',
    'junk',
  ])('rejects invalid or ambiguous instant %s', (timestamp) => {
    expect(isValidInstant(timestamp)).toBe(false);
    expect(updateExecution(execution(), {}, timestamp).ok).toBe(false);
  });
  it('rejects stale updates while accepting explicit timezone offsets', () => {
    expect(updateExecution(execution(), {}, '2026-09-08T10:00:00Z').ok).toBe(false);
    expect(isValidInstant('2026-09-09T12:00:00+02:00')).toBe(true);
  });
});

describe('counts and requirements coverage', () => {
  it('reports each status and a pass/fail-only denominator', () => {
    const counts = getRunCounts(
      ['passed', 'passed', 'failed', 'blocked', 'skipped', 'not_run'].map((outcome) => ({
        outcome: outcome as Outcome,
      })),
    );
    expect(counts).toMatchObject({
      total: 6,
      completed: 5,
      evaluated: 3,
      remaining: 1,
      outcomes: { passed: 2, failed: 1, blocked: 1, skipped: 1, not_run: 1 },
      passRate: { numerator: 2, denominator: 3, value: 2 / 3 },
    });
    expect(getRunCounts([]).passRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(getRunCounts([{ outcome: 'skipped' }]).passRate.value).toBeNull();
    expect(() => getRunCounts([{ outcome: 'bogus' as Outcome }])).toThrow();
  });

  it('shows unlinked requirements, missing dataset executions, and orphan links without a synthetic score', () => {
    const required = entity('requirement', 'req', {
      code: 'REQ-1',
      description: '',
      acceptanceCriteria: 'Save works',
      priority: 'high',
      owner: '',
    });
    const uncovered = { ...required, id: 'uncovered', title: 'No cases' };
    const source = testCase();
    source.data.requirementIds.push('missing');
    source.data.datasets = [
      { id: 'a', name: 'A', values: { role: 'editor' } },
      { id: 'b', name: 'B', values: { role: 'viewer' } },
    ];
    const data = unwrap(createRunSnapshot([source], emptyEnvironment(), { runId: 'r', at }));
    data.executions = [{ ...data.executions[0], outcome: 'passed' }];
    const report = getRequirementsCoverage(
      [required, uncovered],
      [source],
      [entity('run', 'r', data)],
    );
    expect(report.linked).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(report.tested.numerator).toBe(1);
    expect(report.passed.numerator).toBe(0);
    expect(report.requirements[0]).toMatchObject({
      status: 'partial',
      counts: { total: 2, outcomes: { passed: 1, not_run: 1 } },
      gaps: [{ code: 'DATASET_NOT_RUN', caseId: source.id }],
    });
    expect(report.requirements[1].gaps[0].code).toBe('NO_LINKED_CASES');
    expect(report.orphanLinks).toEqual([{ caseId: source.id, requirementId: 'missing' }]);
  });

  it('never credits an older case revision or a changed dataset with a current pass', () => {
    const source = testCase();
    const required = entity('requirement', 'req', {
      code: 'REQ',
      description: '',
      acceptanceCriteria: '',
      priority: 'normal',
      owner: '',
    });
    const data = unwrap(createRunSnapshot([source], emptyEnvironment(), { runId: 'r', at }));
    data.executions[0].outcome = 'passed';
    const stored = structuredClone(data);
    source.revision++;
    const report = getRequirementsCoverage([required], [source], [entity('run', 'r', data)]);
    expect(report.requirements[0].status).toBe('not_run');
    expect(report.requirements[0].gaps[0].code).toBe('STALE_EXECUTION');
    expect(data).toEqual(stored);
    source.data.datasets = [{ id: 'added', name: 'New dataset', values: { key: 'new value' } }];
    expect(
      getRequirementsCoverage([required], [source], [entity('run', 'r', data)]).requirements[0]
        .gaps[0].code,
    ).toBe('DATASET_NOT_RUN');
  });

  it.each(['failed', 'blocked', 'skipped', 'not_run', 'passed'] as Outcome[])(
    'uses the newest run outcome %s and retains historical runs',
    (outcome) => {
      const source = testCase(),
        required = entity('requirement', 'req', {
          code: '',
          description: '',
          acceptanceCriteria: '',
          priority: 'normal',
          owner: '',
        });
      const old = unwrap(createRunSnapshot([source], emptyEnvironment(), { runId: 'old', at }));
      old.executions[0].outcome = 'passed';
      old.executions[0].updatedAt = '2026-10-01T10:00:00Z';
      const recent = unwrap(
        createRunSnapshot([source], emptyEnvironment(), { runId: 'new', at: later }),
      );
      recent.executions[0].outcome = outcome;
      recent.executions[0].reason =
        outcome === 'blocked' || outcome === 'skipped' ? 'Explicit explanation' : '';
      const report = getRequirementsCoverage(
        [required],
        [source],
        freeze([entity('run', 'old', old), entity('run', 'new', recent)]),
      );
      expect(report.requirements[0].status).toBe(outcome);
      expect(old.executions[0].outcome).toBe('passed');
    },
  );

  it('excludes deleted records and foreign-project results', () => {
    const source = testCase(),
      required = entity('requirement', 'req', {
        code: '',
        description: '',
        acceptanceCriteria: '',
        priority: 'normal',
        owner: '',
      });
    const data = unwrap(createRunSnapshot([source], emptyEnvironment(), { runId: 'r', at }));
    data.executions[0].outcome = 'passed';
    expect(
      getRequirementsCoverage([required], [source], [entity('run', 'r', data, 'foreign')])
        .requirements[0].status,
    ).toBe('not_run');
    expect(
      getRequirementsCoverage([required], [{ ...source, deletedAt: at }]).requirements[0].status,
    ).toBe('uncovered');
    expect(
      getRequirementsCoverage([{ ...required, deletedAt: at }], [source]).linked.denominator,
    ).toBe(0);
  });
});

describe('finding retests', () => {
  it('appends a detached comparison without rewriting original reproduction or previous retests', () => {
    const original = freeze(finding());
    const attempt = retest();
    const first = unwrap(appendFindingRetest(original, attempt));
    attempt.environment.build = 'mutated';
    attempt.evidenceIds.push('mutated');
    expect(first.retests[0].environment.build).toBe('fixed');
    expect(first.retests[0].evidenceIds).toEqual(['new-screenshot']);
    const second = unwrap(
      appendFindingRetest(freeze(first), {
        ...retest('failed'),
        id: 'second',
        at: '2026-09-11T10:00:00Z',
      }),
    );
    expect(second.retests).toHaveLength(2);
    expect(first.retests).toHaveLength(1);
    expect(original.retests).toEqual([]);
    expect({ ...second, retests: [] }).toEqual(original);
    expect(second.actual).toBe('Change disappears');
    expect(second.environment.build).toBe('original');
  });

  it('labels unverified resolutions and requires the latest retest to pass', () => {
    const original = finding();
    expect(transitionFinding(original, 'resolved').ok).toBe(false);
    const resolved = unwrap(transitionFinding(original, 'resolved', 'Write ordering corrected'));
    expect(getFindingVerification(resolved)).toBe('unverified');
    const verified = unwrap(appendFindingRetest(resolved, retest()));
    expect(getFindingVerification(verified)).toBe('verified');
    const failed = unwrap(
      appendFindingRetest(verified, { ...retest('failed'), id: 'failed-again' }),
    );
    expect(getFindingVerification(failed)).toBe('unverified');
    const reopened = unwrap(transitionFinding(failed, 'open'));
    expect(reopened.retests).toEqual(failed.retests);
    expect(getFindingVerification(reopened)).toBe('unresolved');
  });

  it('rejects duplicate, not-run, unexplained, and backdated retests', () => {
    const initial = unwrap(appendFindingRetest(finding(), retest()));
    expect(appendFindingRetest(initial, retest()).ok).toBe(false);
    expect(appendFindingRetest(finding(), retest('not_run')).ok).toBe(false);
    for (const outcome of ['blocked', 'skipped'] as Outcome[])
      expect(appendFindingRetest(finding(), { ...retest(outcome), notes: '  ' }).ok).toBe(false);
    expect(appendFindingRetest(initial, { ...retest(), id: 'earlier', at }).ok).toBe(false);
  });
});

describe('specialist templates', () => {
  it('ships every promised workflow with substantive, script-free guidance and neutral defaults', () => {
    const ids = BUILT_IN_TEMPLATES.map((template) => template.id);
    expect(ids).toEqual(
      expect.arrayContaining(
        [
          'walkthrough',
          'documentation',
          'exploratory',
          'bug',
          'retest',
          'case',
          'smoke',
          'regression',
          'uat',
          'accessibility',
          'api',
          'performance',
          'mobile',
          'game',
          'localization',
          'compatibility',
          'release',
        ].map((id) => `builtin:${id}`),
      ),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of BUILT_IN_TEMPLATES) {
      expect(template.data.sections.length).toBeGreaterThanOrEqual(4);
      expect(template.data.fields.length).toBeGreaterThanOrEqual(4);
      expect(new Set(template.data.fields.map((field) => field.id)).size).toBe(
        template.data.fields.length,
      );
      expect(new Set(template.data.sections.map((section) => section.id)).size).toBe(
        template.data.sections.length,
      );
      expect(template.data.sections.every((section) => section.guidance.length > 50)).toBe(true);
      expect(template.data.builtIn).toBe(true);
      expect(Object.isFrozen(template.data.defaults)).toBe(true);
    }
  });

  it('returns editable project copies without leaking edits into other copies or built-ins', () => {
    const first = getBuiltInTemplates('one', at),
      second = getBuiltInTemplates('two', later);
    first[0].data.sections[0].guidance = 'Locally edited';
    first[0].tags.push('mine');
    expect(second[0].data.sections[0].guidance).not.toBe('Locally edited');
    expect(BUILT_IN_TEMPLATES[0].tags).not.toContain('mine');
    expect(first[0].projectId).toBe('one');
    expect(second[0].createdAt).toBe(later);
    expect(
      templateBody({
        ...first[0].data,
        sections: [{ id: 'x', title: '<script>', guidance: '<img onerror=alert(1)>' }],
      }).content?.[1].content?.[0],
    ).toEqual({ type: 'text', text: '<img onerror=alert(1)>' });
  });

  const typedTemplate: TemplateData = {
    targetKind: 'document',
    description: '',
    icon: 'file',
    builtIn: false,
    sections: [],
    defaults: {},
    fields: [
      { id: 'count', label: 'Count', type: 'number', required: true },
      { id: 'reviewed', label: 'Reviewed', type: 'checkbox', required: true },
      { id: 'date', label: 'Date', type: 'date', required: true },
      { id: 'choice', label: 'Choice', type: 'select', required: true, options: ['A', 'B'] },
      { id: 'many', label: 'Many', type: 'multiselect', required: true, options: ['A', 'B'] },
    ],
  };
  const values = { count: 0, reviewed: false, date: '2026-09-09', choice: 'A', many: ['A', 'B'] };
  it('accepts zero and false as present values and validates dates/options/numbers without coercion', () => {
    expect(validateTemplateValues(typedTemplate, values).ok).toBe(true);
    for (const invalid of [
      { count: NaN },
      { count: '4' },
      { reviewed: 'true' },
      { date: '2026-02-30' },
      { choice: 'C' },
      { many: ['A', 'A'] },
      { many: [] },
      { unexpected: 'x' },
    ]) {
      expect(validateTemplateValues(typedTemplate, { ...values, ...invalid }).ok).toBe(false);
    }
    expect(
      validateTemplateValues(
        {
          ...typedTemplate,
          fields: [{ id: 'code', label: 'Code', type: 'script' as never, required: false }],
        },
        {},
      ).ok,
    ).toBe(false);
  });
});
