<script lang="ts">
  import { t, codeLabel, intlLocale, date } from './lib/i18n/i18n.svelte';

  import { onMount } from 'svelte';
  import { AppUpdater } from './lib/services/updater.svelte';
  import UpdateButton from './features/updates/UpdateButton.svelte';
  import { check } from '@tauri-apps/plugin-updater';
  import { relaunch } from '@tauri-apps/plugin-process';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { WorkspaceSearch } from './lib/services/search.svelte';
  import { Workspace } from './lib/services/workspace.svelte';
  import { BrowserRepository } from './lib/services/browser-repository';
  import { NativeRepository } from './lib/services/native-repository';
  import { PluginManager } from './lib/services/plugins.svelte';
  import Icon from './lib/ui/Icon.svelte';
  import Modal from './lib/ui/Modal.svelte';
  import EmptyState from './lib/ui/EmptyState.svelte';
  import NotebookView from './features/notebook/NotebookView.svelte';
  import FindingsView from './features/findings/FindingsView.svelte';
  import TestingView from './features/testing/TestingView.svelte';
  import EvidenceView from './features/evidence/EvidenceView.svelte';
  import SettingsView from './features/settings/SettingsView.svelte';
  import RevisionHistory from './features/settings/RevisionHistory.svelte';
  import ReportsView from './features/reports/ReportsView.svelte';
  import TemplatesView from './features/templates/TemplatesView.svelte';
  import PluginsView from './features/plugins/PluginsView.svelte';
  import type { AnyEntity } from './lib/domain/types';
  import { plainText } from './lib/domain/defaults';
  import { captureEvidence, importEvidence } from './features/evidence/evidence';
  const workspace = new Workspace(isTauri() ? new NativeRepository() : new BrowserRepository());
  const plugins = new PluginManager();
  const updater = new AppUpdater({
    check: () => check({ timeout: 15000 }),
    prepare: async () => {
      if (busy || workspace.loading) throw new Error('A workspace operation is still running.');
      await workspace.prepareToClose();
      for (const project of await workspace.repo.listProjects())
        await workspace.repo.createBackup(project.id);
    },
    relaunch,
  });
  onMount(() => {
    if (!isTauri()) return;
    const initial = setTimeout(() => void updater.check(), 10000);
    const interval = setInterval(() => void updater.check(), 4 * 60 * 60 * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      void updater.dispose();
    };
  });
  let searchOpen = $state(false),
    search = $state(''),
    projectOpen = $state(false),
    projectName = $state(''),
    projectPrefix = $state('TF'),
    projectDescription = $state(''),
    busy = $state(false),
    systemDark = $state(false);
  const navigation = $derived([
    { id: 'notebook', label: t('Notebook'), icon: 'note', kinds: ['document', 'session'] },
    { id: 'findings', label: t('Findings'), icon: 'finding', kinds: ['finding'] },
    { id: 'cases', label: t('Test cases'), icon: 'case', kinds: ['case'] },
    { id: 'runs', label: t('Test runs'), icon: 'run', kinds: ['run'] },
    { id: 'coverage', label: t('Coverage'), icon: 'coverage', kinds: ['requirement'] },
    { id: 'evidence', label: t('Evidence'), icon: 'evidence', kinds: ['evidence'] },
    { id: 'templates', label: t('Templates'), icon: 'template', kinds: ['template'] },
    { id: 'reports', label: t('Reports'), icon: 'reports', kinds: [] },
    { id: 'plugins', label: t('Plugins'), icon: 'code', kinds: [] },
  ]);
  const current = $derived(navigation.find((n) => n.id === workspace.view)?.label ?? t('Settings'));
  const searchResults = new WorkspaceSearch(workspace.repo, () => workspace.flush());
  let searchKind = $state<import('./lib/domain/types').EntityKind | ''>('');
  $effect(() => {
    if (searchOpen && workspace.projectId)
      searchResults.search(workspace.projectId, search, searchKind || undefined);
    else searchResults.clear();
  });
  $effect(() => {
    document.documentElement.lang = workspace.settings.language;
    document.documentElement.dataset.theme =
      workspace.settings.theme === 'system'
        ? systemDark
          ? 'dark'
          : 'light'
        : workspace.settings.theme;
    document.documentElement.dataset.density = workspace.settings.density;
    document.documentElement.style.setProperty(
      '--editor-size',
      `${workspace.settings.editorFontSize}px`,
    );
  });
  onMount(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    systemDark = media.matches;
    const change = () => (systemDark = media.matches);
    media.addEventListener('change', change);
    void workspace.initialize();
    return () => {
      media.removeEventListener('change', change);
      searchResults.clear();
      workspace.dispose();
    };
  });
  onMount(() => {
    if (!isTauri()) return;
    let disposed = false,
      closing = false,
      unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing || updater.busy) return;
        closing = true;
        try {
          await workspace.prepareToClose();
          await getCurrentWindow().destroy();
        } catch (error) {
          workspace.fail(error);
          closing = false;
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => workspace.fail(error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  });
  function openRecord(r: AnyEntity) {
    const route = navigation.find((n) => n.kinds.includes(r.kind));
    if (r.kind === 'entry') workspace.navigate('notebook', r.data.sessionId);
    else workspace.navigate(route?.id ?? 'notebook', r.id);
    searchOpen = false;
  }
  async function newProject() {
    if (!projectName.trim()) return;
    busy = true;
    try {
      const p = await workspace.createProject(projectName, projectDescription, projectPrefix);
      await workspace.openProject(p.id);
      workspace.navigate('notebook');
      projectOpen = false;
      projectName = '';
      projectDescription = '';
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
  async function quickNote() {
    try {
      const r = await workspace.create('document', t('Untitled note'));
      workspace.navigate('notebook', r.id);
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function capture() {
    busy = true;
    try {
      const caps = await workspace.repo.captureCapabilities();
      if (!caps.supported)
        throw new Error(
          caps.reason || t('Screen capture is unavailable. You can paste or import an image.'),
        );
      const item = await captureEvidence(workspace);
      if (item) workspace.navigate('evidence', item.id);
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
  function keydown(e: KeyboardEvent) {
    if (updater.busy) {
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchOpen = !searchOpen;
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void workspace.flush().catch((e) => workspace.fail(e));
      } else if (e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void quickNote();
      }
    }
  }
  async function paste(e: ClipboardEvent) {
    if (updater.busy || busy) {
      e.preventDefault();
      return;
    }
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    busy = true;
    try {
      const added = await importEvidence(workspace, files, 'paste');
      if (added[0]) workspace.navigate('evidence', added[0].id);
    } catch (error) {
      workspace.fail(error);
    } finally {
      busy = false;
    }
  }
  function beforeUnload(e: BeforeUnloadEvent) {
    if (workspace.saveStatus !== 'saved') {
      e.preventDefault();
      e.returnValue = '';
    }
  }
</script>

<svelte:window onkeydown={keydown} onpaste={paste} onbeforeunload={beforeUnload} />
<a class="skip-link" href="#main-content">{t('Skip to content')}</a>
<div class="app-shell" inert={updater.busy}>
  <aside class="sidebar" aria-label={t('Workspace navigation')}>
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Tracefold</span>
    </div>
    <div>
      <label class="sr-only" for="project-switch">{t('Current project')}</label><select
        id="project-switch"
        class="project-switch"
        value={workspace.projectId}
        onchange={(e) => {
          const id = e.currentTarget.value;
          if (id === 'new') {
            projectOpen = true;
            e.currentTarget.value = workspace.projectId;
          } else void workspace.openProject(id).catch((e) => workspace.fail(e));
        }}
        >{#each workspace.projects.filter((p) => !p.archived) as project}<option value={project.id}
            >{project.name}</option
          >{/each}<option value="new">{t('＋ New project')}</option></select
      >
    </div>
    <nav aria-label={t('Main')}>
      {#each navigation as item, i}{#if i === 6}<div class="nav-section">
            {t('WORKSPACE')}
          </div>{/if}<button
          class="nav-item"
          class:selected={workspace.view === item.id}
          aria-current={workspace.view === item.id ? 'page' : undefined}
          title={item.label}
          onclick={() => workspace.navigate(item.id)}
          ><Icon name={item.icon} size={19} /><span class="nav-label">{item.label}</span
          >{#if item.kinds.length && workspace.visible.some( (r) => item.kinds.includes(r.kind) )}<span
              class="nav-count"
              >{workspace.visible.filter((r) => item.kinds.includes(r.kind)).length}</span
            >{/if}</button
        >{/each}
    </nav>
    <div class="sidebar-footer">
      <UpdateButton {updater} />
      <hr class="sidebar-divider" />
      <button
        class="nav-item"
        title={t('Settings and recovery')}
        class:selected={workspace.view === 'settings'}
        onclick={() => workspace.navigate('settings')}
        ><Icon name="settings" size={18} /><span class="nav-label">{t('Settings & recovery')}</span
        ></button
      >
      <div class="local-indicator">
        <span class="status-dot"></span>{workspace.repo.mode === 'desktop'
          ? t('Local workspace')
          : t('Browser preview')}
      </div>
    </div>
  </aside>
  <div class="workspace">
    <header class="topbar">
      <div class="breadcrumbs">
        <span class="muted">{workspace.project?.name ?? 'Tracefold'}</span><span class="slash"
          >/</span
        ><span>{current}</span>
      </div>
      <span class="spacer"></span><button
        class="search-trigger"
        aria-label={t('Search workspace (Command or Control K)')}
        onclick={() => (searchOpen = true)}
        ><Icon name="search" size={15} /><span>{t('Search anything')}</span><kbd>⌘ K</kbd></button
      >{#if workspace.selectedId}<RevisionHistory {workspace} />{/if}<button
        class="button ghost"
        disabled={busy || workspace.loading}
        onclick={capture}
        title={t('Capture a screenshot')}
        ><Icon name="capture" size={17} /><span class="capture-label">{t('Capture')}</span></button
      ><button class="button primary" disabled={workspace.loading} onclick={quickNote}
        ><Icon name="plus" size={16} />{t('Quick note')}</button
      >
    </header>
    {#if workspace.error}<div class="error-banner" role="alert">
        <Icon name="warning" size={18} /><span>{workspace.error}</span
        >{#if workspace.saveStatus === 'error'}<button
            class="button small"
            onclick={() => workspace.flush().catch((e) => workspace.fail(e))}
            >{t('Retry save')}</button
          >{/if}<button
          class="icon-button"
          aria-label={t('Dismiss error')}
          onclick={() => (workspace.error = '')}><Icon name="close" size={16} /></button
        >
      </div>{/if}
    <main class="workspace-content" id="main-content" tabindex="-1">
      {#key workspace.projectId}
        {#if workspace.loading}<EmptyState
            title={t('Opening your workspace')}
            description={t('Loading your local notes and projects.')}
          />
        {:else if workspace.view === 'notebook'}<NotebookView {workspace} />
        {:else if workspace.view === 'findings'}<FindingsView {workspace} />
        {:else if workspace.view === 'cases' || workspace.view === 'runs' || workspace.view === 'coverage'}<TestingView
            {workspace}
            section={workspace.view}
          />
        {:else if workspace.view === 'evidence'}<EvidenceView {workspace} />
        {:else if workspace.view === 'templates'}<TemplatesView {workspace} />
        {:else if workspace.view === 'reports'}<ReportsView {workspace} />
        {:else if workspace.view === 'plugins'}<PluginsView manager={plugins} />
        {:else}<SettingsView {workspace} {updater} />{/if}
      {/key}
    </main>
  </div>
</div>
<UpdateButton {updater} overlay />
{#if workspace.notification}<div class="toast" role="status">{workspace.notification}</div>{/if}
<Modal
  bind:open={projectOpen}
  title={t('Room for your next project')}
  description={t(
    'Everything stays on this device. You can export a portable copy whenever you need it.',
  )}
  ><form
    onsubmit={(e) => {
      e.preventDefault();
      void newProject();
    }}
  >
    <div class="form-stack">
      <div class="field">
        <label for="project-name">{t('Project name')}</label><input
          id="project-name"
          required
          maxlength="200"
          bind:value={projectName}
          placeholder={t('e.g. Atlas storefront')}
        />
      </div>
      <div class="field">
        <label for="project-prefix">{t('Finding prefix')}</label><input
          id="project-prefix"
          maxlength="8"
          bind:value={projectPrefix}
        /><small>{t('Used in identifiers such as')} {projectPrefix || 'TF'}-001.</small>
      </div>
      <div class="field">
        <label for="project-description">{t('Description')}</label><textarea
          id="project-description"
          bind:value={projectDescription}></textarea>
      </div>
    </div>
    <div class="modal-actions">
      <button class="button" type="button" onclick={() => (projectOpen = false)}
        >{t('Cancel')}</button
      ><button class="button primary" disabled={busy || !projectName.trim()}
        >{t('Create project')}</button
      >
    </div>
  </form></Modal
>
<Modal
  bind:open={searchOpen}
  title={t('Find your trail')}
  description={t('Search notes, findings, steps, environments, tags, and evidence.')}
  wide
  ><div class="field">
    <label class="sr-only" for="global-search">{t('Search workspace')}</label><input
      id="global-search"
      bind:value={search}
      placeholder={t('Search anything in this project…')}
    />
  </div>
  <label class="field search-kind"
    ><span class="field-label">{t('Type')}</span><select bind:value={searchKind}>
      <option value="">{t('All')}</option
      >{#each ['document', 'session', 'entry', 'finding', 'case', 'run', 'requirement', 'evidence', 'template'] as kind}<option
          value={kind}>{codeLabel(kind)}</option
        >{/each}
    </select></label
  >
  {#if searchResults.error}<p role="alert" class="notice">{searchResults.error}</p>{/if}
  <div class="search-results" aria-busy={searchResults.busy}>
    {#each searchResults.items as result}<button class="list-row" onclick={() => openRecord(result)}
        ><Icon name={result.kind} size={18} />
        <div>
          <div class="list-title">{result.title || t('Untitled')}</div>
          <div class="row-subtitle">
            {codeLabel(result.kind)} · {plainText(result.body).slice(0, 100)}
          </div>
        </div></button
      >{:else}<p class="muted" style="padding:28px 0">
        {searchResults.busy
          ? t('Searching…')
          : searchResults.error
            ? ''
            : t('No matches. Try a shorter phrase.')}
      </p>{/each}
  </div>
  {#if searchResults.total > searchResults.items.length}<p class="muted small">
      {t('Showing {shown} of {total} results. Refine your search to narrow them down.', {
        shown: searchResults.items.length,
        total: searchResults.total,
      })}
    </p>{/if}</Modal
>

<style>
  .skip-link {
    position: fixed;
    left: 12px;
    top: -60px;
    z-index: 200;
    background: var(--surface);
    padding: 10px 16px;
  }
  .skip-link:focus {
    top: 12px;
  }
  .search-kind {
    margin-top: 12px;
    max-width: 240px;
  }
  .search-results {
    max-height: 55vh;
    overflow: auto;
    margin-top: 12px;
  }
</style>
