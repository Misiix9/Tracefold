import type {
  AnyEntity,
  AppSettings,
  DataMap,
  Entity,
  EntityKind,
  Project,
  RichDocument,
} from '../domain/types';
import { createEntity, defaultData, defaultSettings, newId } from '../domain/defaults';
import { checkpointSession, transitionSession } from '../domain/sessions';
import type { WorkspaceRepository } from './repository';
import { errorText } from '../i18n/errors';
import { t, setLanguage, normalizeLanguage } from '../i18n/i18n.svelte';

export class Workspace {
  repo: WorkspaceRepository;
  projects = $state<Project[]>([]);
  records = $state<AnyEntity[]>([]);
  settings = $state<AppSettings>({ ...defaultSettings });
  projectId = $state('');
  selectedId = $state<string | null>(null);
  view = $state('notebook');
  loading = $state(true);
  error = $state('');
  saveStatus = $state<'saved' | 'saving' | 'error'>('saved');
  notification = $state('');
  private pending = new Map<string, AnyEntity>();
  private revisions = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | null = null;
  private alertTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionTimer: ReturnType<typeof setInterval>;
  private activeOperations = 0;
  /** Capture/import/export must finish before closing or replacing the app. */
  beginOperation() {
    this.activeOperations++;
    let finished = false;
    return () => {
      if (!finished) {
        this.activeOperations--;
        finished = true;
      }
    };
  }
  constructor(repo: WorkspaceRepository) {
    this.repo = repo;
    this.sessionTimer = setInterval(() => {
      this.checkpointSessions(false);
    }, 15000);
  }
  private checkpointSessions(pause: boolean) {
    for (const r of this.visible)
      if (r.kind === 'session' && r.data.state === 'active')
        this.edit({
          ...r,
          data: pause ? transitionSession(r.data, 'paused') : checkpointSession(r.data),
        });
  }
  private settingsWrite: Promise<void> = Promise.resolve();
  private persistSettings() {
    const snapshot = $state.snapshot(this.settings);
    const next = this.settingsWrite.catch(() => {}).then(() => this.repo.saveSettings(snapshot));
    this.settingsWrite = next;
    return next;
  }
  async prepareToClose() {
    if (this.activeOperations)
      throw new Error(t('Wait for the current file operation to finish, then try again.'));
    this.checkpointSessions(true);
    await this.flush();
    await this.settingsWrite.catch(() => this.persistSettings());
  }
  get project() {
    return this.projects.find((p) => p.id === this.projectId);
  }
  get selected() {
    return this.records.find((r) => r.id === this.selectedId) ?? null;
  }
  get visible() {
    return this.records.filter((r) => !r.deletedAt);
  }
  async initialize() {
    try {
      this.settings = await this.repo.getSettings();
      this.settings.language = normalizeLanguage(this.settings.language);
      setLanguage(this.settings.language);
      this.projects = await this.repo.listProjects();
      if (!this.projects.length)
        await this.createProject(
          t('Inbox'),
          t('A place to capture thoughts before you organize them.'),
          'IN',
        );
      const id =
        this.projects.find((p) => p.id === this.settings.lastProjectId && !p.archived)?.id ??
        this.projects.find((p) => !p.archived)?.id;
      if (id) await this.openProject(id);
      this.view = this.settings.lastView || 'notebook';
    } catch (e) {
      this.fail(e);
    } finally {
      this.loading = false;
    }
  }
  async createProject(name: string, description = '', prefix = 'TF') {
    const at = new Date().toISOString();
    const project = await this.repo.saveProject(
      {
        id: newId(),
        name: name.trim() || t('Untitled project'),
        description,
        prefix: prefix.trim().toUpperCase().slice(0, 8) || 'TF',
        color: '#783D49',
        archived: false,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      },
      0,
    );
    this.projects = [project, ...this.projects];
    return project;
  }
  async openProject(id: string) {
    this.checkpointSessions(true);
    await this.flush();
    this.loading = true;
    try {
      let cursor: string | undefined;
      const records: AnyEntity[] = [];
      do {
        const page = await this.repo.listRecords({
          projectId: id,
          includeDeleted: true,
          limit: 500,
          cursor,
        });
        records.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      this.projectId = id;
      this.records = records;
      this.revisions = new Map(records.map((r) => [r.id, r.revision]));
      for (const r of records)
        if (r.kind === 'session' && r.data.state === 'active')
          this.edit({ ...r, data: { ...r.data, state: 'paused', activeSince: undefined } });
      this.selectedId = null;
      this.settings.lastProjectId = id;
      await this.persistSettings();
    } finally {
      this.loading = false;
    }
  }
  async reload() {
    if (this.projectId) await this.openProject(this.projectId);
  }
  async create<K extends EntityKind>(
    kind: K,
    title: string,
    data?: DataMap[K],
    body?: RichDocument,
  ): Promise<Entity<K>> {
    const record = createEntity(this.projectId, kind, title, data ?? defaultData(kind), body);
    const saved = await this.repo.saveRecord(record, 0);
    this.records = [saved as AnyEntity, ...this.records];
    this.revisions.set(saved.id, saved.revision);
    return saved;
  }
  edit(record: AnyEntity) {
    const local = JSON.parse(JSON.stringify(record)) as AnyEntity;
    local.updatedAt = new Date().toISOString();
    this.records = this.records.map((r) => (r.id === local.id ? local : r));
    this.pending.set(local.id, local);
    this.saveStatus = 'saving';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch((e) => this.fail(e));
    }, 250);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.draining) {
      await this.draining;
      if (this.pending.size) return this.flush();
      return;
    }
    if (!this.pending.size) return;
    this.draining = this.drain();
    try {
      await this.draining;
    } finally {
      this.draining = null;
    }
  }
  private async drain() {
    while (this.pending.size) {
      const [id, record] = this.pending.entries().next().value!;
      this.pending.delete(id);
      try {
        const expected = this.revisions.get(id) ?? record.revision;
        const saved = await this.repo.saveRecord({ ...record, revision: expected }, expected);
        this.revisions.set(id, saved.revision);
        this.records = this.records.map((r) =>
          r.id === id
            ? this.pending.has(id)
              ? { ...r, revision: saved.revision }
              : (saved as AnyEntity)
            : r,
        );
      } catch (e) {
        if (!this.pending.has(id)) this.pending.set(id, record);
        this.saveStatus = 'error';
        throw e;
      }
    }
    this.saveStatus = 'saved';
  }
  async remove(id: string) {
    await this.flush();
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    await this.repo.deleteRecord(id, this.projectId, record.revision);
    const updated = await this.repo.getRecord(id, this.projectId);
    if (updated) {
      this.records = this.records.map((r) => (r.id === id ? updated : r));
      this.revisions.set(id, updated.revision);
    }
    if (this.selectedId === id) this.selectedId = null;
    this.notify('Moved to Trash. You can restore it in Settings.');
  }
  async restore(id: string) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    const saved = await this.repo.restoreRecord(id, this.projectId, record.revision);
    this.records = this.records.map((r) => (r.id === id ? saved : r));
    this.revisions.set(id, saved.revision);
    this.notify('Restored');
  }
  navigate(view: string, id: string | null = null) {
    this.view = view;
    this.selectedId = id;
    this.settings.lastView = view;
    void this.persistSettings().catch((e) => this.fail(e));
  }
  async setSettings(values: Partial<AppSettings>) {
    this.settings = { ...this.settings, ...values };
    this.settings.language = normalizeLanguage(this.settings.language);
    setLanguage(this.settings.language);
    await this.persistSettings();
  }
  fail(error: unknown) {
    this.error = errorText(error);
  }
  notify(message: string) {
    this.notification = t(message);
    clearTimeout(this.alertTimer);
    this.alertTimer = setTimeout(() => {
      this.notification = '';
    }, 4500);
  }
  dispose() {
    clearTimeout(this.timer);
    clearTimeout(this.alertTimer);
    clearInterval(this.sessionTimer);
  }
}
