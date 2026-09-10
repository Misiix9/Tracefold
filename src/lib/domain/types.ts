export type EntityKind =
  | 'document'
  | 'session'
  | 'entry'
  | 'finding'
  | 'case'
  | 'run'
  | 'requirement'
  | 'evidence'
  | 'template';
export type Outcome = 'passed' | 'failed' | 'blocked' | 'skipped' | 'not_run';
export type FindingStatus = 'open' | 'in_progress' | 'ready_for_retest' | 'resolved' | 'deferred';
export type Severity = 'blocker' | 'critical' | 'major' | 'minor' | 'trivial';
export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: RichNode[];
}
export type RichDocument = RichNode;
export interface Project {
  id: string;
  name: string;
  description: string;
  prefix: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  revision: number;
}
export interface Environment {
  build: string;
  platform: string;
  browser: string;
  device: string;
  locale: string;
  extra: Record<string, string>;
}
export interface DocumentData {
  templateId?: string;
  private?: boolean;
  evidenceIds: string[];
  category?: string;
  fields?: Record<string, unknown>;
  templateFields?: TemplateField[];
}
export interface SessionDraft {
  body: RichDocument;
  category: EntryData['category'];
  expected: string;
  actual: string;
}
export interface SessionData {
  charter: string;
  state: 'active' | 'paused' | 'completed';
  startedAt: string;
  endedAt?: string;
  environment: Environment;
  focusAreas: { text: string; checked: boolean }[];
  conclusion: string;
  exclusions: string;
  durationSeconds: number;
  activeSince?: string;
  timeboxMinutes?: number;
  draft?: SessionDraft;
}
export interface EntryData {
  sessionId: string;
  category: 'observation' | 'passed' | 'issue' | 'question' | 'idea';
  expected: string;
  actual: string;
  evidenceIds: string[];
  findingId?: string;
  caseId?: string;
  private: boolean;
}
export interface Retest {
  id: string;
  at: string;
  environment: Environment;
  outcome: Outcome;
  notes: string;
  evidenceIds: string[];
}
export interface FindingData {
  private?: boolean;
  sourceEntryId?: string;
  duplicateOf?: string;
  code: string;
  status: FindingStatus;
  severity: Severity;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  type: 'defect' | 'improvement' | 'risk';
  steps: string[];
  expected: string;
  actual: string;
  impact: string;
  environment: Environment;
  frequency: string;
  suspectedCause: string;
  confirmedCause: string;
  workaround: string;
  resolution: string;
  relatedIds: string[];
  evidenceIds: string[];
  caseIds: string[];
  retests: Retest[];
  owner: string;
  component: string;
}
export interface TestStep {
  id: string;
  action: string;
  expected: string;
}
export interface CaseData {
  private?: boolean;
  sourceEntryId?: string;
  evidenceIds?: string[];
  prerequisites: string;
  steps: TestStep[];
  folder: string;
  requirementIds: string[];
  datasets: { id: string; name: string; values: Record<string, string> }[];
  priority: 'high' | 'normal' | 'low';
  automated: boolean;
}
export interface Execution {
  id: string;
  caseId: string;
  caseTitle: string;
  caseRevision: number;
  datasetId?: string;
  requirementIds?: string[];
  stepReasons?: Record<string, string>;
  steps: TestStep[];
  prerequisites: string;
  dataset?: { name: string; values: Record<string, string> };
  outcome: Outcome;
  reason: string;
  notes: string;
  stepResults: Record<string, Outcome>;
  findingIds: string[];
  evidenceIds: string[];
  updatedAt: string;
  durationMs?: number;
}
export interface RunData {
  private?: boolean;
  state: 'active' | 'completed';
  environment: Environment;
  executions: Execution[];
  conclusion: string;
  exclusions: string;
  startedAt: string;
  completedAt?: string;
  source?: { format: string; filename: string; fingerprint: string; importedAt: string };
}
export interface RequirementData {
  code: string;
  description: string;
  acceptanceCriteria: string;
  priority: 'high' | 'normal' | 'low';
  owner: string;
}
export interface Annotation {
  id: string;
  tool: 'arrow' | 'rectangle' | 'ellipse' | 'highlight' | 'text' | 'number' | 'redact';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text?: string;
  stroke?: number;
}
export interface EvidenceData {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string;
  width?: number;
  height?: number;
  caption: string;
  annotations: Annotation[];
  crop?: { x: number; y: number; width: number; height: number };
  private: boolean;
  originalAssetId?: string;
  sanitizedAssetId?: string;
  source: 'capture' | 'paste' | 'import';
  timestampReferences?: { seconds: number; label: string }[];
}
export interface TemplateField {
  id: string;
  label: string;
  type: 'text' | 'multiline' | 'number' | 'date' | 'checkbox' | 'select' | 'multiselect';
  required: boolean;
  options?: string[];
}
export interface TemplateData {
  targetKind: 'document' | 'session' | 'finding' | 'case';
  description: string;
  icon: string;
  builtIn: boolean;
  fields: TemplateField[];
  sections: { id: string; title: string; guidance: string }[];
  defaults: Record<string, unknown>;
}
export interface DataMap {
  document: DocumentData;
  session: SessionData;
  entry: EntryData;
  finding: FindingData;
  case: CaseData;
  run: RunData;
  requirement: RequirementData;
  evidence: EvidenceData;
  template: TemplateData;
}
export interface Entity<K extends EntityKind = EntityKind> {
  id: string;
  projectId: string;
  kind: K;
  title: string;
  body: RichDocument;
  tags: string[];
  data: DataMap[K];
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export type AnyEntity = { [K in EntityKind]: Entity<K> }[EntityKind];
export interface RecordQuery {
  projectId: string;
  kind?: EntityKind;
  search?: string;
  includeDeleted?: boolean;
  limit?: number;
  cursor?: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}
export interface AppSettings {
  language: 'hu' | 'en';
  theme: 'light' | 'dark' | 'system';
  density: 'comfortable' | 'compact';
  editorFontSize: number;
  lastProjectId: string | null;
  lastView: string;
  onboardingComplete: boolean;
  author: string;
  pageSize: 'A4' | 'LETTER';
  backupEnabled: boolean;
  shortcuts: Record<string, string>;
}
export interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string;
  width?: number;
  height?: number;
}
export interface Revision {
  id: string;
  entityId: string;
  revision: number;
  at: string;
  title: string;
  entity: AnyEntity;
}
export interface ChangeEvent {
  id: string;
  projectId: string;
  entityId: string;
  kind: string;
  operation: 'create' | 'update' | 'delete' | 'restore';
  revision: number;
  deviceId: string;
  actorId: string;
  at: string;
}
export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  fieldErrors?: Record<string, string>;
}
export interface CaptureCapabilities {
  supported: boolean;
  targets: ('screen' | 'window' | 'region')[];
  permission: 'granted' | 'prompt' | 'denied' | 'unavailable';
  reason?: string;
}
export interface BackupInfo {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  size: number;
  valid: boolean;
}
export interface StorageInfo {
  location: string;
  databaseBytes: number;
  assetBytes: number;
  backupBytes: number;
  projectCount: number;
}
export interface ReportOptions {
  format: 'pdf' | 'docx' | 'html' | 'markdown' | 'csv' | 'json';
  title: string;
  author: string;
  pageSize: 'A4' | 'LETTER';
  includeEvidence: boolean;
  includePrivate: boolean;
  includeHistory: boolean;
  scope: 'project' | 'selected';
  entityIds: string[];
}
export interface ReportSnapshot {
  schemaVersion: 1;
  project: Project;
  records: AnyEntity[];
  generatedAt: string;
  options: ReportOptions;
  assets: Record<string, { mimeType: string; bytes: Uint8Array; filename: string }>;
}
