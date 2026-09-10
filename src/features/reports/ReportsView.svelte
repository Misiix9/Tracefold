<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import { onMount } from 'svelte';
  import { isPresetPrimary } from '../../lib/services/reports/presets';
  import EvidencePreview from './EvidencePreview.svelte';
  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { ReportOptions } from '../../lib/domain/types';
  import type { ReportSnapshot, ReportPreset } from '../../lib/services/reports/types';
  import { assembleReportSnapshot } from '../../lib/services/reports/snapshot';
  import { buildReportModel } from '../../lib/services/reports/model';
  import { richHtml } from '../../lib/services/reports/text-renderers';
  import { exportReport } from '../../lib/services/reports/export';
  import Icon from '../../lib/ui/Icon.svelte';
  import TextField from '../../lib/ui/TextField.svelte';
  import EmptyState from '../../lib/ui/EmptyState.svelte';
  let { workspace }: { workspace: Workspace } = $props();
  let title = $state(''),
    author = $state(''),
    audience = $state(''),
    build = $state(''),
    format = $state<ReportOptions['format'] | 'tracefold'>('pdf'),
    preset = $state<ReportPreset>('release'),
    pageSize = $state<'A4' | 'LETTER'>('A4'),
    includeEvidence = $state(true),
    selectedIds = $state<string[]>([]),
    scope = $state<'project' | 'selected'>('project'),
    snapshot = $state<ReportSnapshot | null>(null),
    busy = $state(false);
  let prepareGeneration = 0;
  const model = $derived(snapshot ? buildReportModel(snapshot) : null);
  const shareable = $derived(
    workspace.visible.filter(
      (r) =>
        !('private' in r.data && r.data.private) &&
        r.kind !== 'template' &&
        isPresetPrimary(r.kind, preset),
    ),
  );
  onMount(() => {
    pageSize = workspace.settings.pageSize;
  });
  async function prepare() {
    if (!workspace.project) return;
    busy = true;
    const generation = ++prepareGeneration;
    try {
      await workspace.flush();
      const projectId = workspace.projectId;
      const prepared = await assembleReportSnapshot({
        project: $state.snapshot(workspace.project),
        records: $state.snapshot(workspace.visible),
        options: {
          language: workspace.settings.language,
          title: title || `${workspace.project.name} · ${t('Test report')}`,
          author: author || workspace.settings.author,
          audience,
          build,
          preset,
          format: format === 'tracefold' ? 'json' : format,
          pageSize,
          includeEvidence,
          includePrivate: false,
          includeHistory: false,
          scope,
          entityIds: selectedIds.filter((id) => shareable.some((r) => r.id === id)),
        },
        readAsset: (id) => workspace.repo.readAsset(projectId, id),
      });
      if (generation === prepareGeneration && projectId === workspace.projectId)
        snapshot = prepared;
    } catch (e) {
      snapshot = null;
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (!snapshot) return;
    busy = true;
    try {
      const output = await exportReport($state.snapshot(snapshot), format === 'tracefold');
      if (await workspace.repo.saveFile(output.filename, output.mimeType, output.bytes))
        workspace.notify(t('Report exported'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
  function invalidate() {
    prepareGeneration++;
    snapshot = null;
  }
</script>

<div class="report-layout">
  <aside class="report-controls">
    <div>
      <div class="eyebrow">{t('From your work to their next step')}</div>
      <h1>{t('Report studio')}</h1>
      <p class="muted small" style="margin-top:10px">
        {t('A clear handoff, without writing everything twice.')}
      </p>
    </div>
    <div
      class="form-stack"
      oninput={invalidate}
      onchange={invalidate}
      role="group"
      aria-label={t('Report options')}
    >
      <TextField
        label={t('Report title')}
        value={title}
        onchange={(v) => (title = v)}
        placeholder={`${workspace.project?.name ?? t('Project')} · ${t('Test report')}`}
      /><label class="field"
        ><span class="field-label">{t('Report purpose')}</span><select bind:value={preset}
          ><option value="release">{t('Release summary')}</option><option value="finding"
            >{t('Finding report')}</option
          ><option value="walkthrough">{t('Walkthrough')}</option><option value="session"
            >{t('Session debrief')}</option
          ><option value="run">{t('Test run')}</option><option value="coverage"
            >{t('Coverage report')}</option
          ></select
        ></label
      >
      <div class="form-grid">
        <TextField
          label={t('Author')}
          value={author}
          onchange={(v) => (author = v)}
          placeholder={workspace.settings.author || t('Optional')}
        /><TextField
          label={t('Build')}
          value={build}
          onchange={(v) => (build = v)}
          placeholder={t('Optional')}
        />
      </div>
      <TextField
        label={t('Audience')}
        value={audience}
        onchange={(v) => (audience = v)}
        placeholder={t('Who will read this?')}
      />
      <div class="form-grid">
        <label class="field"
          ><span class="field-label">{t('Format')}</span><select bind:value={format}
            ><option value="pdf">PDF</option><option value="docx">{t('Word document')}</option
            ><option value="html">{t('Offline HTML')}</option><option value="markdown"
              >{t('Markdown + assets')}</option
            ><option value="csv">CSV</option><option value="json">{t('Versioned JSON')}</option
            ><option value="tracefold">{t('Tracefold package')}</option></select
          ></label
        ><label class="field"
          ><span class="field-label">{t('Page size')}</span><select bind:value={pageSize}
            ><option value="A4">A4</option><option value="LETTER">{t('US Letter')}</option></select
          ></label
        >
      </div>
      <label class="field"
        ><span class="field-label">{t('Include')}</span><select bind:value={scope}
          ><option value="project"
            >{preset === 'release' ? t('Whole project') : t('All matching records')}</option
          ><option value="selected">{t('Selected records')}</option></select
        ></label
      >{#if scope === 'selected'}<div class="selection-list">
          {#each shareable as r}<label class="check-row"
              ><input
                type="checkbox"
                checked={selectedIds.includes(r.id)}
                onchange={(e) =>
                  (selectedIds = e.currentTarget.checked
                    ? [...selectedIds, r.id]
                    : selectedIds.filter((id) => id !== r.id))}
              />{r.title}</label
            >{/each}
        </div>{/if}<label class="check-row"
        ><input type="checkbox" bind:checked={includeEvidence} />{t(
          'Include sanitized evidence',
        )}</label
      >
    </div>
    <div class="notice">
      <Icon name="shield" size={16} />
      {t(
        'Private records, original redacted pixels, and revision history stay out of share exports.',
      )}
    </div>
    <button class="button primary" disabled={busy || !workspace.visible.length} onclick={prepare}
      ><Icon name="eye" size={16} />{busy ? t('Preparing…') : t('Prepare preview')}</button
    >
  </aside>
  <section class="report-preview">
    {#if model && snapshot}<div class="preview-toolbar">
        <span class="muted small"
          >{t('Frozen preview ·')} {snapshot.records.length} {t('records')}</span
        ><span class="spacer"></span><button class="button primary" disabled={busy} onclick={save}
          ><Icon name="download" size={15} />{busy ? t('Exporting…') : t('Export report')}</button
        >
      </div>
      <article class="report-paper">
        <div class="report-wordmark">Tracefold / {snapshot.project.name}</div>
        <h1>{model.title}</h1>
        <p class="report-subtitle">{model.subtitle}</p>
        {#each model.summary as block}{@html richHtml(
            block,
          )}{/each}{#each model.sections as section}<section>
            <h2>{section.title}</h2>
            {#each section.blocks as block}{@html richHtml(
                block,
              )}{/each}{#each section.evidence as evidence}<EvidencePreview
                asset={evidence.asset}
                caption={evidence.caption}
              />{/each}
          </section>{/each}
      </article>{:else}<EmptyState
        icon="reports"
        title={t('Your work, ready to share')}
        description={t(
          'Choose a purpose and the records to include. Preview a frozen, sanitized copy before exporting.',
        )}
      />
      <div class="report-note">
        <span class="eyebrow">{t('One source, many formats')}</span>
        <p>
          {t(
            'Editable Word documents. Self-contained HTML. Print-ready PDF. Portable records for the next tester.',
          )}
        </p>
      </div>{/if}
  </section>
</div>

<style>
  .report-layout {
    display: grid;
    grid-template-columns: 340px minmax(0, 1fr);
    min-height: 100%;
  }
  .report-controls {
    padding: 28px 24px;
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .report-controls h1 {
    font-size: 30px;
    margin-top: 10px;
  }
  .report-controls .eyebrow {
    font-size: 9px;
    letter-spacing: 0.07em;
  }
  .report-controls :global(.field label),
  .report-controls .field-label {
    font-size: 11px;
  }
  .report-controls input,
  .report-controls select {
    font-size: 11px;
  }
  .report-controls .form-grid {
    gap: 12px;
  }
  .report-controls .notice {
    font-size: 10px;
    line-height: 1.8;
  }
  .report-controls .notice :global(.icon) {
    margin-right: 4px;
  }
  .report-preview {
    padding: 24px;
    background: var(--canvas);
    min-width: 0;
  }
  .preview-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .report-paper {
    max-width: 790px;
    margin: 0 auto;
    background: var(--surface);
    padding: 48px;
    border: 1px solid var(--line);
    box-shadow: 0 3px 14px #26252208;
    overflow-wrap: anywhere;
  }
  .report-wordmark {
    font-size: 10px;
    color: var(--muted);
    margin-bottom: 40px;
  }
  .report-paper h1 {
    font-size: 34px;
  }
  .report-subtitle {
    font-size: 11px;
    color: var(--muted);
    margin: 16px 0 32px;
  }
  .report-paper section {
    border-top: 1px solid var(--line);
    padding-top: 24px;
    margin-top: 28px;
  }
  .report-paper h2 {
    font-family: Newsreader, serif;
    font-size: 25px;
    margin-bottom: 16px;
  }
  .report-paper :global(p) {
    font-size: 12px;
    line-height: 1.8;
    margin-bottom: 12px;
  }
  .report-paper :global(h3) {
    font-size: 14px;
    margin: 18px 0 12px;
  }
  .report-paper :global(table) {
    border-collapse: collapse;
    table-layout: fixed;
    width: 100%;
    font-size: 11px;
  }
  .report-paper :global(td),
  .report-paper :global(th) {
    padding: 8px;
    border: 1px solid var(--line);
    text-align: left;
  }
  .report-paper :global(pre) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 12px;
    background: var(--canvas);
    font-size: 11px;
  }

  .report-note {
    max-width: 370px;
    margin: 0 auto;
    color: var(--muted);
    text-align: center;
  }
  .report-note p {
    font-size: 12px;
    line-height: 1.9;
    margin-top: 10px;
  }
  .selection-list {
    max-height: 230px;
    overflow: auto;
    display: grid;
    gap: 10px;
  }
  @media (max-width: 1050px) {
    .report-layout {
      grid-template-columns: 1fr;
    }
    .report-controls {
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .report-paper {
      padding: 28px;
    }
  }
</style>
