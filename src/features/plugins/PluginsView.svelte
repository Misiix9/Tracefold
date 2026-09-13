<script lang="ts">
  import { onMount } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import Icon from '../../lib/ui/Icon.svelte';
  import { t, number, date } from '../../lib/i18n/i18n.svelte';
  import type { CatalogEntry, PluginManager } from '../../lib/services/plugins.svelte';

  let { manager }: { manager: PluginManager } = $props();
  const desktop = isTauri();

  let tab = $state<'installed' | 'browse'>('installed');
  let query = $state('');
  let category = $state('');

  const categories = $derived(
    [...new Set(manager.catalog.map((entry) => entry.category).filter(Boolean))].sort(),
  );

  const visible = $derived(
    manager.catalog.filter((entry) => {
      if (category && entry.category !== category) return false;
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [entry.name, entry.publisher, entry.description, entry.category, entry.id]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    }),
  );

  function megabytes(bytes: number) {
    if (!bytes) return '';
    return `${number(bytes / 1024 / 1024, { maximumFractionDigits: 1 })} MB`;
  }

  function actionLabel(entry: CatalogEntry) {
    if (entry.updateAvailable)
      return t('Update to {version}', { version: entry.latest?.version ?? '' });
    if (entry.installedVersion) return t('Reinstall');
    return t('Install');
  }

  const TABS = ['installed', 'browse'] as const;

  function onTabKey(event: KeyboardEvent) {
    const index = TABS.indexOf(tab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (target === 'browse') void browse();
    else tab = target;
    document.getElementById(`plugins-tab-${target}`)?.focus();
  }

  async function browse() {
    tab = 'browse';
    if (!manager.catalogLoaded && !manager.catalogLoading) await manager.refreshCatalog();
  }

  onMount(() => {
    if (desktop) void manager.refresh();
  });
</script>

<div class="plugins-view">
  <header class="hero">
    <div>
      <p class="eyebrow">{t('EXTENSIONS')}</p>
      <h1>{t('Plugins')}</h1>
      <p class="intro">
        {t('Extend Tracefold without turning the core into one giant application.')}
      </p>
    </div>
    <div class="actions">
      <button
        class="button"
        disabled={!desktop || manager.loading}
        onclick={() => void manager.installFromFilePicker()}
      >
        <Icon name="upload" size={16} />
        {t('Install from file')}
      </button>
      <button class="button primary" disabled={!desktop} onclick={() => void browse()}>
        <Icon name="download" size={16} />
        {t('Browse plugins')}
      </button>
    </div>
  </header>

  {#if !desktop}
    <section class="section safety browser-only">
      <div><Icon name="monitor" size={22} /></div>
      <div>
        <h2>{t('Desktop-only plugin runtime')}</h2>
        <p>
          {t(
            'Plugins require the Tracefold desktop app because they run as trusted local processes and open native plugin windows.',
          )}
        </p>
        <p>
          {t(
            'Browser preview keeps plugin commands disabled so it never attempts to call native-only APIs.',
          )}
        </p>
      </div>
    </section>
  {:else}
    {#if manager.error}
      <div class="error" role="alert">
        <Icon name="warning" size={17} />
        <span>{manager.error}</span>
        <button class="icon-button" aria-label={t('Dismiss')} onclick={() => (manager.error = '')}>
          <Icon name="close" size={15} />
        </button>
      </div>
    {/if}
    {#if manager.notification}
      <div class="notice" role="status"><Icon name="check" size={16} /> {manager.notification}</div>
    {/if}

    <div class="tabs" role="tablist" aria-label={t('Plugins')} tabindex="-1" onkeydown={onTabKey}>
      <button
        id="plugins-tab-installed"
        role="tab"
        class="tab"
        class:selected={tab === 'installed'}
        aria-selected={tab === 'installed'}
        aria-controls="plugins-panel-installed"
        tabindex={tab === 'installed' ? 0 : -1}
        onclick={() => (tab = 'installed')}
      >
        {t('Installed')}
        <span class="count">{manager.plugins.length}</span>
      </button>
      <button
        id="plugins-tab-browse"
        role="tab"
        class="tab"
        class:selected={tab === 'browse'}
        aria-selected={tab === 'browse'}
        aria-controls="plugins-panel-browse"
        tabindex={tab === 'browse' ? 0 : -1}
        onclick={() => void browse()}
      >
        {t('Browse')}
        {#if manager.updatable.length}<span class="count accent">{manager.updatable.length}</span
          >{/if}
      </button>
    </div>

    {#if tab === 'installed'}
      <div
        class="section"
        id="plugins-panel-installed"
        role="tabpanel"
        aria-labelledby="plugins-tab-installed"
        tabindex="-1"
      >
        {#if !manager.plugins.length && !manager.loading}
          <div class="empty">
            <Icon name="files" size={30} />
            <h3>{t('No plugins installed')}</h3>
            <p>
              {t(
                'Browse the Tracefold plugin catalog, or install a plugin package you reviewed yourself.',
              )}
            </p>
            <div class="empty-actions">
              <button class="button primary" onclick={() => void browse()}
                >{t('Browse plugins')}</button
              >
              <button class="button" onclick={() => void manager.installFromFilePicker()}>
                {t('Install from file')}
              </button>
            </div>
          </div>
        {:else}
          <div class="grid">
            {#each manager.plugins as plugin (plugin.id)}
              <article class="card">
                <div class="card-top">
                  <div class="plugin-icon"><Icon name="code" size={22} /></div>
                  <div class="title-wrap">
                    <h3>{plugin.name}</h3>
                    <span>v{plugin.version}</span>
                  </div>
                  <span class:running={plugin.running} class="status">
                    {plugin.running ? t('Running') : plugin.enabled ? t('Enabled') : t('Disabled')}
                  </span>
                </div>
                <p class="description">{plugin.description || t('No description provided.')}</p>
                <div class="meta">
                  <span>{plugin.publisher}</span>
                  <span>{t('API {version}', { version: plugin.apiVersion })}</span>
                </div>
                {#if plugin.capabilities.length}
                  <div class="caps">
                    {#each plugin.capabilities as capability}<span>{capability}</span>{/each}
                  </div>
                {/if}
                <div class="card-actions">
                  {#if plugin.enabled}
                    <button
                      class="button primary"
                      disabled={manager.loading || manager.isBusy(plugin.id)}
                      onclick={() => void manager.open(plugin)}
                    >
                      <Icon name="arrow" size={15} />
                      {manager.opening === plugin.id ? t('Starting…') : t('Open')}
                    </button>
                    {#if plugin.running}
                      <button
                        class="button"
                        disabled={manager.loading || manager.isBusy(plugin.id)}
                        onclick={() => void manager.stop(plugin)}>{t('Stop')}</button
                      >
                    {/if}
                  {/if}
                  <button
                    class="button"
                    disabled={manager.loading || manager.isBusy(plugin.id)}
                    onclick={() => void manager.setEnabled(plugin, !plugin.enabled)}
                  >
                    {plugin.enabled ? t('Disable') : t('Enable')}
                  </button>
                  <button
                    class="icon-button danger"
                    disabled={manager.loading || manager.isBusy(plugin.id)}
                    aria-label={t('Remove {name}', { name: plugin.name })}
                    onclick={() => void manager.remove(plugin)}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <div
        class="section"
        id="plugins-panel-browse"
        role="tabpanel"
        aria-labelledby="plugins-tab-browse"
        tabindex="-1"
      >
        <div class="browse-bar">
          <label class="search">
            <Icon name="search" size={15} />
            <input
              type="search"
              bind:value={query}
              placeholder={t('Search plugins')}
              aria-label={t('Search plugins')}
            />
          </label>
          {#if categories.length}
            <select bind:value={category} aria-label={t('Category')}>
              <option value="">{t('All categories')}</option>
              {#each categories as value}<option {value}>{value}</option>{/each}
            </select>
          {/if}
          <button
            class="button"
            disabled={manager.catalogLoading}
            onclick={() => void manager.refreshCatalog()}
          >
            <Icon name="redo" size={15} />
            {manager.catalogLoading ? t('Refreshing…') : t('Refresh')}
          </button>
        </div>

        {#if manager.catalogError}
          <div class="error" role="alert">
            <Icon name="warning" size={17} />
            <span>{manager.catalogError}</span>
          </div>
          <p class="offline-hint">
            {t('The catalog is downloaded over HTTPS. Installed plugins keep working offline.')}
          </p>
        {/if}

        {#if manager.catalogLoading && !manager.catalogLoaded}
          <div class="empty"><p>{t('Loading the plugin catalog…')}</p></div>
        {:else if manager.catalogLoaded && !visible.length}
          <div class="empty">
            <Icon name="files" size={30} />
            <h3>{t('No plugins match')}</h3>
            <p>{t('Try a different search term or category.')}</p>
          </div>
        {:else}
          <div class="grid">
            {#each visible as entry (entry.id)}
              <article class="card" class:unavailable={!entry.compatible}>
                <div class="card-top">
                  <div class="plugin-icon"><Icon name="code" size={22} /></div>
                  <div class="title-wrap">
                    <h3>{entry.name}</h3>
                    <span>
                      {#if entry.latest}v{entry.latest.version}{/if}
                      {#if entry.category}· {entry.category}{/if}
                    </span>
                  </div>
                  {#if entry.updateAvailable}
                    <span class="status accent">{t('Update')}</span>
                  {:else if entry.installedVersion}
                    <span class="status installed">{t('Installed')}</span>
                  {/if}
                </div>
                <p class="description">{entry.description || t('No description provided.')}</p>
                <div class="meta">
                  <span>{entry.publisher}</span>
                  {#if entry.latest?.size}<span>{megabytes(entry.latest.size)}</span>{/if}
                  {#if entry.latest?.published}<span>{date(entry.latest.published)}</span>{/if}
                </div>
                {#if entry.latest?.capabilities.length}
                  <div class="caps">
                    <span class="caps-label">{t('Requests these capabilities')}</span>
                    {#each entry.latest.capabilities as capability}<span>{capability}</span>{/each}
                  </div>
                {/if}
                {#if entry.installedVersion}
                  <p class="installed-line">
                    {t('Installed version: {version}', { version: entry.installedVersion })}
                  </p>
                {/if}
                {#if !entry.compatible}
                  <p class="incompatible">
                    <Icon name="info" size={14} />
                    {entry.incompatibleReason ||
                      t('This plugin is not compatible with this Tracefold version.')}
                  </p>
                {/if}
                <div class="card-actions">
                  <button
                    class="button primary"
                    disabled={!entry.compatible || manager.isBusy(entry.id) || manager.loading}
                    onclick={() => void manager.installFromCatalog(entry)}
                  >
                    {#if manager.isBusy(entry.id)}
                      {t('Installing…')}
                    {:else}
                      <Icon name="download" size={15} />{actionLabel(entry)}
                    {/if}
                  </button>
                  {#if entry.homepage}
                    <a
                      class="button"
                      href={entry.homepage}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {t('Details')}
                    </a>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        {/if}

        {#if manager.catalogLoaded}
          <p class="catalog-note">
            {t(
              'Every package is checked against the SHA-256 recorded in the catalog before it is installed.',
            )}
            {#if manager.catalogUpdated}
              {t('Catalog updated {when}.', { when: date(manager.catalogUpdated) })}
            {/if}
          </p>
        {/if}
      </div>
    {/if}

    <section class="section safety">
      <div><Icon name="shield" size={22} /></div>
      <div>
        <h2>{t('Plugin safety')}</h2>
        <p>
          {t(
            'Plugins are trusted local code. They run as your OS user and are not sandboxed by Tracefold.',
          )}
        </p>
        <p>
          {t(
            'The host keeps plugin web runtimes on 127.0.0.1, stores plugin data outside installed code, and validates package paths and size limits.',
          )}
        </p>
        <p>
          {t(
            'Capabilities are declared for transparency, but this beta does not enforce them as an OS permission boundary.',
          )}
        </p>
      </div>
    </section>
  {/if}
</div>

<style>
  .plugins-view {
    max-width: 1120px;
    margin: 0 auto;
    padding: 34px 40px 70px;
  }
  .hero {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    align-items: flex-end;
    margin-bottom: 22px;
  }
  .eyebrow {
    margin: 0 0 7px;
    font-size: 10px;
    letter-spacing: 0.14em;
    font-weight: 700;
    color: var(--muted);
  }
  h1 {
    margin: 0;
    font-family: Newsreader, serif;
    font-size: 38px;
  }
  .intro {
    margin: 8px 0 0;
    color: var(--muted);
  }
  .actions,
  .card-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 4px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    padding: 9px 12px;
    font: inherit;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
  }
  .tab.selected {
    color: var(--text);
    border-bottom-color: var(--text);
  }
  .count {
    border-radius: 999px;
    background: var(--surface-2);
    padding: 1px 7px;
    font-size: 10px;
  }
  .count.accent {
    background: #65477f;
    color: #fff8ff;
  }
  .section {
    margin-top: 22px;
  }
  h2 {
    margin: 0;
    font-size: 17px;
  }
  .browse-bar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin-bottom: 14px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 200px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 7px 10px;
    background: var(--surface);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 13px;
    color: var(--text);
    outline: none;
  }
  .browse-bar select {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 8px 10px;
    font: inherit;
    font-size: 12px;
    background: var(--surface);
    color: var(--text);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
    gap: 14px;
  }
  .card {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    background: var(--surface);
    border-radius: var(--radius);
    padding: 17px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.04);
  }
  .card.unavailable {
    opacity: 0.72;
  }
  .card-top {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .plugin-icon {
    width: 38px;
    height: 38px;
    border: 1px solid var(--line);
    border-radius: 10px;
    display: grid;
    place-items: center;
  }
  .title-wrap {
    min-width: 0;
    flex: 1;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  .title-wrap span {
    color: var(--muted);
    font-size: 11px;
  }
  .status {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 4px 7px;
    font-size: 10px;
    color: var(--muted);
    white-space: nowrap;
  }
  .status.running,
  .status.installed {
    color: var(--text);
    border-color: var(--text);
  }
  .status.accent {
    background: #65477f;
    border-color: #65477f;
    color: #fff8ff;
  }
  .description {
    min-height: 42px;
    margin: 14px 0 12px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
  }
  .meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 10px;
    color: var(--muted);
  }
  .caps {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    align-items: center;
    margin: 12px 0;
  }
  .caps span {
    padding: 4px 6px;
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 9px;
  }
  .caps .caps-label {
    width: 100%;
    padding: 0;
    background: none;
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .installed-line {
    margin: 0 0 6px;
    font-size: 11px;
    color: var(--muted);
  }
  .incompatible {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    margin: 0 0 8px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--muted);
  }
  .card-actions {
    margin-top: auto;
    padding-top: 14px;
  }
  .card-actions a.button {
    text-decoration: none;
  }
  .danger {
    color: var(--danger);
  }
  .empty {
    border: 1px dashed var(--line);
    border-radius: var(--radius);
    padding: 44px 20px;
    text-align: center;
    color: var(--muted);
  }
  .empty h3 {
    margin: 12px 0 6px;
    color: var(--text);
  }
  .empty p {
    margin: 0 auto;
    max-width: 430px;
    font-size: 12px;
    line-height: 1.55;
  }
  .empty-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .error,
  .notice {
    display: flex;
    gap: 9px;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 11px 13px;
    margin: 0 0 12px;
    font-size: 12px;
  }
  .error {
    color: var(--danger);
  }
  .error span,
  .notice {
    flex: 1;
  }
  .notice {
    color: var(--text);
  }
  .offline-hint,
  .catalog-note {
    margin: 12px 0 0;
    font-size: 11px;
    line-height: 1.55;
    color: var(--muted);
  }
  .safety {
    display: flex;
    gap: 14px;
    border-top: 1px solid var(--line);
    padding-top: 24px;
    margin-top: 30px;
    color: var(--muted);
  }
  .safety h2 {
    color: var(--text);
    margin-bottom: 6px;
  }
  .safety p {
    margin: 4px 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .browser-only {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 18px;
  }
  @media (max-width: 760px) {
    .plugins-view {
      padding: 24px 18px;
    }
    .hero {
      align-items: flex-start;
      flex-direction: column;
    }
    .actions {
      width: 100%;
    }
  }
</style>
