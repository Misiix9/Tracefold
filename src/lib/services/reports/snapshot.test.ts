import { describe, it, expect } from 'vitest';
import { assembleReportSnapshot } from './snapshot';
import { createEntity, defaultData, textDoc } from '../../domain/defaults';
import { buildReportModel, reportText } from './model';
import type { AnyEntity, Project } from '../../domain/types';
const at = '2026-09-09T12:00:00.000Z';
const project: Project = {
  id: 'test',
  name: 'Project',
  description: '',
  prefix: 'TF',
  color: '#783D49',
  createdAt: at,
  updatedAt: at,
  revision: 1,
  archived: false,
};
const options = {
  format: 'json' as const,
  title: 'Report',
  author: '',
  pageSize: 'A4' as const,
  includeEvidence: false,
  includePrivate: false,
  includeHistory: false,
  scope: 'project' as 'project' | 'selected',
  entityIds: [] as string[],
};
const snapshot = (records: AnyEntity[], ids?: string[]) =>
  assembleReportSnapshot({
    project,
    records,
    options: { ...options, scope: ids ? 'selected' : 'project', entityIds: ids ?? [] },
    generatedAt: at,
    readAsset: async () => {
      throw new Error('Unexpected asset access');
    },
  });
describe('sanitized report graph', () => {
  it('localizes compound field headings without changing user-authored findings', async () => {
    const finding = createEntity('test', 'finding', 'Original English title', {
      ...defaultData('finding'),
      suspectedCause: 'The edit form reads an incomplete address model.',
      confirmedCause: 'Original technical explanation',
    });
    const result = await assembleReportSnapshot({
      project,
      records: [finding],
      options: { ...options, language: 'hu', preset: 'finding' },
      generatedAt: at,
      readAsset: async () => {
        throw new Error('Unexpected asset access');
      },
    });
    const text = reportText(buildReportModel(result));
    expect(text).toContain('Feltételezett ok');
    expect(text).toContain('Igazolt ok');
    expect(text).toContain('Darabszám');
    expect(text).not.toContain('Suspected Cause');
    expect(text).toContain(finding.data.suspectedCause);
    expect(text).toContain(finding.title);
  });
  it('includes public chronology when a session is selected and excludes private entries', async () => {
    const session = createEntity('test', 'session', 'Session', defaultData('session'));
    const entry = createEntity('test', 'entry', 'Public', {
      ...defaultData('entry'),
      sessionId: session.id,
    });
    entry.createdAt = '2026-09-09T10:00:00.000Z';
    const privateEntry = createEntity('test', 'entry', 'Private sentinel', {
      ...entry.data,
      private: true,
    });
    const result = await snapshot([session, entry, privateEntry], [session.id]);
    expect(result.records.map((r) => r.kind)).toEqual(['session', 'entry']);
    expect(result.records[1].createdAt).toBe(entry.createdAt);
    expect(JSON.stringify(result)).not.toContain('Private sentinel');
  });
  it('preserves and remaps step reasons with frozen dataset and requirement metadata', async () => {
    const requirement = createEntity(
      'test',
      'requirement',
      'Expected behavior',
      defaultData('requirement'),
    );
    const testCase = createEntity('test', 'case', 'Case', {
      ...defaultData('case'),
      datasets: [{ id: 'source-data-id', name: 'Edge', values: { value: '1' } }],
    });
    testCase.revision = 5;
    const run = createEntity('test', 'run', 'Run', {
      ...defaultData('run'),
      executions: [
        {
          id: 'source-execution',
          caseId: testCase.id,
          caseTitle: 'Case',
          caseRevision: 4,
          steps: [{ id: 'original-step', action: 'Submit', expected: 'Accepted' }],
          datasetId: 'source-data-id',
          dataset: { name: 'Edge', values: { value: '1' } },
          requirementIds: [requirement.id],
          prerequisites: '',
          outcome: 'blocked',
          reason: 'Gateway offline',
          notes: '',
          stepResults: { 'original-step': 'blocked' },
          stepReasons: { 'original-step': 'Gateway rejected token' },
          findingIds: [],
          evidenceIds: [],
          updatedAt: at,
        },
      ],
    });
    const result = await snapshot([testCase, requirement, run]);
    const exported = result.records.find((r) => r.kind === 'run')!;
    if (exported.kind !== 'run') throw new Error();
    const execution = exported.data.executions[0];
    expect(execution.stepReasons).toEqual({ 'step-1': 'Gateway rejected token' });
    expect(execution.datasetId).toBe('dataset-1');
    expect(execution.requirementIds).toEqual(['record-2']);
    expect(execution.caseRevision).toBe(4);
    expect(result.records[0].revision).toBe(5);
  });
  it('keeps explicit retest observations while removing hidden environment metadata', async () => {
    const finding = createEntity('test', 'finding', 'Retested', {
      ...defaultData('finding'),
      retests: [
        {
          id: 'source-retest-id',
          at,
          environment: { ...defaultData('finding').environment, extra: { secret: 'SECRET' } },
          outcome: 'passed',
          notes: 'Recovered correctly',
          evidenceIds: [],
        },
      ],
    });
    const result = await snapshot([finding]);
    const r = result.records[0];
    if (r.kind !== 'finding') throw new Error();
    expect(r.data.retests[0].notes).toBe('Recovered correctly');
    expect(r.data.retests[0].id).toBe('retest-1');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects an unexplained blocked step instead of discarding its meaning', async () => {
    const run = createEntity('test', 'run', 'Run', {
      ...defaultData('run'),
      executions: [
        {
          id: 'e',
          caseId: '',
          caseTitle: 'Test',
          caseRevision: 0,
          steps: [{ id: 's', action: 'Run', expected: 'Pass' }],
          prerequisites: '',
          outcome: 'not_run',
          reason: '',
          notes: '',
          stepResults: { s: 'blocked' },
          findingIds: [],
          evidenceIds: [],
          updatedAt: at,
        },
      ],
    });
    await expect(snapshot([run])).rejects.toThrow('Blocked/skipped step needs a reason');
  });
});

