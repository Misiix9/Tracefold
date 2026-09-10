<script lang="ts">
  import { t, number } from '../../lib/i18n/i18n.svelte';
  import type { AppUpdater } from '../../lib/services/updater.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  let { updater, overlay = false }: { updater: AppUpdater; overlay?: boolean } = $props();
  const labels = {
    preparing: 'Saving work and creating recovery backups…',
    downloading: 'Downloading update…',
    installing: 'Installing update…',
    restarting: 'Restarting Tracefold…',
    idle: '',
  };
</script>

{#if updater.available && !overlay}
  <button
    class="update-button"
    disabled={updater.busy}
    onclick={() => updater.install()}
    title={t('Version {version}', { version: updater.available.version })}
  >
    <Icon name="download" size={18} /><span>{t('Update to newest version')}</span>
  </button>
{/if}
{#if updater.error && !overlay}<p class="update-error" role="alert">{t(updater.error)}</p>{/if}
{#if updater.busy && overlay}
  <div class="update-overlay" role="status" aria-live="polite">
    <div class="update-card">
      <h2>{t('Updating Tracefold')}</h2>
      <p>{t(labels[updater.phase])}</p>
      {#if updater.phase === 'downloading'}<progress
          value={updater.total ? updater.received : undefined}
          max={updater.total ?? 1}
          aria-label={t('Update download')}
        ></progress>
        <p>{number(updater.received / 1024 / 1024, { maximumFractionDigits: 1 })} MB</p>{/if}
      <p class="muted">{t('Your projects, evidence, and settings stay on this device.')}</p>
    </div>
  </div>
{/if}

<style>
  .update-button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    margin: 0 0 10px;
    border: 1px solid #795c97;
    border-radius: var(--radius);
    padding: 12px;
    text-align: left;
    font: inherit;
    font-size: 12px;
    line-height: 1.45;
    background: #65477f;
    color: #fff8ff;
    cursor: pointer;
  }
  .update-button:hover {
    background: #563a70;
  }
  .update-button:disabled {
    cursor: wait;
    opacity: 0.7;
  }
  .update-error {
    font-size: 12px;
    color: var(--danger);
    margin: 8px 0;
  }
  .update-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    background: #17121ecc;
  }
  .update-card {
    max-width: 440px;
    margin: 24px;
    padding: 32px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    border-radius: var(--dialog-radius);
  }
  h2 {
    font-family: Newsreader, serif;
    font-size: 28px;
    margin: 0 0 14px;
  }
  p {
    margin: 12px 0;
  }
  progress {
    width: 100%;
    accent-color: #795c97;
  }
</style>
