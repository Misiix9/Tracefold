<script lang="ts">
  import { t } from '../../lib/i18n/i18n.svelte';
  import type { AppUpdater } from '../../lib/services/updater.svelte';
  let { updater }: { updater: AppUpdater } = $props();
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
    <p>{t('Download and install updates inside Tracefold.')}</p>
  </div>
  <div>
    <button
      class="button"
      disabled={updater.checking || updater.busy}
      onclick={() => updater.check()}
    >
      {t(updater.checking ? 'Checking for updates…' : 'Check for updates')}
    </button>
    <p class="muted small" role="status">{t(messages[updater.checkStatus])}</p>
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
  @media (max-width: 1100px) {
    .updates-settings {
      grid-template-columns: 1fr;
      gap: 12px;
    }
  }
</style>