describe('private investigation derivatives and typed document fields', () => {
  it('excludes private promoted findings, cases, runs and evidence attached to private records', async () => {
    const visible = createEntity('test', 'document', 'Public report', defaultData('document'));
    const file = createEntity(
      'test',
      'evidence',
      'PRIVATE_EVIDENCE_SENTINEL',
      defaultData('evidence'),
    );
    const entry = createEntity('test', 'entry', 'PRIVATE_ENTRY_SENTINEL', {
      ...defaultData('entry'),
      private: true,
      evidenceIds: [file.id],
    });
    const finding = createEntity('test', 'finding', 'PRIVATE_FINDING_SENTINEL', {
      ...defaultData('finding'),
      private: true,
      sourceEntryId: entry.id,
    });
    const testCase = createEntity('test', 'case', 'PRIVATE_CASE_SENTINEL', {
      ...defaultData('case'),
      private: true,
      sourceEntryId: entry.id,
    });
    const run = createEntity('test', 'run', 'PRIVATE_RUN_SENTINEL', {
      ...defaultData('run'),
      private: true,
    });
    const result = await assembleReportSnapshot({
      project,
      records: [visible, entry, finding, testCase, run, file],
      options: { ...options, includeEvidence: true },
      generatedAt: at,
      readAsset: async () => {
        throw new Error('Private evidence must not be read');
      },
    });
    expect(result.records.map((r) => r.title)).toEqual(['Public report']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
  it('exports edited typed fields once and drops unknown hidden metadata', async () => {
    const doc = createEntity(
      'test',
      'document',
      'Field test',
      {
        ...defaultData('document'),
        templateFields: [
          { id: 'sample', label: 'Minták', type: 'number', required: true },
          { id: 'reviewed', label: 'Ellenőrizve', type: 'checkbox', required: false },
        ],
        fields: { sample: -12.5, reviewed: false, hidden: 'HIDDEN_FIELD_SENTINEL' },
      },
      textDoc('Original prose'),
    );
    const result = await snapshot([doc]);
    const text = reportText(buildReportModel(result));
    expect(text).toContain('Minták');
    expect(text).toContain('-12.5');
    expect(text).toContain('No');
    expect(text).toContain('Original prose');
    expect(JSON.stringify(result)).not.toContain('HIDDEN_FIELD_SENTINEL');
    expect(result.records[0].kind).toBe('document');
  });
});
