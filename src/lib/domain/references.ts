import type { AnyEntity } from './types';
/** Rewrite relationship fields only. User text and historical observations are never replaced. */
export function remapEntityReferences(
  record: AnyEntity,
  ids: ReadonlyMap<string, string>,
  preserveMissing = false,
): AnyEntity {
  const r = structuredClone(record);
  const one = (id: string) => ids.get(id) ?? (preserveMissing ? id : '');
  const many = (values: string[]) => values.map(one).filter(Boolean);
  switch (r.kind) {
    case 'document':
      r.data.evidenceIds = many(r.data.evidenceIds);
      if (r.data.templateId) r.data.templateId = one(r.data.templateId) || undefined;
      break;
    case 'entry':
      r.data.sessionId = one(r.data.sessionId);
      r.data.findingId = one(r.data.findingId ?? '') || undefined;
      r.data.caseId = one(r.data.caseId ?? '') || undefined;
      r.data.evidenceIds = many(r.data.evidenceIds);
      break;
    case 'finding':
      r.data.sourceEntryId = one(r.data.sourceEntryId ?? '') || undefined;
      r.data.duplicateOf = one(r.data.duplicateOf ?? '') || undefined;
      r.data.relatedIds = many(r.data.relatedIds);
      r.data.caseIds = many(r.data.caseIds);
      r.data.evidenceIds = many(r.data.evidenceIds);
      r.data.retests = r.data.retests.map((t) => ({ ...t, evidenceIds: many(t.evidenceIds) }));
      break;
    case 'case':
      r.data.sourceEntryId = one(r.data.sourceEntryId ?? '') || undefined;
      if (r.data.evidenceIds) r.data.evidenceIds = many(r.data.evidenceIds);
      r.data.requirementIds = many(r.data.requirementIds);
      break;
    case 'run':
      for (const e of r.data.executions) {
        e.caseId = one(e.caseId);
        e.findingIds = many(e.findingIds);
        e.evidenceIds = many(e.evidenceIds);
        if (e.requirementIds) e.requirementIds = many(e.requirementIds);
      }
      break;
  }
  return r;
}
export function remapRestoredRecord(
  record: AnyEntity,
  projectId: string,
  ids: ReadonlyMap<string, string>,
  assets: ReadonlyMap<string, string>,
): AnyEntity {
  const r = remapEntityReferences(record, ids, true);
  r.id = ids.get(r.id) ?? r.id;
  r.projectId = projectId;
  if (r.kind === 'evidence')
    for (const key of ['assetId', 'sanitizedAssetId', 'originalAssetId'] as const) {
      const value = r.data[key];
      if (value) r.data[key] = assets.get(value) ?? value;
    }
  // A restored clock cannot infer time spent outside the app.
  if (r.kind === 'session' && r.data.state === 'active') {
    r.data.state = 'paused';
    r.data.activeSince = undefined;
  }
  return r;
}
