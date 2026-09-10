import { describe, it, expect } from 'vitest';
import { createEntity, defaultData, textDoc } from './defaults';
import { remapRestoredRecord } from './references';
describe('independent restore references', () => {
  it('preserves text that happens to equal a record or asset ID', () => {
    const r = createEntity(
      'source',
      'document',
      'source-evidence',
      { ...defaultData('document'), evidenceIds: ['source-evidence'] },
      textDoc('source-evidence'),
    );
    const mapped = remapRestoredRecord(
      r,
      'new-project',
      new Map([
        [r.id, 'new-note'],
        ['source-evidence', 'new-evidence'],
      ]),
      new Map(),
    );
    expect(mapped.title).toBe('source-evidence');
    expect(mapped.body).toEqual(r.body);
    expect(mapped.id).toBe('new-note');
    if (mapped.kind === 'document') expect(mapped.data.evidenceIds).toEqual(['new-evidence']);
  });
  it('keeps retest identities and private environment metadata in full backups', () => {
    const r = createEntity('source', 'finding', 'Finding', {
      ...defaultData('finding'),
      retests: [
        {
          id: 'original-retest',
          at: '2026-09-09',
          outcome: 'passed',
          notes: 'evidence-id',
          environment: { ...defaultData('finding').environment, extra: { token: 'private' } },
          evidenceIds: ['evidence-id'],
        },
      ],
    });
    const mapped = remapRestoredRecord(
      r,
      'copy',
      new Map([['evidence-id', 'new-evidence']]),
      new Map(),
    );
    if (mapped.kind !== 'finding') throw new Error();
    expect(mapped.data.retests[0]).toMatchObject({
      id: 'original-retest',
      notes: 'evidence-id',
      environment: { extra: { token: 'private' } },
      evidenceIds: ['new-evidence'],
    });
  });
  it('preserves case revisions so frozen coverage does not become current after restore', () => {
    const r = createEntity('source', 'case', 'Case', defaultData('case'));
    r.revision = 7;
    expect(remapRestoredRecord(r, 'copy', new Map(), new Map()).revision).toBe(7);
  });
});
