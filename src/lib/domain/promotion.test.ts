import { describe, it, expect } from 'vitest';
import { findingFromEntry, caseFromEntry, duplicateLinkIsValid } from './promotion';
import { createEntity, defaultData, emptyEnvironment, textDoc } from './defaults';
import { createRunSnapshot } from './testing';
import { remapEntityReferences } from './references';
describe('investigation provenance and privacy', () => {
  it('copies evidence, body-derived steps, environment and privacy without modifying the source', () => {
    const source = createEntity(
      'project',
      'entry',
      'Private observation',
      {
        ...defaultData('entry'),
        sessionId: 'session',
        private: true,
        evidenceIds: ['image'],
        expected: 'Keep data',
      },
      textDoc('Reproduce with secret input'),
    );
    const before = JSON.stringify(source),
      env = emptyEnvironment();
    env.build = '1.2';
    const finding = findingFromEntry(source, env, 'QA-1'),
      testCase = caseFromEntry(source);
    expect(finding.private).toBe(true);
    expect(testCase.private).toBe(true);
    expect(finding.sourceEntryId).toBe(source.id);
    expect(testCase.sourceEntryId).toBe(source.id);
    expect(testCase.evidenceIds).toEqual(['image']);
    expect(testCase.steps[0].expected).toBe('Keep data');
    env.build = 'changed';
    expect(finding.environment.build).toBe('1.2');
    expect(JSON.stringify(source)).toBe(before);
    const record = createEntity('project', 'case', 'Private check', testCase);
    record.revision = 1;
    const run = createRunSnapshot([record], env, { runId: 'run', at: '2026-09-09T12:00:00.000Z' });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.value.private).toBe(true);
    const mapped = remapEntityReferences(
      createEntity('project', 'finding', 'Copy', finding),
      new Map([
        [source.id, 'entry-alias'],
        ['image', 'evidence-alias'],
      ]),
    );
    if (mapped.kind === 'finding') {
      expect(mapped.data.sourceEntryId).toBe('entry-alias');
      expect(mapped.data.evidenceIds).toEqual(['evidence-alias']);
    }
  });
  it('rejects self-links, cycles and cross-project duplicate references', () => {
    const a = createEntity('project', 'finding', 'A', defaultData('finding')),
      b = createEntity('project', 'finding', 'B', defaultData('finding')),
      c = createEntity('other', 'finding', 'C', defaultData('finding'));
    expect(duplicateLinkIsValid(a, b.id, [a, b, c])).toBe(true);
    expect(duplicateLinkIsValid(a, a.id, [a, b, c])).toBe(false);
    expect(duplicateLinkIsValid(a, c.id, [a, b, c])).toBe(false);
    b.data.duplicateOf = a.id;
    expect(duplicateLinkIsValid(a, b.id, [a, b, c])).toBe(false);
  });
});
