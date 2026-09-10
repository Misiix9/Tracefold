import { presetSelection } from './presets';
import { remapEntityReferences as remapReferences } from '../../domain/references';
import { sessionSeconds } from '../../domain/sessions';
import type { AnyEntity, EntityKind, Project } from '../../domain/types';
import type { WorkspaceRepository } from '../repository';
import { sanitizeAsset } from './assets';
import {
  canonical,
  entityKinds,
  object,
  parseData,
  parseOptions,
  parseProject,
  parseRecord,
  sanitizeRichDocument,
} from './schema';
import { REPORT_LIMITS, requireThat } from './types';
import type { ReportAsset, ReportSnapshot, SnapshotOptions } from './types';

type Reader = Pick<WorkspaceRepository, 'listProjects' | 'listRecords' | 'readAsset'>;
export interface SnapshotInput {
  project: Project;
  records: readonly AnyEntity[];
  options: SnapshotOptions;
  readAsset: (assetId: string) => Promise<Uint8Array>;
  generatedAt?: string;
}
function isPublic(r: AnyEntity): boolean {
  return !r.deletedAt && !(r.data as { private?: boolean }).private;
}
export function evidenceReferences(record: AnyEntity): string[] {
  if (record.kind === 'run') return record.data.executions.flatMap((e) => e.evidenceIds);
  if (record.kind === 'finding')
    return [...record.data.evidenceIds, ...record.data.retests.flatMap((r) => r.evidenceIds)];
  if ('evidenceIds' in record.data) return record.data.evidenceIds ?? [];
  return [];
}
export { remapEntityReferences as remapReferences } from '../../domain/references';
/** Freeze the returned structure and copy all byte buffers. Uint8Array elements cannot be frozen in JS. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export async function assembleReportSnapshot(input: SnapshotInput): Promise<ReportSnapshot> {
  const source = structuredClone({
    project: input.project,
    records: input.records,
    options: input.options,
  });
  const { project, options } = source;
  const at = input.generatedAt ?? new Date().toISOString();
  requireThat(
    !options.includePrivate && !options.includeHistory,
    'Share exports always exclude private content and history',
    'UNSAFE_EXPORT_OPTIONS',
  );
  requireThat(!Number.isNaN(Date.parse(at)), 'Invalid export date');
  requireThat(source.records.length <= REPORT_LIMITS.records, 'Too many records');
  requireThat(
    source.records.every((r) => r.projectId === project.id && entityKinds.includes(r.kind)),
    'Mixed project or unknown record',
  );
  requireThat(
    new Set(source.records.map((r) => r.id)).size === source.records.length,
    'Duplicate source record',
  );
  requireThat(['project', 'selected'].includes(options.scope), 'Invalid scope');
  const privateEvidence = new Set(
    source.records
      .filter((r) => !r.deletedAt && (r.data as { private?: boolean }).private)
      .flatMap(evidenceReferences),
  );
  const publicRecords = source.records.filter(
      (r) => isPublic(r) && !(r.kind === 'evidence' && privateEvidence.has(r.id)),
    ),
    publicIds = new Set(publicRecords.map((r) => r.id));
  const selected = presetSelection(publicRecords, options);
  if (options.scope === 'selected')
    requireThat(
      options.entityIds.length > 0 &&
        options.entityIds.every((id) => source.records.some((r) => r.id === id)),
      'Empty or missing selection',
    );
  if (options.includeEvidence)
    for (const r of publicRecords.filter((r) => selected.has(r.id))) {
      for (const id of evidenceReferences(r)) {
        requireThat(
          source.records.some((r) => r.id === id && r.kind === 'evidence'),
          'Missing evidence record',
          'MISSING_EVIDENCE',
        );
        if (publicIds.has(id)) selected.add(id);
      }
    }
  const records = publicRecords.filter(
    (r) => selected.has(r.id) && (options.includeEvidence || r.kind !== 'evidence'),
  );
  requireThat(records.length > 0, 'No public records to export', 'EMPTY_REPORT');
  const ids = new Map(records.map((r, i) => [r.id, `record-${i + 1}`]));
  const assets: Record<string, ReportAsset> = Object.create(null);
  const result: AnyEntity[] = [];
  let total = 0;
  for (const raw of records) {
    const r = remapReferences(raw, ids);
    r.id = ids.get(raw.id)!;
    r.projectId = 'project';
    r.deletedAt = null;
    r.body = sanitizeRichDocument(raw.body);
    if ('environment' in r.data) r.data.environment.extra = {};
    switch (r.kind) {
      case 'session':
        r.data.durationSeconds = sessionSeconds(
          raw.kind === 'session' ? raw.data : r.data,
          Date.parse(at),
        );
        break;
      case 'finding':
        r.data.retests = r.data.retests.map((t, i) => ({
          ...t,
          id: `retest-${i + 1}`,
          environment: { ...t.environment, extra: {} },
        }));
        break;
      case 'document':
        r.data.private = false;
        if (r.data.templateFields?.length) {
          const known = new Set(r.data.templateFields.map((field) => field.id));
          r.data.fields = Object.fromEntries(
            Object.entries(r.data.fields ?? {}).filter(([key]) => known.has(key)),
          );
        } else delete r.data.fields;
        break;
      case 'entry':
        r.data.private = false;
        break;
      case 'case':
        r.data.steps = r.data.steps.map((s, i) => ({ ...s, id: `step-${i + 1}` }));
        r.data.datasets = r.data.datasets.map((d, i) => ({ ...d, id: `dataset-${i + 1}` }));
        break;
      case 'run':
        r.data.executions = r.data.executions.map((e, i) => {
          const steps = e.steps.map((s, j) => ({ ...s, id: `step-${j + 1}` }));
          const stepResults = Object.fromEntries(
            e.steps.flatMap((s, j) =>
              e.stepResults[s.id] === undefined ? [] : [[steps[j].id, e.stepResults[s.id]]],
            ),
          );
          const stepReasons = Object.fromEntries(
            e.steps.flatMap((s, j) =>
              e.stepReasons?.[s.id] === undefined ? [] : [[steps[j].id, e.stepReasons[s.id]]],
            ),
          );
          const originalExecution = raw.kind === 'run' ? raw.data.executions[i] : undefined;
          const originalCase = source.records.find(
            (c) => c.kind === 'case' && c.id === originalExecution?.caseId,
          );
          const datasetIndex =
            originalCase?.kind === 'case'
              ? originalCase.data.datasets.findIndex((d) => d.id === originalExecution?.datasetId)
              : -1;
          return {
            ...e,
            id: `execution-${i + 1}`,
            steps,
            stepResults,
            stepReasons,
            datasetId: e.dataset && datasetIndex >= 0 ? `dataset-${datasetIndex + 1}` : undefined,
          };
        });
        break;
      case 'template':
        r.data.builtIn = false;
        r.data.defaults = {};
        r.data.fields = r.data.fields.map((f, i) => ({ ...f, id: `field-${i + 1}` }));
        r.data.sections = r.data.sections.map((s, i) => ({ ...s, id: `section-${i + 1}` }));
        break;
      case 'evidence': {
        const d = r.data,
          changed = d.annotations.length > 0 || d.crop !== undefined;
        requireThat(
          !changed ||
            (d.sanitizedAssetId &&
              d.sanitizedAssetId !== d.assetId &&
              d.sanitizedAssetId !== d.originalAssetId),
          'Changed evidence requires a distinct sanitizedAssetId',
          'SANITIZED_ASSET_REQUIRED',
        );
        const assetId = d.sanitizedAssetId || d.assetId;
        requireThat(assetId, 'Missing evidence asset', 'MISSING_EVIDENCE');
        const asset = await sanitizeAsset(await input.readAsset(assetId), d.mimeType);
        if (!assets[asset.hash]) {
          total += asset.size;
          assets[asset.hash] = asset;
        }
        requireThat(
          Object.keys(assets).length <= REPORT_LIMITS.assets &&
            total <= REPORT_LIMITS.totalAssetBytes,
          'Evidence resource limit exceeded',
        );
        r.data = {
          assetId: asset.hash,
          sanitizedAssetId: asset.hash,
          filename: asset.filename,
          mimeType: asset.mimeType,
          size: asset.size,
          hash: asset.hash,
          ...(asset.width === undefined ? {} : { width: asset.width, height: asset.height }),
          caption: d.caption,
          annotations: [],
          private: false,
          source: 'import',
          ...(d.timestampReferences ? { timestampReferences: d.timestampReferences } : {}),
        };
        break;
      }
    }
    r.data = parseData(r.kind, r.data, false);
    // Explicitly assemble fields; never carry undeclared record metadata into a share.
    result.push(
      parseRecord({
        id: r.id,
        projectId: r.projectId,
        kind: r.kind,
        title: r.title,
        body: r.body,
        tags: r.tags,
        data: r.data,
        revision: r.revision,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        deletedAt: null,
      }),
    );
  }
  const snapshot: ReportSnapshot = {
    kind: 'tracefold-report',
    schemaVersion: 1,
    generatedAt: at,
    project: {
      id: 'project',
      name: project.name,
      description: project.description,
      prefix: project.prefix,
      color: project.color,
      createdAt: at,
      updatedAt: at,
      archived: false,
      revision: 0,
    },
    records: result,
    options: parseOptions({ ...options, scope: 'project', entityIds: [] }),
    assets,
  };
  await validateReportSnapshot(snapshot);
  return freeze(snapshot);
}

/** Enumeration is not a database snapshot. Pass an already-consistent copy to assembleReportSnapshot when available. */
export async function createReportSnapshot(
  repository: Reader,
  projectId: string,
  options: SnapshotOptions,
): Promise<ReportSnapshot> {
  const project = (await repository.listProjects()).find((p) => p.id === projectId);
  requireThat(project, 'Project not found');
  const records: AnyEntity[] = [],
    cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await repository.listRecords({ projectId, limit: 500, cursor });
    records.push(...page.items);
    requireThat(records.length <= REPORT_LIMITS.records, 'Too many records');
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      requireThat(!cursors.has(cursor), 'Repository repeated a pagination cursor');
      cursors.add(cursor);
    }
  } while (cursor);
  return assembleReportSnapshot({
    project,
    records,
    options,
    readAsset: (id) => repository.readAsset(projectId, id),
  });
}

