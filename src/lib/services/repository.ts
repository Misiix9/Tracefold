import type {
  AnyEntity,
  AppSettings,
  Asset,
  BackupInfo,
  CaptureCapabilities,
  Entity,
  EntityKind,
  Page,
  Project,
  RecordQuery,
  Revision,
  StorageInfo,
} from '../domain/types';
export interface ProjectImport {
  project: Project;
  records: AnyEntity[];
  assets: { asset: Asset; bytes: Uint8Array }[];
  sourceProjectId: string;
}
/** All persistence crosses this port. A future authenticated transport can implement it without changing views. */
export interface WorkspaceRepository {
  readonly mode: 'desktop' | 'browser';
  listProjects(): Promise<Project[]>;
  saveProject(project: Project, expectedRevision: number): Promise<Project>;
  listRecords(query: RecordQuery): Promise<Page<AnyEntity>>;
  getRecord(id: string, projectId: string): Promise<AnyEntity | null>;
  saveRecord<K extends EntityKind>(record: Entity<K>, expectedRevision: number): Promise<Entity<K>>;
  deleteRecord(id: string, projectId: string, expectedRevision: number): Promise<void>;
  restoreRecord(id: string, projectId: string, expectedRevision: number): Promise<AnyEntity>;
  getRevisions(id: string, projectId: string): Promise<Revision[]>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  importAsset(
    projectId: string,
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<Asset>;
  readAsset(projectId: string, assetId: string): Promise<Uint8Array>;
  captureCapabilities(): Promise<CaptureCapabilities>;
  captureScreen(projectId: string): Promise<Asset | null>;
  saveFile(filename: string, mimeType: string, bytes: Uint8Array): Promise<boolean>;
  createBackup(projectId: string): Promise<BackupInfo>;
  listBackups(projectId: string): Promise<BackupInfo[]>;
  restoreBackup(id: string, projectId: string): Promise<Project>;
  exportBackupFile(id: string, projectId: string): Promise<boolean>;
  restoreBackupFile(): Promise<Project | null>;
  storageInfo(): Promise<StorageInfo>;
  importProject(input: ProjectImport): Promise<Project>;
}
