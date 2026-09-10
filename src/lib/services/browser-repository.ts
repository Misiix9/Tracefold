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
import { normalizeLanguage } from '../i18n/i18n.svelte';
import { remapRestoredRecord } from '../domain/references';
import { defaultSettings, plainText } from '../domain/defaults';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction cancelled'));
    tx.onerror = () => reject(tx.error);
  });
}
const conflict = () =>
  Object.assign(new Error('This record changed in another window. Reload it before saving.'), {
    code: 'REVISION_CONFLICT',
    retryable: false,
  });
const missing = () =>
  Object.assign(new Error('This record is no longer available in this project.'), {
    code: 'NOT_FOUND',
    retryable: false,
  });
interface StoredAsset extends Asset {
  projectId: string;
  bytes: Uint8Array;
}
interface StoredBackup extends BackupInfo {
  project: Project;
  records: AnyEntity[];
  assets: StoredAsset[];
  history?: Revision[];
}

/** Persistent browser preview adapter. Desktop uses native SQLite exclusively. */
export class BrowserRepository implements WorkspaceRepository {
  readonly mode = 'browser' as const;
  async importProject(input: ProjectImport) {
    const db = await this.db;
    const tx = db.transaction(['projects', 'records', 'assets'], 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore('projects');
    if (await request(store.get(input.project.id))) {
      tx.abort();
      await done.catch(() => {});
      throw conflict();
    }
    const project = { ...clone(input.project), revision: 1 };
    store.add(project);
    for (const record of input.records)
      tx.objectStore('records').add({ ...clone(record), revision: 1 });
    for (const { asset, bytes } of input.assets)
      tx.objectStore('assets').put({
        ...asset,
        id: project.id + ':' + asset.hash,
        projectId: project.id,
        bytes: new Uint8Array(bytes),
      });
    await done;
    return project;
  }
  private db: Promise<IDBDatabase>;
  constructor(name = 'tracefold-preview-v1') {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const name of ['projects', 'records', 'assets', 'history', 'backups'])
          db.createObjectStore(name, { keyPath: 'id' });
        db.createObjectStore('settings');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  private async all<T>(name: string): Promise<T[]> {
    const db = await this.db;
    return request(db.transaction(name).objectStore(name).getAll());
  }
  async listProjects() {
    return (await this.all<Project>('projects')).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  async saveProject(project: Project, expectedRevision: number) {
    const db = await this.db;
    const tx = db.transaction('projects', 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore('projects');
    const current = await request<Project | undefined>(store.get(project.id));
    if ((current?.revision ?? 0) !== expectedRevision) {
      tx.abort();
      await done.catch(() => {});
      throw conflict();
    }
    const saved = {
      ...clone(project),
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    store.put(saved);
    await done;
    return saved;
  }
  async listRecords(q: RecordQuery): Promise<Page<AnyEntity>> {
    const search = q.search?.trim().toLowerCase();
    const all = (await this.all<AnyEntity>('records'))
      .filter(
        (r) =>
          r.projectId === q.projectId &&
          (q.includeDeleted || !r.deletedAt) &&
          (!q.kind || r.kind === q.kind) &&
          (!search ||
            [r.title, plainText(r.body), r.tags.join(' '), JSON.stringify(r.data)]
              .join(' ')
              .toLowerCase()
              .includes(search)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const offset = Number(q.cursor ?? 0);
    const limit = Math.max(1, Math.min(q.limit ?? 100, 1000));
    return {
      items: all.slice(offset, offset + limit),
      total: all.length,
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    };
  }
  async getRecord(id: string, projectId: string) {
    const db = await this.db;
    const record = await request<AnyEntity | undefined>(
      db.transaction('records').objectStore('records').get(id),
    );
    return record?.projectId === projectId ? record : null;
  }
  async saveRecord<K extends EntityKind>(
    record: Entity<K>,
    expectedRevision: number,
  ): Promise<Entity<K>> {
    const db = await this.db;
    const tx = db.transaction(['records', 'history', 'projects'], 'readwrite');
    const done = complete(tx);
    const records = tx.objectStore('records');
    const current = await request<AnyEntity | undefined>(records.get(record.id));
    const project = await request<Project | undefined>(
      tx.objectStore('projects').get(record.projectId),
    );
    if (!project || (current && current.projectId !== record.projectId)) {
      tx.abort();
      await done.catch(() => {});
      throw missing();
    }
    if ((current?.revision ?? 0) !== expectedRevision) {
      tx.abort();
      await done.catch(() => {});
      throw conflict();
    }
    const at = new Date().toISOString();
    const saved = {
      ...clone(record),
      revision: expectedRevision + 1,
      createdAt: current?.createdAt ?? record.createdAt,
      updatedAt: at,
    };
    if (current)
      tx.objectStore('history').put({
        id: crypto.randomUUID(),
        entityId: current.id,
        revision: current.revision,
        at: current.updatedAt,
        title: current.title,
        entity: current,
      });
    records.put(saved);
    tx.objectStore('projects').put({ ...project, updatedAt: at });
    await done;
    return saved;
  }
  async deleteRecord(id: string, projectId: string, expectedRevision: number) {
    const record = await this.getRecord(id, projectId);
    if (!record) throw missing();
    await this.saveRecord({ ...record, deletedAt: new Date().toISOString() }, expectedRevision);
  }
  async restoreRecord(id: string, projectId: string, expectedRevision: number) {
    const record = await this.getRecord(id, projectId);
    if (!record) throw missing();
    return this.saveRecord({ ...record, deletedAt: null }, expectedRevision) as Promise<AnyEntity>;
  }
  async getRevisions(id: string, projectId: string) {
    const history = (await this.all<Revision>('history')).filter(
      (r) => r.entityId === id && r.entity.projectId === projectId,
    );
    const current = await this.getRecord(id, projectId);
    if (current && !history.some((h) => h.revision === current.revision))
      history.push({
        id: current.id + ':' + current.revision,
        entityId: current.id,
        revision: current.revision,
        at: current.updatedAt,
        title: current.title,
        entity: current,
      });
    return history.sort((a, b) => b.revision - a.revision);
  }
  async getSettings() {
    const db = await this.db;
    const saved = await request<AppSettings | undefined>(
      db.transaction('settings').objectStore('settings').get('main'),
    );
    return { ...clone(defaultSettings), ...saved, language: normalizeLanguage(saved?.language) };
  }
  async saveSettings(settings: AppSettings) {
    const db = await this.db;
    const tx = db.transaction('settings', 'readwrite');
    const done = complete(tx);
    tx.objectStore('settings').put(clone(settings), 'main');
    await done;
  }
  async importAsset(
    projectId: string,
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<Asset> {
    if (!(await this.listProjects()).some((p) => p.id === projectId)) throw missing();
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    const asset: StoredAsset = {
      id: projectId + ':' + hash,
      projectId,
      filename,
      mimeType,
      size: bytes.byteLength,
      hash,
      bytes: new Uint8Array(bytes),
    };
    const db = await this.db;
    const tx = db.transaction('assets', 'readwrite');
    const done = complete(tx);
    tx.objectStore('assets').put(asset);
    await done;
    const { bytes: _, projectId: __, ...result } = asset;
    return result;
  }
  async readAsset(projectId: string, assetId: string) {
    const db = await this.db;
    const asset = await request<StoredAsset | undefined>(
      db.transaction('assets').objectStore('assets').get(assetId),
    );
    if (!asset || asset.projectId !== projectId) throw missing();
    return new Uint8Array(asset.bytes);
  }
  async captureCapabilities(): Promise<CaptureCapabilities> {
    return {
      supported: false,
      targets: [],
      permission: 'unavailable',
      reason: 'Use the desktop app to capture screens. You can paste or import a screenshot here.',
    };
  }
  async captureScreen(_projectId: string): Promise<Asset | null> {
    throw new Error(
      'Screen capture is available in the desktop app. Paste or import an image in the preview.',
    );
  }
  async saveFile(filename: string, mimeType: string, bytes: Uint8Array) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }
  async createBackup(projectId: string): Promise<BackupInfo> {
    const db = await this.db;
    const tx = db.transaction(['projects', 'records', 'assets', 'history', 'backups'], 'readwrite');
    const done = complete(tx);
    const project = await request<Project | undefined>(tx.objectStore('projects').get(projectId));
    if (!project) {
      tx.abort();
      await done.catch(() => {});
      throw missing();
    }
    const records = (await request<AnyEntity[]>(tx.objectStore('records').getAll())).filter(
      (r) => r.projectId === projectId,
    );
    const assets = (await request<StoredAsset[]>(tx.objectStore('assets').getAll())).filter(
      (a) => a.projectId === projectId,
    );
    const history = (await request<Revision[]>(tx.objectStore('history').getAll())).filter(
      (r) => r.entity.projectId === projectId,
    );
    const backup: StoredBackup = {
      id: crypto.randomUUID(),
      projectId,
      name: project.name,
      createdAt: new Date().toISOString(),
      size: JSON.stringify(records).length + assets.reduce((n, a) => n + a.size, 0),
      valid: true,
      project,
      records,
      assets,
      history,
    };
    tx.objectStore('backups').put(backup);
    await done;
    const { project: _, records: __, assets: ___, history: ____, ...info } = backup;
    return info;
  }
  async listBackups(projectId: string) {
    return (await this.all<StoredBackup>('backups'))
      .filter((b) => b.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ project, records, assets, history, ...info }) => info);
  }
  async exportBackupFile(_id: string, _projectId: string): Promise<boolean> {
    throw { code: 'UNSUPPORTED', message: 'Backup files are available in the desktop app.' };
  }
  async restoreBackupFile(): Promise<Project | null> {
    throw { code: 'UNSUPPORTED', message: 'Backup files are available in the desktop app.' };
  }
  async restoreBackup(id: string, projectId: string) {
    const backup = (await this.all<StoredBackup>('backups')).find(
      (b) => b.id === id && b.projectId === projectId,
    );
    if (!backup) throw missing();
    const restoredSuffix =
      (await this.getSettings()).language === 'hu' ? 'visszaállítva' : 'restored';
    const db = await this.db,
      tx = db.transaction(['projects', 'records', 'assets', 'history'], 'readwrite'),
      done = complete(tx),
      at = new Date().toISOString();
    const project = {
      ...backup.project,
      id: crypto.randomUUID(),
      name: backup.project.name + ' — ' + restoredSuffix,
      archived: false,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    const ids = new Map(backup.records.map((r) => [r.id, crypto.randomUUID()])),
      assets = new Map(backup.assets.map((a) => [a.id, project.id + ':' + a.hash]));
    tx.objectStore('projects').add(project);
    for (const record of backup.records)
      tx.objectStore('records').add(remapRestoredRecord(record, project.id, ids, assets));
    for (const asset of backup.assets)
      tx.objectStore('assets').put({ ...asset, id: assets.get(asset.id), projectId: project.id });
    for (const revision of backup.history ?? []) {
      const entity = remapRestoredRecord(revision.entity, project.id, ids, assets);
      tx.objectStore('history').add({
        ...revision,
        id: crypto.randomUUID(),
        entityId: entity.id,
        entity,
      });
    }
    await done;
    return project;
  }
  async storageInfo(): Promise<StorageInfo> {
    const records = await this.all<AnyEntity>('records');
    const assets = await this.all<StoredAsset>('assets');
    const backups = await this.all<StoredBackup>('backups');
    return {
      location: 'Browser preview storage (IndexedDB)',
      databaseBytes: JSON.stringify(records).length,
      assetBytes: assets.reduce((n, a) => n + a.size, 0),
      backupBytes: backups.reduce((n, b) => n + b.size, 0),
      projectCount: (await this.listProjects()).length,
    };
  }
}
