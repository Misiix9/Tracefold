<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { AnyEntity, Revision } from '../../lib/domain/types';
  import { plainText } from '../../lib/domain/defaults';
  import Modal from '../../lib/ui/Modal.svelte';
  import RichEditor from '../../lib/ui/RichEditor.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  let { workspace }: { workspace: Workspace } = $props();
  let open = $state(false),
    busy = $state(false),
    revisions = $state<Revision[]>([]),
    chosen = $state<Revision | null>(null),
    recordId = $state('');
  const current = $derived(workspace.records.find((r) => r.id === recordId));
  const changed = $derived(
    chosen && current
      ? [
          ...(chosen.title !== current.title ? [t('Title')] : []),
          ...(plainText(chosen.entity.body) !== plainText(current.body) ? [t('Writing')] : []),
          ...(JSON.stringify(chosen.entity.tags) !== JSON.stringify(current.tags)
            ? [t('Tags')]
            : []),
          ...(JSON.stringify(chosen.entity.data) !== JSON.stringify(current.data)
            ? [t('Structured details')]
            : []),
        ]
      : [],
  );
  function details(r: AnyEntity): [string, string][] {
    switch (r.kind) {
      case 'session':
        return [
          [t('Charter'), r.data.charter],
          [t('State'), codeLabel(r.data.state)],
          [t('Conclusion'), r.data.conclusion],
          [t('Limitations'), r.data.exclusions],
        ];
      case 'entry':
        return [
          [t('Category'), codeLabel(r.data.category)],
          [t('Expected'), r.data.expected],
          [t('Actual'), r.data.actual],
        ];
      case 'finding':
        return [
          [t('Status'), codeLabel(r.data.status)],
          [t('Severity'), codeLabel(r.data.severity)],
          [t('Steps'), r.data.steps.join('\n')],
          [t('Expected'), r.data.expected],
          [t('Actual'), r.data.actual],
          [t('Suspected cause'), r.data.suspectedCause],
          [t('Confirmed cause'), r.data.confirmedCause],
          [t('Resolution'), r.data.resolution],
        ];
      case 'case':
        return [
          [t('Prerequisites'), r.data.prerequisites],
          [
            t('Steps'),
            r.data.steps
              .map((s, i) => `${i + 1}. ${s.action}\n${t('Expected')}: ${s.expected}`)
              .join('\n\n'),
          ],
        ];
      case 'run':
        return [
          [t('State'), codeLabel(r.data.state)],
          [
            t('Results'),
            r.data.executions
              .map(
                (e) =>
                  `${e.caseTitle} · ${codeLabel(e.outcome)}${e.reason ? ` — ${e.reason}` : ''}`,
              )
              .join('\n'),
          ],
          [t('Conclusion'), r.data.conclusion],
        ];
      case 'requirement':
        return [
          [t('Description'), r.data.description],
          [t('Acceptance criteria'), r.data.acceptanceCriteria],
        ];
      case 'evidence':
        return [
          [t('Caption'), r.data.caption],
          [t('File'), r.data.filename],
          [t('Privacy'), r.data.private ? t('Private') : t('Shareable')],
        ];
      case 'template':
        return [
          [t('Description'), r.data.description],
          [t('Sections'), r.data.sections.map((s) => s.title).join('\n')],
        ];
      default:
        return [];
    }
  }
  async function show() {
    if (!workspace.selectedId) return;
    busy = true;
    try {
      await workspace.flush();
      recordId = workspace.selectedId;
      revisions = await workspace.repo.getRevisions(recordId, workspace.projectId);
      chosen = revisions[0] ?? null;
      open = true;
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
  async function restore() {
    if (!chosen || !current) return;
    busy = true;
    try {
      await workspace.flush();
      const latest = workspace.records.find((r) => r.id === recordId);
      if (!latest) throw new Error(t('The current record is unavailable.'));
      const historical = structuredClone($state.snapshot(chosen.entity));
      if (historical.kind === 'session') {
        historical.data.state =
          historical.data.state === 'active' ? 'paused' : historical.data.state;
        historical.data.activeSince = undefined;
      }
      if (historical.kind === 'run') {
        const copy = await workspace.create(
          'run',
          historical.title + ' · recovered copy',
          historical.data,
          historical.body,
        );
        workspace.navigate('runs', copy.id);
        workspace.notify(t('Recovered run as an independent copy.'));
      } else {
        workspace.edit({
          ...historical,
          id: latest.id,
          projectId: latest.projectId,
          revision: latest.revision,
          createdAt: latest.createdAt,
          deletedAt: latest.deletedAt,
        });
        await workspace.flush();
        workspace.notify(t('Earlier version restored. Later versions remain in history.'));
      }
      open = false;
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
</script>

<button class="button ghost" disabled={busy} onclick={show} title={t('Review saved versions')}
  ><Icon name="clock" size={16} />{t('History')}</button
>
<Modal
  bind:open
  title={t('Every version, kept')}
  description={t('Review saved changes and recover an earlier version.')}
  wide
>
  <div class="history-layout">
    <div class="history-list" aria-label={t('Saved versions')}>
      {#each revisions as revision}<button
          class="history-item"
          class:selected={chosen?.id === revision.id}
          aria-pressed={chosen?.id === revision.id}
          onclick={() => (chosen = revision)}
          ><strong>{new Date(revision.at).toLocaleString(intlLocale())}</strong><span
            >{t('Version')}
            {revision.revision}{revision.revision === current?.revision
              ? ' · ' + t('Current')
              : ''}</span
          ></button
        >{:else}<p class="muted">{t('No saved versions are available.')}</p>{/each}
    </div>
    {#if chosen}<article class="history-preview">
        <span class="eyebrow">{t('Version')} {chosen.revision}</span>
        <h2>{chosen.title || t('Untitled')}</h2>
        {#if changed.length}<p class="muted small">
            {t('Differs from the current version:')}
            {changed.join(', ').toLowerCase()}.
          </p>{/if}<RichEditor value={chosen.entity.body} readonly />
        <dl>
          {#each details(chosen.entity).filter(([, value]) => value) as [label, value]}<dt>
              {label}
            </dt>
            <dd>{value}</dd>{/each}
        </dl>
      </article>{/if}
  </div>
  <div class="modal-actions">
    <button class="button" onclick={() => (open = false)}>{t('Close')}</button><button
      class="button primary"
      disabled={busy || !chosen || chosen.revision === current?.revision}
      onclick={restore}
      >{current?.kind === 'run' ? t('Recover as separate run') : t('Restore this version')}</button
    >
  </div>
</Modal>

<style>
  .history-layout {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 24px;
    min-height: 320px;
    max-height: 60vh;
    overflow: hidden;
  }
  .history-list,
  .history-preview {
    overflow: auto;
  }
  .history-list {
    border-right: 1px solid var(--line);
    padding-right: 12px;
  }
  .history-item {
    display: flex;
    flex-direction: column;
    gap: 5px;
    text-align: left;
    width: 100%;
    padding: 12px;
    border-radius: var(--radius);
    color: var(--muted);
  }
  .history-item strong {
    font-size: 11px;
    font-weight: 500;
  }
  .history-item span {
    font-size: 10px;
  }
  .history-item.selected {
    background: var(--selected);
    color: var(--text);
  }
  .history-preview h2 {
    font:
      26px/1.3 Newsreader,
      serif;
    margin: 8px 0 12px;
  }
  .history-preview dt {
    font-size: 11px;
    color: var(--muted);
    margin-top: 14px;
  }
  .history-preview dd {
    font-size: 12px;
    white-space: pre-wrap;
    margin: 5px 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 800px) {
    .history-layout {
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 14px;
    }
  }
</style>
