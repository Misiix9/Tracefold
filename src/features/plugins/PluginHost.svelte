<script lang="ts">
  import Icon from '../../lib/ui/Icon.svelte';
  import { t } from '../../lib/i18n/i18n.svelte';
  import type { PluginManager } from '../../lib/services/plugins.svelte';

  let { manager, theme, language }: { manager: PluginManager; theme: string; language: string } =
    $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  let reloadKey = $state(0);

  const active = $derived(manager.active);

  /**
   * Plugins are served from their own loopback origin, so the host cannot reach into them
   * to restyle anything. Instead the current appearance is handed over in the URL, and a
   * plugin that understands it renders in the same theme as the rest of Tracefold.
   */
  const source = $derived(
    active ? `${active.url}/?tracefoldTheme=${theme}&tracefoldLang=${language}&host=tracefold` : '',
  );

  function reload() {
    reloadKey += 1;
  }
</script>

{#if active}
  <section class="plugin-host" aria-label={active.plugin.name}>
    <header class="host-bar">
      <button
        class="icon-button"
        aria-label={t('Back to plugins')}
        onclick={() => manager.closeActive()}
      >
        <Icon name="back" size={17} />
      </button>
      <div class="identity">
        <strong>{active.plugin.name}</strong>
        <span>v{active.plugin.version} · {active.plugin.publisher}</span>
      </div>
      <span class="running-pill"><span class="dot" aria-hidden="true"></span>{t('Running')}</span>
      <div class="host-actions">
        <button class="button small" onclick={reload}>
          <Icon name="redo" size={15} />{t('Reload')}
        </button>
        <button
          class="button small"
          disabled={manager.isBusy(active.plugin.id)}
          onclick={() => void manager.openWindow(active.plugin)}
        >
          <Icon name="expand" size={15} />{t('Open in a window')}
        </button>
        <button
          class="button small"
          disabled={manager.isBusy(active.plugin.id)}
          onclick={() => void manager.stop(active.plugin)}
        >
          {t('Stop')}
        </button>
      </div>
    </header>
    {#key reloadKey}
      <iframe
        bind:this={frame}
        class="plugin-frame"
        src={source}
        title={active.plugin.name}
        referrerpolicy="no-referrer"
        allow="clipboard-read; clipboard-write"
      ></iframe>
    {/key}
    <p class="host-note">
      {t('This plugin runs as a local process on 127.0.0.1 and is displayed inside Tracefold.')}
    </p>
  </section>
{/if}

<style>
  .plugin-host {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface);
  }
  .host-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }
  .identity {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .identity strong {
    font-size: 13px;
  }
  .identity span {
    font-size: 11px;
    color: var(--muted);
  }
  .running-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 10px;
    color: var(--muted);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4c9a6a;
  }
  .host-actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
    flex-wrap: wrap;
  }
  .plugin-frame {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: 0;
    background: var(--recessed);
  }
  .host-note {
    margin: 0;
    padding: 6px 16px;
    border-top: 1px solid var(--line);
    font-size: 10px;
    color: var(--muted);
  }
  @media (max-width: 760px) {
    .host-bar {
      padding: 10px 12px;
    }
    .host-actions {
      width: 100%;
      margin-left: 0;
    }
  }
</style>
