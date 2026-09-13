<script lang="ts">
  import { t, number } from '../../lib/i18n/i18n.svelte';
  import type { AppUpdater } from '../../lib/services/updater.svelte';
  import Icon from '../../lib/ui/Icon.svelte';

  let { updater }: { updater: AppUpdater } = $props();

  const steps = [
    { id: 'downloading', label: 'Downloading the new version' },
    { id: 'preparing', label: 'Saving your work and backing up projects' },
    { id: 'installing', label: 'Installing' },
    { id: 'restarting', label: 'Restarting Tracefold' },
  ];

  const order = $derived(steps.findIndex((step) => step.id === updater.phase));

  const megabytes = $derived(
    updater.total
      ? `${number(updater.received / 1024 / 1024, { maximumFractionDigits: 1 })} / ${number(
          updater.total / 1024 / 1024,
          { maximumFractionDigits: 1 },
        )} MB`
      : `${number(updater.received / 1024 / 1024, { maximumFractionDigits: 1 })} MB`,
  );
</script>

{#if updater.busy}
  <!-- Installing replaces the running application, so this is deliberately modal: there is
       no useful work to do underneath it, and clicking around during a restart is not
       something to invite. -->
  <div class="scrim" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
    <div class="dialog">
      <div class="mark" aria-hidden="true"><Icon name="download" size={22} /></div>
      <h2 id="update-dialog-title">
        {t('Updating Tracefold')}
        {#if updater.available}<span class="version">{updater.available.version}</span>{/if}
      </h2>

      <ol class="steps">
        {#each steps as step, index}
          <li class:done={order > index} class:active={order === index}>
            <span class="bullet" aria-hidden="true">
              {#if order > index}<Icon name="check" size={12} />{/if}
            </span>
            <span>{t(step.label)}</span>
          </li>
        {/each}
      </ol>

      {#if updater.phase === 'downloading'}
        <progress
          class="bar"
          value={updater.total ? updater.received : undefined}
          max={updater.total ?? 1}
          aria-label={t('Update download')}
        ></progress>
        <p class="size">{megabytes}</p>
      {:else}
        <div class="bar indeterminate" aria-hidden="true"><span></span></div>
      {/if}

      <p class="reassure">
        {t('Your projects, evidence, and settings stay on this device.')}
      </p>
      <p class="reassure muted">{t('Tracefold reopens on its own when this finishes.')}</p>
    </div>
  </div>
{:else if updater.restartPrompt && updater.available}
  <!-- A staged update is ready but the session is in progress, so restarting is offered
       rather than taken. -->
  <div class="scrim" role="dialog" aria-modal="true" aria-labelledby="update-ready-title">
    <div class="dialog">
      <div class="mark" aria-hidden="true"><Icon name="check" size={22} /></div>
      <h2 id="update-ready-title">{t('Update ready')}</h2>
      <p class="lead">
        {t('Tracefold {version} has been downloaded and installs when you restart.', {
          version: updater.available.version,
        })}
      </p>
      <p class="reassure muted">
        {t('Your work is saved and every project is backed up before it installs.')}
      </p>
      <div class="actions">
        <button class="button" onclick={() => updater.postpone()}>{t('Later')}</button>
        <button class="button primary" onclick={() => updater.install()}>
          {t('Restart now')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #17121ecc;
    backdrop-filter: blur(2px);
  }
  .dialog {
    width: 100%;
    max-width: 440px;
    padding: 30px;
    border: 1px solid var(--line);
    border-radius: var(--dialog-radius);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
  }
  .mark {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-bottom: 16px;
    border-radius: 12px;
    background: var(--selected);
    color: var(--accent);
  }
  h2 {
    margin: 0 0 6px;
    font-family: Newsreader, serif;
    font-size: 25px;
  }
  .version {
    font-family: 'iA Writer Mono', monospace;
    font-size: 15px;
    color: var(--muted);
  }
  .lead {
    margin: 10px 0 0;
    line-height: 1.55;
  }
  .steps {
    list-style: none;
    margin: 20px 0 16px;
    padding: 0;
    display: grid;
    gap: 9px;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .steps li.active {
    color: var(--text);
    font-weight: 500;
  }
  .steps li.done {
    color: var(--muted);
  }
  .bullet {
    display: grid;
    place-items: center;
    width: 17px;
    height: 17px;
    flex: none;
    border: 1px solid var(--line);
    border-radius: 50%;
    color: var(--accent);
  }
  .steps li.active .bullet {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--selected);
  }
  progress.bar {
    width: 100%;
    height: 5px;
    accent-color: var(--accent);
  }
  .bar.indeterminate {
    height: 5px;
    border-radius: 999px;
    background: var(--recessed);
    overflow: hidden;
  }
  .bar.indeterminate span {
    display: block;
    width: 38%;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
    animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide {
    0% {
      margin-left: -38%;
    }
    100% {
      margin-left: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar.indeterminate span {
      width: 100%;
      animation: none;
    }
  }
  .size {
    margin: 7px 0 0;
    font-family: 'iA Writer Mono', monospace;
    font-size: 11px;
    color: var(--muted);
  }
  .reassure {
    margin: 14px 0 0;
    font-size: 12px;
    line-height: 1.55;
  }
  .reassure.muted {
    color: var(--muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 22px;
  }
</style>
