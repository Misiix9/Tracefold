import type { AnyEntity, EntityKind } from '../../domain/types';
import type { ReportPreset, SnapshotOptions } from './types';
const primaryKinds: Record<Exclude<ReportPreset, 'release'>, EntityKind[]> = {
  finding: ['finding'],
  walkthrough: ['document'],
  session: ['session'],
  run: ['run'],
  coverage: ['requirement'],
};
export function isPresetPrimary(kind: EntityKind, preset?: ReportPreset): boolean {
  return !preset || preset === 'release' || primaryKinds[preset].includes(kind);
}
/** Selection runs after the privacy boundary. It can only add already-public context. */
export function presetSelection(
  records: readonly AnyEntity[],
  options: SnapshotOptions,
): Set<string> {
  const requested = new Set(options.entityIds);
  const roots = records.filter(
    (r) =>
      isPresetPrimary(r.kind, options.preset) &&
      (options.scope === 'project' || requested.has(r.id)),
  );
  const selected = new Set(roots.map((r) => r.id));
  const byId = new Map(records.map((r) => [r.id, r]));
  const add = (id: string | undefined) => {
    if (id && byId.has(id)) selected.add(id);
  };
  const rootSessions = new Set(roots.filter((r) => r.kind === 'session').map((r) => r.id));
  for (const r of records) if (r.kind === 'entry' && rootSessions.has(r.data.sessionId)) add(r.id);
  if (options.preset === 'coverage') {
    const requirements = new Set(roots.map((r) => r.id));
    const cases = new Set(
      records
        .filter(
          (r) => r.kind === 'case' && r.data.requirementIds.some((id) => requirements.has(id)),
        )
        .map((r) => r.id),
    );
    for (const id of cases) add(id);
    for (const r of records)
      if (
        r.kind === 'run' &&
        r.data.executions.some(
          (e) => cases.has(e.caseId) || e.requirementIds?.some((id) => requirements.has(id)),
        )
      )
        add(r.id);
  }
  // Older snapshots/preset-less exports retain their established selection behavior.
  if (!options.preset || options.preset === 'release') return selected;
  // Sets iterate newly added IDs too, so cycles terminate without recursion.
  for (const id of selected) {
    const r = byId.get(id)!;
    if (r.kind === 'entry') {
      add(r.data.sessionId);
      add(r.data.findingId);
      add(r.data.caseId);
    }
    if (r.kind === 'finding') {
      r.data.caseIds.forEach(add);
      r.data.relatedIds.forEach(add);
      add(r.data.duplicateOf);
      add(r.data.sourceEntryId);
    }
    if (r.kind === 'case') {
      r.data.requirementIds.forEach(add);
      add(r.data.sourceEntryId);
    }
    if (r.kind === 'run')
      for (const execution of r.data.executions) {
        add(execution.caseId);
        execution.findingIds.forEach(add);
        execution.requirementIds?.forEach(add);
      }
  }
  return selected;
}
