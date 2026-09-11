<script lang="ts">
  import { errorText } from '../../lib/i18n/errors';
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { ReportSnapshot } from '../../lib/services/reports/types';
  import { previewProjectFile, prepareProjectImport } from '../../lib/services/packages/import';
  import Modal from '../../lib/ui/Modal.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  let { workspace }: { workspace: Workspace } = $props();
  let open = $state(false),
    busy = $state(false),
    preview = $state<ReportSnapshot | null>(null),
    filename = $state(''),
    error = $state('');
  async function choose(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    open = true;
    busy = true;
    preview = null;
    filename = file.name;
    error = '';
    try {
      if (file.size > 160 * 1024 * 1024) throw new Error(t('Choose a package up to 160 MiB.'));
      preview = await previewProjectFile(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
  async function confirm() {
    if (!preview) return;
    const finishOperation = workspace.beginOperation();
    busy = true;
    error = '';
    try {
      await workspace.flush();
      const project = await workspace.repo.importProject(
        prepareProjectImport($state.snapshot(preview), workspace.repo.mode),
      );
      workspace.projects = await workspace.repo.listProjects();
      await workspace.openProject(project.id);
      workspace.navigate('notebook');
      open = false;
      workspace.notify(t('Project imported as an independent copy'));
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
      finishOperation();
    }
  }
</script>

<label class="button"
  ><Icon name="upload" size={15} />{t('Import a project')}<input
    class="sr-only"
    type="file"
    accept=".tracefold,.json"
    onchange={choose}
  /></label
>
<Modal
  bind:open
  title={t('Review the incoming project')}
  description={t(
    'This creates a new independent project. Existing projects are never overwritten.',
  )}
  wide
  ><div class="form-stack">
    <p class="mono small">{filename}</p>
    {#if busy && !preview}<p class="notice">
        {t('Checking the archive, record graph, and evidence hashes…')}
      </p>{/if}{#if error}<div class="notice warning" role="alert">
        {error}
      </div>{/if}{#if preview}<h2>{preview.project.name}</h2>
      <p class="muted small">{preview.project.description}</p>
      <div class="metrics-line">
        <div class="metric">
          <strong>{preview.records.length}</strong><span>{t('Records')}</span>
        </div>
        <div class="metric">
          <strong>{Object.keys(preview.assets).length}</strong><span>{t('Verified assets')}</span>
        </div>
        <div class="metric">
          <strong
            >{(Object.values(preview.assets).reduce((n, a) => n + a.size, 0) / 1024 / 1024).toFixed(
              1,
            )} MB</strong
          ><span>{t('Evidence')}</span>
        </div>
      </div>
      <div class="table-wrapper" style="max-height:280px">
        <table class="data-table">
          <thead><tr><th>{t('Type')}</th><th>{t('Title')}</th></tr></thead><tbody
            >{#each preview.records.slice(0, 50) as r}<tr
                ><td>{codeLabel(r.kind)}</td><td>{r.title}</td></tr
              >{/each}</tbody
          >
        </table>
      </div>
      {#if preview.records.length > 50}<p class="muted small">
          {t('Showing 50 of')}
          {preview.records.length}
          {t('records.')}
        </p>{/if}{/if}
  </div>
  <div class="modal-actions">
    <button class="button" disabled={busy} onclick={() => (open = false)}>{t('Cancel')}</button
    ><button class="button primary" disabled={busy || !preview || !!error} onclick={confirm}
      >{busy ? t('Importing…') : t('Import independent copy')}</button
    >
  </div></Modal
>
