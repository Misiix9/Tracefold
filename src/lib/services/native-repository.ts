import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceRepository } from './repository';
import type { ProjectImport } from './repository';
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

/** Native commands own paths, dialogs, transactions and conflict checks. */
export class NativeRepository implements WorkspaceRepository {
  readonly mode = 'desktop' as const;
  listProjects() {
    return invoke<Project[]>('list_projects');
  }
  saveProject(project: Project, expectedRevision: number) {
    return invoke<Project>('save_project', { project, expectedRevision });
  }
  listRecords(query: RecordQuery) {
    return invoke<Page<AnyEntity>>('list_records', { query });
  }
  getRecord(id: string, projectId: string) {
    return invoke<AnyEntity | null>('get_record', { id, projectId });
  }
  saveRecord<K extends EntityKind>(record: Entity<K>, expectedRevision: number) {
    return invoke<Entity<K>>('save_record', { record, expectedRevision });
  }
  deleteRecord(id: string, projectId: string, expectedRevision: number) {
    return invoke<void>('delete_record', { id, projectId, expectedRevision });
  }
  restoreRecord(id: string, projectId: string, expectedRevision: number) {
    return invoke<AnyEntity>('restore_record', { id, projectId, expectedRevision });
  }
  getRevisions(id: string, projectId: string) {
    return invoke<Revision[]>('get_revisions', { id, projectId });
  }
  getSettings() {
    return invoke<AppSettings>('get_settings');
  }
  saveSettings(settings: AppSettings) {
    return invoke<void>('save_settings', { settings });
  }
  importAsset(projectId: string, filename: string, mimeType: string, bytes: Uint8Array) {
    return invoke<Asset>('import_asset', bytes, {
      headers: {
        'x-project-id': projectId,
        'x-filename': encodeURIComponent(filename),
        'x-mime-type': encodeURIComponent(mimeType),
      },
    });
  }
  async readAsset(projectId: string, assetId: string) {
    return new Uint8Array(await invoke<ArrayBuffer>('read_asset', { projectId, assetId }));
  }
  captureCapabilities() {
    return invoke<CaptureCapabilities>('capture_capabilities');
  }
  captureScreen(projectId: string) {
    return invoke<Asset | null>('capture_screen', { projectId });
  }
  saveFile(filename: string, mimeType: string, bytes: Uint8Array) {
    return invoke<boolean>('save_file', bytes, {
      headers: {
        'x-filename': encodeURIComponent(filename),
        'x-mime-type': encodeURIComponent(mimeType),
      },
    });
  }
  createBackup(projectId: string) {
    return invoke<BackupInfo>('create_backup', { projectId });
  }
  listBackups(projectId: string) {
    return invoke<BackupInfo[]>('list_backups', { projectId });
  }
  restoreBackup(id: string, projectId: string) {
    return invoke<Project>('restore_backup', { id, projectId });
  }
  exportBackupFile(id: string, projectId: string) {
    return invoke<boolean>('export_backup_file', { id, projectId });
  }
  restoreBackupFile() {
    return invoke<Project | null>('restore_backup_file');
  }
  storageInfo() {
    return invoke<StorageInfo>('storage_info');
  }
  importProject(input: ProjectImport) {
    return invoke<Project>('import_project', {
      input: { ...input, assets: input.assets.map((a) => ({ ...a, bytes: Array.from(a.bytes) })) },
    });
  }
}
