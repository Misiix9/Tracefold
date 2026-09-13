<script lang="ts">
  import { t, date } from '../../lib/i18n/i18n.svelte';
  import { onMount } from 'svelte';
  import { getVersion } from '@tauri-apps/api/app';
  import type { AppUpdater } from '../../lib/services/updater.svelte';
  let { updater }: { updater: AppUpdater } = $props();
  let installedVersion = $state('');
  let versionFailed = $state(false);
  onMount(() => {
    let active = true;
    void getVersion()
      .then((version) => {
        if (active) installedVersion = version;
      })
      .catch(() => {
        if (active) versionFailed = true;
      });
    return () => {
      active = false;
    };
  });
  const messages = {
    never: 'Tracefold checks automatically while you work.',
    current: 'You have the newest available version.',
    available: 'A new version is ready. Use the purple update button above Settings.',
    unavailable: 'Updates could not be checked. You can keep working offline and try again later.',
  };
</script>

<section class="updates-settings" aria-label={t('Application updates')}>
  <div>
    <h2>{t('Application updates')}</h2>
    <div class="version-badge" aria-label={t('Installed version')}>
      <span>{t('Installed version')}</span>
      <strong>{installedVersion || t(versionFailed ? 'Unavailable' : 'Loading…')}</strong>
    </div>
    <p>{t('Download and install updates inside Tracefold.')}</p>
    <p>
      {t('Tracefold checks for updates on its own and downloads them quietly in the background.')}
    </p>
  </div>
  <div>
    {#if updater.available}<p>
        {t('Available version: {version}', { version: updater.available.version })}
      </p>{/if}
    {#if updater.prefetching}<p class="muted small" role="status">
        {t('Downloading the update in the background…')}
      </p>{:else if updater.readyToRestart}<p class="muted small" role="status">
        {t('The update is downloaded and installs when you restart Tracefold.')}
      </p>{/if}
    <button
      class="button"
      disabled={updater.checking || updater.busy || updater.prefetching}
      onclick={() => updater.check()}
    >
      {t(updater.checking ? 'Checking for updates…' : 'Check for updates')}
    </button>
    <p class="muted small" role="status">{t(messages[updater.checkStatus])}</p>
    {#if updater.lastCheckedAt}<p class="muted small">
        {t('Last checked {when}.', {
          when: date(updater.lastCheckedAt, { dateStyle: 'medium', timeStyle: 'short' }),
        })}
      </p>{/if}
    {#if updater.checkError}<details>
        <summary>{t('Technical details')}</summary>
        <p class="details">{updater.checkError}</p>
      </details>{/if}
  </div>
</section>

<style>
  .updates-settings {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 32px;
    padding: 28px 0;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 18px;
  }
  p {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }
  details {
    font-size: 12px;
    color: var(--muted);
  }
  summary {
    cursor: pointer;
  }
  .details {
    overflow-wrap: anywhere;
  }
  .version-badge {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 11px;
    margin: 4px 0;
    background: var(--recessed);
    font-size: 12px;
    color: var(--muted);
  }
  .version-badge strong {
    color: var(--text);
    font-family: 'iA Writer Mono', monospace;
    font-weight: 500;
  }
  @media (max-width: 1100px) {
    .updates-settings {
      grid-template-columns: 1fr;
      gap: 12px;
    }
  }
</style>
