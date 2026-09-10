import { describe, expect, it } from 'vitest';
import { createEntity, defaultData } from '../../domain/defaults';
import { presetSelection } from './presets';
import type { SnapshotOptions } from './types';
const options: SnapshotOptions = {
  format: 'json',
  title: '',
  author: '',
  pageSize: 'A4',
  includeEvidence: false,
  includePrivate: false,
  includeHistory: false,
  scope: 'project',
  entityIds: [],
};
describe('purpose-specific report selection', () => {
  it('selects finding context without unrelated documents and terminates cycles', () => {
    const finding = createEntity('p', 'finding', 'Finding', defaultData('finding'));
    const related = createEntity('p', 'finding', 'Related', defaultData('finding'));
    const testCase = createEntity('p', 'case', 'Linked case', defaultData('case'));
    const unrelated = createEntity('p', 'document', 'Unrelated', defaultData('document'));
    finding.data.relatedIds = [related.id];
    related.data.relatedIds = [finding.id];
    finding.data.caseIds = [testCase.id];
    expect(
      presetSelection([unrelated, testCase, finding, related], {
        ...options,
        preset: 'finding',
        scope: 'selected',
        entityIds: [finding.id],
      }),
    ).toEqual(new Set([finding.id, related.id, testCase.id]));
  });
  it('includes full public chronology for session roots but only the cited observation for provenance', () => {
    const session = createEntity('p', 'session', 'Session', defaultData('session'));
    const cited = createEntity('p', 'entry', 'Cited', {
      ...defaultData('entry'),
      sessionId: session.id,
    });
    const other = createEntity('p', 'entry', 'Other', {
      ...defaultData('entry'),
      sessionId: session.id,
    });
    const finding = createEntity('p', 'finding', 'Finding', {
      ...defaultData('finding'),
      sourceEntryId: cited.id,
    });
    const records = [session, cited, other, finding];
    const scope = presetSelection(records, { ...options, preset: 'finding' });
    expect(scope.has(session.id)).toBe(true);
    expect(scope.has(cited.id)).toBe(true);
    expect(scope.has(other.id)).toBe(false);
    expect(presetSelection(records, { ...options, preset: 'session' }).has(other.id)).toBe(true);
  });
  it('covers linked cases and recorded run snapshots, even when a case was later removed', () => {
    const requirement = createEntity('p', 'requirement', 'Requirement', defaultData('requirement'));
    const testCase = createEntity('p', 'case', 'Case', {
      ...defaultData('case'),
      requirementIds: [requirement.id],
    });
    const run = createEntity('p', 'run', 'Run', defaultData('run'));
    run.data.executions = [
      {
        id: 'execution',
        caseId: 'removed-case',
        caseTitle: 'Frozen case',
        caseRevision: 1,
        prerequisites: '',
        updatedAt: '2026-09-10T12:00:00Z',
        steps: [],
        stepResults: {},
        outcome: 'not_run',
        notes: '',
        reason: '',
        findingIds: [],
        evidenceIds: [],
        requirementIds: [requirement.id],
      },
    ];
    const unrelated = createEntity('p', 'case', 'Unrelated', defaultData('case'));
    expect(
      presetSelection([requirement, testCase, run, unrelated], { ...options, preset: 'coverage' }),
    ).toEqual(new Set([requirement.id, testCase.id, run.id]));
  });
  it('keeps the legacy whole-project scope and limits walkthroughs to documents', () => {
    const doc = createEntity('p', 'document', 'Guide', defaultData('document'));
    const finding = createEntity('p', 'finding', 'Finding', defaultData('finding'));
    expect(presetSelection([doc, finding], options).size).toBe(2);
    expect(presetSelection([doc, finding], { ...options, preset: 'walkthrough' })).toEqual(
      new Set([doc.id]),
    );
  });
});
