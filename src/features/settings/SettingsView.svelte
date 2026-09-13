<script lang="ts">
  import { t, codeLabel, intlLocale, date, number } from '../../lib/i18n/i18n.svelte';

  import { onMount } from 'svelte';
  import UpdateSettings from '../updates/UpdateSettings.svelte';
  import type { AppUpdater } from '../../lib/services/updater.svelte';
  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { BackupInfo, StorageInfo } from '../../lib/domain/types';
  import Icon from '../../lib/ui/Icon.svelte';
  import TextField from '../../lib/ui/TextField.svelte';
  import ImportProject from './ImportProject.svelte';
  import { createSample } from '../../lib/services/sample';
  let { workspace, updater }: { workspace: Workspace; updater: AppUpdater } = $props();
  let backups = $state<BackupInfo[]>([]),
    storage = $state<StorageInfo | null>(null),
    busy = $state(false),
    name = $state(''),
    description = $state(''),
    prefix = $state('');
  const trash = $derived(workspace.records.filter((r) => r.deletedAt));
  onMount(() => {
    name = workspace.project?.name ?? '';
    description = workspace.project?.description ?? '';
    prefix = workspace.project?.prefix ?? '';
    void refresh();
  });
  async function refresh() {
    try {
      [backups, storage] = await Promise.all([
        workspace.repo.listBackups(workspace.projectId),
        workspace.repo.storageInfo(),
      ]);
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function backup() {
    busy = true;
    const finishOperation = workspace.beginOperation();
    try {
      await workspace.flush();
      await workspace.repo.createBackup(workspace.projectId);
      await refresh();
      workspace.notify(t('Verified local backup created'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
      finishOperation();
    }
  }
  async function restore(id: string) {
    busy = true;
    const finishOperation = workspace.beginOperation();
    try {
      const project = await workspace.repo.restoreBackup(id, workspace.projectId);
      workspace.projects = await workspace.repo.listProjects();
      await workspace.openProject(project.id);
      workspace.navigate('notebook');
      workspace.notify(t('Restored as a separate project. The original is unchanged.'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
      finishOperation();
    }
  }
  async function exportBackup(id?: string) {
    busy = true;
    const finishOperation = workspace.beginOperation();
    try {
      await workspace.flush();
      const projectId = workspace.projectId;
      const backupId = id ?? (await workspace.repo.createBackup(projectId)).id;
      const saved = await workspace.repo.exportBackupFile(backupId, projectId);
      await refresh();
      if (saved) workspace.notify(t('Backup file saved'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
      finishOperation();
    }
  }
  async function restoreFile() {
    busy = true;
    const finishOperation = workspace.beginOperation();
    try {
      await workspace.flush();
      const project = await workspace.repo.restoreBackupFile();
      if (!project) return;
      workspace.projects = await workspace.repo.listProjects();
      await workspace.openProject(project.id);
      workspace.navigate('notebook');
      workspace.notify(t('Restored as a separate project. The original is unchanged.'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
      finishOperation();
    }
  }
  async function saveProject() {
    if (!workspace.project) return;
    try {
      const p = await workspace.repo.saveProject(
        { ...$state.snapshot(workspace.project), name, description, prefix },
        workspace.project.revision,
      );
      workspace.projects = workspace.projects.map((old) => (old.id === p.id ? p : old));
      workspace.notify(t('Project details saved'));
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function archive() {
    if (!workspace.project) return;
    busy = true;
    const finishOperation = workspace.beginOperation();
    try {
      await workspace.flush();
      await workspace.repo.saveProject(
        { ...$state.snapshot(workspace.project), archived: true },
        workspace.project.revision,
      );
      workspace.projects = await workspace.repo.listProjects();
      const next =
        workspace.projects.find((p) => !p.archived) ?? (await workspace.createProject(t('Inbox')));
      await workspace.openProject(next.id);
      workspace.navigate('notebook');
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
      finishOperation();
    }
  }
</script>

<section class="page settings-page">
  <div class="page-heading">
    <div>
      <h1>{t('Make room for your work')}</h1>
      <p>{t('Your workspace, your preferences, your recovery options.')}</p>
    </div>
  </div>
  {#if workspace.repo.mode === 'desktop'}<UpdateSettings {updater} {workspace} />{/if}
  <div class="settings-section">
    <div>
      <h2>{t('Appearance')}</h2>
      <p>{t('Comfortable for long testing sessions.')}</p>
    </div>
    <div class="form-stack">
      <label class="field">
        <span class="field-label" id="language-label">{t('Language')}</span>
        <select
          aria-labelledby="language-label"
          aria-describedby="language-hint"
          value={workspace.settings.language}
          onchange={(e) =>
            workspace
              .setSettings({ language: e.currentTarget.value as 'hu' | 'en' })
              .catch((e) => workspace.fail(e))}
        >
          <option value="hu" lang="hu">Magyar</option>
          <option value="en" lang="en">English</option>
        </select>
        <small id="language-hint"
          >{t('Changes apply immediately. Your own content stays in its original language.')}</small
        >
      </label>
      <div class="form-grid">
        <label class="field"
          ><span class="field-label">{t('Theme')}</span><select
            value={workspace.settings.theme}
            onchange={(e) =>
              workspace
                .setSettings({ theme: e.currentTarget.value as 'light' | 'dark' | 'system' })
                .catch((e) => workspace.fail(e))}
            ><option value="system">{t('Follow system')}</option><option value="light"
              >{t('Parchment')}</option
            ><option value="dark">{t('Evening')}</option></select
          ></label
        ><label class="field"
          ><span class="field-label">{t('Density')}</span><select
            value={workspace.settings.density}
            onchange={(e) =>
              workspace
                .setSettings({ density: e.currentTarget.value as 'comfortable' | 'compact' })
                .catch((e) => workspace.fail(e))}
            ><option value="comfortable">{t('Comfortable')}</option><option value="compact"
              >{t('Compact')}</option
            ></select
          ></label
        >
      </div>
      <label class="field"
        ><span class="field-label">{t('Writing size ·')} {workspace.settings.editorFontSize}px</span
        ><input
          type="range"
          min="13"
          max="22"
          value={workspace.settings.editorFontSize}
          onchange={(e) =>
            workspace
              .setSettings({ editorFontSize: Number(e.currentTarget.value) })
              .catch((e) => workspace.fail(e))}
        /></label
      >
    </div>
  </div>
  <div class="settings-section">
    <div>
      <h2>{t('Report defaults')}</h2>
      <p>{t('Prefill details when you prepare an export.')}</p>
    </div>
    <div class="form-stack">
      <TextField
        label={t('Author')}
        value={workspace.settings.author}
        onchange={(author) =>
          void workspace.setSettings({ author }).catch((e) => workspace.fail(e))}
      /><label class="field"
        ><span class="field-label">{t('Paper size')}</span><select
          value={workspace.settings.pageSize}
          onchange={(e) =>
            workspace
              .setSettings({ pageSize: e.currentTarget.value as 'A4' | 'LETTER' })
              .catch((e) => workspace.fail(e))}
          ><option value="A4">A4</option><option value="LETTER">{t('US Letter')}</option></select
        ></label
      >
    </div>
  </div>
  <div class="settings-section">
    <div>
      <h2>{t('Current project')}</h2>
      <p>{t('Keep its purpose and references clear.')}</p>
    </div>
    <div class="form-stack">
      <TextField label={t('Project name')} value={name} onchange={(v) => (name = v)} /><TextField
        label={t('Description')}
        multiline
        value={description}
        onchange={(v) => (description = v)}
      /><TextField label={t('Finding prefix')} value={prefix} onchange={(v) => (prefix = v)} />
      <div class="button-row">
        <button class="button" onclick={saveProject} disabled={!name.trim()}
          >{t('Save project details')}</button
        ><button class="button ghost" disabled={busy} onclick={archive}
          >{t('Archive project')}</button
        >
      </div>
    </div>
  </div>
  <div class="settings-section">
    <div>
      <h2>{t('Portable projects')}</h2>
      <p>{t('Open a reviewed handoff from another tester or another device.')}</p>
    </div>
    <div><ImportProject {workspace} /></div>
  </div>
  <div class="settings-section">
    <div>
      <h2>{t('Backup & recovery')}</h2>
      <p>
        {t(
          'Backups include private content and original evidence. A restore opens a separate copy.',
        )}
      </p>
    </div>
    <div class="form-stack">
      <label class="check-row"
        ><input
          type="checkbox"
          checked={workspace.settings.backupEnabled}
          onchange={(e) =>
            workspace
              .setSettings({ backupEnabled: e.currentTarget.checked })
              .catch((e) => workspace.fail(e))}
        />{t('Create automatic local backups')}</label
      >
      <div class="button-row">
        <button class="button" disabled={busy} onclick={backup}
          ><Icon name="shield" size={15} />{busy ? t('Working…') : t('Back up now')}</button
        ><button class="button ghost" disabled={busy} onclick={refresh}>{t('Refresh')}</button>
        {#if workspace.repo.mode === 'desktop'}
          <button class="button" disabled={busy} onclick={() => exportBackup()}
            >{t('Save backup file…')}</button
          >
          <button class="button ghost" disabled={busy} onclick={restoreFile}
            >{t('Restore from file…')}</button
          >
        {/if}
      </div>
      {#each backups as b}<div class="backup-row">
          <div>
            <strong>{new Date(b.createdAt).toLocaleString(intlLocale())}</strong>
            <p>
              {number(b.size / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB
              · {b.valid ? t('Database verified') : t('Verification failed')}
            </p>
          </div>
          {#if workspace.repo.mode === 'desktop'}
            <button
              class="button small ghost"
              disabled={busy || !b.valid}
              onclick={() => exportBackup(b.id)}>{t('Save file…')}</button
            >
          {/if}
          <button class="button small" disabled={busy || !b.valid} onclick={() => restore(b.id)}
            >{t('Restore copy')}</button
          >
        </div>{:else}<p class="muted small">{t('No backups yet for this project.')}</p>{/each}
    </div>
  </div>
  <div class="settings-section">
    <div>
      <h2>{t('Trash')}</h2>
      <p>{t('Restore removed records with their history.')}</p>
    </div>
    <div>
      {#each trash as r}<div class="backup-row">
          <div>
            <strong>{r.title || t('Untitled')}</strong>
            <p>
              {codeLabel(r.kind)}
              {t('· removed')}
              {new Date(r.deletedAt!).toLocaleDateString(intlLocale())}
            </p>
          </div>
          <button
            class="button small"
            onclick={() => workspace.restore(r.id).catch((e) => workspace.fail(e))}
            >{t('Restore')}</button
          >
        </div>{:else}<p class="muted small">{t('Trash is empty.')}</p>{/each}
    </div>
  </div>
  {#if workspace.projects.some((p) => p.archived)}<div class="settings-section">
      <div>
        <h2>{t('Archived projects')}</h2>
        <p>{t('Bring a project back when you need it.')}</p>
      </div>
      <div>
        {#each workspace.projects.filter((p) => p.archived) as p}<div class="backup-row">
            <strong>{p.name}</strong><button
              class="button small"
              onclick={async () => {
                try {
                  await workspace.repo.saveProject(
                    { ...$state.snapshot(p), archived: false },
                    p.revision,
                  );
                  workspace.projects = await workspace.repo.listProjects();
                } catch (e) {
                  workspace.fail(e);
                }
              }}>{t('Unarchive')}</button
            >
          </div>{/each}
      </div>
    </div>{/if}
  <div class="settings-section">
    <div>
      <h2>{t('Local storage')}</h2>
      <p>{t('No account, telemetry, or application server.')}</p>
    </div>
    <div class="form-stack">
      {#if storage}<p class="storage-path mono">{storage.location}</p>
        <p class="muted small">
          {t('Database')}
          {number(storage.databaseBytes / 1024 / 1024, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          {t('MB · Evidence')}
          {number(storage.assetBytes / 1024 / 1024, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })}
          {t('MB · Backups')}
          {number(storage.backupBytes / 1024 / 1024, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })} MB
        </p>{/if}{#if workspace.repo.mode === 'browser'}<p class="notice">
          {t(
            'This is the browser preview. Desktop builds store projects in native SQLite; this preview uses the browser’s local storage.',
          )}
        </p>{/if}
    </div>
  </div>
  <div class="settings-section">
    <div>
      <h2>{t('Explore Tracefold')}</h2>
      <p>{t('A fictional project shows how the pieces fit.')}</p>
    </div>
    <div>
      <button
        class="button"
        disabled={busy}
        onclick={async () => {
          busy = true;
          try {
            await createSample(workspace);
          } catch (e) {
            workspace.fail(e);
          } finally {
            busy = false;
          }
        }}>{t('Open an example project')}<Icon name="arrow" size={15} /></button
      >
      <p class="muted small" style="margin-top:16px">
        {t('Search: ⌘ / Ctrl K')}<br />{t('Save: ⌘ / Ctrl S')}<br />{t(
          'Quick note: ⌘ / Ctrl Shift N',
        )}
      </p>
    </div>
  </div>
</section>

<style>
  .settings-page {
    max-width: 1100px;
  }
  .settings-section {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 48px;
    border-top: 1px solid var(--line);
    padding: 28px 0;
  }
  .settings-section > div > p {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
    margin-top: 8px;
  }
  .settings-section h2 {
    font-size: 15px;
  }
  .backup-row {
    display: flex;
    gap: 14px;
    align-items: center;
    justify-content: space-between;
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }
  .backup-row strong {
    font-size: 12px;
    font-weight: 500;
  }
  .backup-row p {
    font-size: 11px;
    color: var(--muted);
    margin-top: 4px;
  }
  .storage-path {
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  @media (max-width: 950px) {
    .settings-section {
      grid-template-columns: 1fr;
      gap: 20px;
    }
  }
</style>
