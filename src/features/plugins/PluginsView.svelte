<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { t } from '../../lib/i18n/i18n.svelte';
  import type { PluginManager } from '../../lib/services/plugins.svelte';

  let { manager }: { manager: PluginManager } = $props();

  const roadmap = [
    'API Workbench',
    'BOLA & authorization',
    'Browser automation',
    'API contracts',
    'GraphQL & WebSocket',
    'Security toolkit',
    'Accessibility & performance',
    'CI & reporting',
    'Tracefold Assistant',
  ];

  onMount(() => {
    void manager.refresh();
  });
</script>

<div class="plugins-view">
  <header class="hero">
    <div>
      <p class="eyebrow">{t('EXTENSIONS')}</p>
      <h1>{t('Plugins')}</h1>
      <p class="intro">{t('Extend Tracefold without turning the core into one giant application.')}</p>
    </div>
    <div class="actions">
      <button class="button primary" disabled={manager.loading} onclick={() => void manager.installFromFilePicker()}>
        <Icon name="upload" size={16} /> {t('Install plugin package')}
      </button>
    </div>
  </header>

  {#if manager.error}
    <div class="error" role="alert">
      <Icon name="warning" size={17} />
      <span>{manager.error}</span>
      <button class="icon-button" aria-label={t('Dismiss')} onclick={() => (manager.error = '')}><Icon name="close" size={15} /></button>
    </div>
  {/if}
  {#if manager.notification}<div class="notice" role="status"><Icon name="check" size={16} /> {manager.notification}</div>{/if}

  <section class="section">
    <div class="section-head">
      <div>
        <h2>{t('Installed')}</h2>
        <p>{t(manager.plugins.length === 1 ? '{count} installed plugin.' : '{count} installed plugins.', { count: manager.plugins.length })}</p>
      </div>
    </div>

    {#if !manager.plugins.length && !manager.loading}
      <div class="empty">
        <Icon name="files" size={30} />
        <h3>{t('No plugins installed')}</h3>
        <p>{t('Install a verified or locally reviewed Tracefold plugin package to extend the workspace.')}</p>
      </div>
    {:else}
      <div class="grid">
        {#each manager.plugins as plugin}
          <article class="card">
            <div class="card-top">
              <div class="plugin-icon"><Icon name="code" size={22} /></div>
              <div class="title-wrap"><h3>{plugin.name}</h3><span>v{plugin.version}</span></div>
              <span class:running={plugin.running} class="status">{plugin.running ? t('Running') : plugin.enabled ? t('Enabled') : t('Disabled')}</span>
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
                <button class="button primary" disabled={manager.loading || manager.isBusy(plugin.id)} onclick={() => void manager.open(plugin)}>
                  <Icon name="arrow" size={15} /> {t('Open')}
                </button>
                {#if plugin.running}<button class="button" disabled={manager.loading || manager.isBusy(plugin.id)} onclick={() => void manager.stop(plugin)}>{t('Stop')}</button>{/if}
              {/if}
              <button class="button" disabled={manager.loading || manager.isBusy(plugin.id)} onclick={() => void manager.setEnabled(plugin, !plugin.enabled)}>
                {plugin.enabled ? t('Disable') : t('Enable')}
              </button>
              <button class="icon-button danger" disabled={manager.loading || manager.isBusy(plugin.id)} aria-label={t('Remove {name}', { name: plugin.name })} onclick={() => void manager.remove(plugin)}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="section roadmap">
    <div class="section-head">
      <div>
        <h2>{t('Plugin roadmap')}</h2>
        <p>{t('Only real packages appear as installable plugins. Planned tools stay clearly marked.')}</p>
      </div>
    </div>
    <div class="roadmap-grid">
      {#each roadmap as item}
        <div class="roadmap-item"><Icon name="clock" size={15} />{t(item)}<span>{t('Planned')}</span></div>
      {/each}
    </div>
  </section>

  <section class="section safety">
    <div><Icon name="shield" size={22} /></div>
    <div>
      <h2>{t('Plugin safety')}</h2>
      <p>{t('Plugins are trusted local code. They run as your OS user and are not sandboxed by Tracefold.')}</p>
      <p>{t('The host keeps plugin web runtimes on 127.0.0.1, stores plugin data outside installed code, and validates package paths and size limits.')}</p>
      <p>{t('Capabilities are declared for transparency, but this beta does not enforce them as an OS permission boundary.')}</p>
    </div>
  </section>
</div>

<style>
  .plugins-view { max-width: 1120px; margin: 0 auto; padding: 34px 40px 70px; }
  .hero { display:flex; justify-content:space-between; gap:24px; align-items:flex-end; margin-bottom:30px; }
  .eyebrow { margin:0 0 7px; font-size:10px; letter-spacing:.14em; font-weight:700; color:var(--muted); }
  h1 { margin:0; font-family:Newsreader,serif; font-size:38px; }
  .intro { margin:8px 0 0; color:var(--muted); }
  .actions,.card-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .section { margin-top:26px; }
  .section-head { display:flex; justify-content:space-between; margin-bottom:14px; }
  h2 { margin:0; font-size:17px; }
  .section-head p { margin:5px 0 0; color:var(--muted); font-size:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:14px; }
  .card { border:1px solid var(--line); background:var(--surface); border-radius:var(--radius); padding:17px; box-shadow:0 8px 24px rgba(0,0,0,.04); }
  .card-top { display:flex; gap:10px; align-items:center; }
  .plugin-icon { width:38px; height:38px; border:1px solid var(--line); border-radius:10px; display:grid; place-items:center; }
  .title-wrap { min-width:0; flex:1; }
  h3 { margin:0; font-size:14px; }
  .title-wrap span { color:var(--muted); font-size:11px; }
  .status { border:1px solid var(--line); border-radius:999px; padding:4px 7px; font-size:10px; color:var(--muted); }
  .status.running { color:var(--text); border-color:var(--text); }
  .description { min-height:42px; margin:14px 0 12px; font-size:12px; line-height:1.55; color:var(--muted); }
  .meta { display:flex; gap:12px; font-size:10px; color:var(--muted); }
  .caps { display:flex; gap:5px; flex-wrap:wrap; margin:12px 0; }
  .caps span { padding:4px 6px; border-radius:6px; background:var(--surface-2); color:var(--muted); font-size:9px; }
  .card-actions { margin-top:14px; }
  .danger { color:var(--danger); }
  .empty { border:1px dashed var(--line); border-radius:var(--radius); padding:44px 20px; text-align:center; color:var(--muted); }
  .empty h3 { margin:12px 0 6px; color:var(--text); }
  .empty p { margin:0 auto; max-width:430px; font-size:12px; line-height:1.55; }
  .error,.notice { display:flex; gap:9px; align-items:center; border:1px solid var(--line); border-radius:var(--radius); padding:11px 13px; margin:0 0 12px; font-size:12px; }
  .error { color:var(--danger); }
  .error span,.notice { flex:1; }
  .notice { color:var(--text); }
  .roadmap-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:8px; }
  .roadmap-item { display:flex; gap:8px; align-items:center; border:1px solid var(--line); border-radius:9px; padding:10px; font-size:11px; color:var(--muted); }
  .roadmap-item span { margin-left:auto; font-size:9px; }
  .safety { display:flex; gap:14px; border-top:1px solid var(--line); padding-top:24px; color:var(--muted); }
  .safety h2 { color:var(--text); margin-bottom:6px; }
  .safety p { margin:4px 0; font-size:12px; line-height:1.5; }
  @media(max-width:760px){.plugins-view{padding:24px 18px}.hero{align-items:flex-start;flex-direction:column}.actions{width:100%}}
</style>
