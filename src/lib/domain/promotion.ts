import type { Entity, FindingData, CaseData, Environment } from './types';
import { defaultData, plainText, newId } from './defaults';
/** New records inherit privacy and preserve typed provenance; source content is never consumed. */
export function findingFromEntry(
  entry: Entity<'entry'>,
  environment: Environment,
  code: string,
): FindingData {
  return {
    ...defaultData('finding'),
    code,
    private: entry.data.private,
    sourceEntryId: entry.id,
    expected: entry.data.expected,
    actual: entry.data.actual || plainText(entry.body),
    environment: structuredClone(environment),
    evidenceIds: [...entry.data.evidenceIds],
  };
}
export function caseFromEntry(entry: Entity<'entry'>): CaseData {
  return {
    ...defaultData('case'),
    private: entry.data.private,
    sourceEntryId: entry.id,
    evidenceIds: [...entry.data.evidenceIds],
    steps: [{ id: newId(), action: plainText(entry.body), expected: entry.data.expected }],
  };
}
export function duplicateLinkIsValid(
  source: Entity<'finding'>,
  targetId: string,
  findings: readonly Entity<'finding'>[],
): boolean {
  const seen = new Set([source.id]);
  let id = targetId;
  while (id) {
    if (seen.has(id)) return false;
    seen.add(id);
    const target = findings.find(
      (f) => f.id === id && f.projectId === source.projectId && !f.deletedAt,
    );
    if (!target) return false;
    id = target.data.duplicateOf ?? '';
  }
  return true;
}