export async function validateReportSnapshot(value: unknown): Promise<ReportSnapshot> {
  const s = object(value);
  requireThat(
    Object.keys(s).sort().join(',') ===
      ['kind', 'schemaVersion', 'generatedAt', 'project', 'records', 'options', 'assets']
        .sort()
        .join(','),
    'Unexpected report field',
  );
  requireThat(s.kind === 'tracefold-report' && s.schemaVersion === 1, 'Unsupported report schema');
  requireThat(
    typeof s.generatedAt === 'string' && !Number.isNaN(Date.parse(s.generatedAt)),
    'Invalid report timestamp',
  );
  parseProject(s.project);
  const options = parseOptions(s.options);
  requireThat(
    Array.isArray(s.records) && s.records.length > 0 && s.records.length <= REPORT_LIMITS.records,
    'Empty or oversized report',
  );
  const records = s.records.map(parseRecord),
    byId = new Map(records.map((r) => [r.id, r]));
  requireThat(byId.size === records.length, 'Duplicate record ID');
  const check = (id: string, kind?: EntityKind) =>
    requireThat(
      byId.has(id) && (!kind || byId.get(id)?.kind === kind),
      'Dangling or wrong-kind record reference',
    );
  const assets = object(s.assets);
  requireThat(Object.keys(assets).length <= REPORT_LIMITS.assets, 'Too many assets');
  const referenced = new Set<string>();
  let total = 0;
  for (const r of records) {
    for (const id of evidenceReferences(r)) check(id, 'evidence');
    if (r.kind === 'entry') {
      if (r.data.sessionId) check(r.data.sessionId, 'session');
      if (r.data.findingId) check(r.data.findingId, 'finding');
      if (r.data.caseId) check(r.data.caseId, 'case');
    }
    if (r.kind === 'finding') {
      if (r.data.sourceEntryId) check(r.data.sourceEntryId, 'entry');
      if (r.data.duplicateOf) check(r.data.duplicateOf, 'finding');
      r.data.caseIds.forEach((id) => check(id, 'case'));
      r.data.relatedIds.forEach((id) => check(id, 'finding'));
    }
    if (r.kind === 'case') {
      if (r.data.sourceEntryId) check(r.data.sourceEntryId, 'entry');
      r.data.requirementIds.forEach((id) => check(id, 'requirement'));
    }
    if (r.kind === 'run')
      for (const e of r.data.executions) {
        if (e.caseId) check(e.caseId, 'case');
        e.findingIds.forEach((id) => check(id, 'finding'));
        e.requirementIds?.forEach((id) => check(id, 'requirement'));
      }
    if (r.kind === 'evidence') {
      requireThat(options.includeEvidence, 'Evidence disabled but present');
      const a = object(assets[r.data.assetId]);
      requireThat(
        a.hash === r.data.assetId &&
          r.data.hash === a.hash &&
          r.data.sanitizedAssetId === a.hash &&
          r.data.filename === a.filename &&
          r.data.mimeType === a.mimeType &&
          r.data.size === a.size &&
          r.data.width === a.width &&
          r.data.height === a.height,
        'Evidence asset reference mismatch',
      );
      referenced.add(r.data.assetId);
    }
  }
  requireThat(referenced.size === Object.keys(assets).length, 'Unreferenced asset');
  for (const [key, value] of Object.entries(assets)) {
    const a = object(value);
    requireThat(
      /^[a-f0-9]{64}$/.test(key) && a.bytes instanceof Uint8Array,
      'Invalid asset hash or bytes',
    );
    total += a.bytes.length;
    requireThat(total <= REPORT_LIMITS.totalAssetBytes, 'Total asset limit exceeded');
    const clean = await sanitizeAsset(a.bytes, String(a.mimeType));
    const { bytes: _original, ...metadata } = a,
      { bytes: _clean, ...expected } = clean;
    requireThat(
      canonical(metadata) === canonical(expected) &&
        key === clean.hash &&
        a.bytes.length === clean.bytes.length &&
        a.bytes.every((b, i) => b === clean.bytes[i]),
      'Asset hash, metadata or sanitization mismatch',
    );
  }
  return value as ReportSnapshot;
}
