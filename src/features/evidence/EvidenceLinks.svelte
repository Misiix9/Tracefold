<script lang="ts">
  import { t } from '../../lib/i18n/i18n.svelte';
  import type { Workspace } from '../../lib/services/workspace.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { importEvidence } from './evidence';
  let {
    workspace,
    recordId,
    ids = [],
    onchange,
    readonly = false,
  }: {
    workspace: Workspace;
    recordId: string;
    ids?: string[];
    onchange?: (ids: string[]) => void;
    readonly?: boolean;
  } = $props();
  let busy = $state(false);
  const available = $derived(
    workspace.visible.filter((r) => r.kind === 'evidence' && !ids.includes(r.id)),
  );
  async function attach(event: Event) {
    const input = event.currentTarget as HTMLInputElement,
      files = Array.from(input.files ?? []);
    if (!files.length || readonly || busy) return;
    const projectId = workspace.projectId,
      target = recordId;
    busy = true;
    try {
      const added = await importEvidence(workspace, files);
      if (projectId !== workspace.projectId || target !== recordId)
        throw new Error(
          t('The selected record changed. The imported files are available in Evidence.'),
        );
      onchange?.([...new Set([...ids, ...added.map((r) => r.id)])]);
    } catch (error) {
      workspace.fail(error);
    } finally {
      busy = false;
      input.value = '';
    }
  }
</script>

<div class="evidence-links">
  {#each ids as id}{@const item = workspace.visible.find(
      (r) => r.id === id && r.kind === 'evidence',
    )}
    <div class="evidence-link">
      <button
        class="button small"
        disabled={!item}
        onclick={() => workspace.navigate('evidence', id)}
        ><Icon name="attach" size={14} />{item?.title ??
          t('Unavailable evidence')}{#if item?.kind === 'evidence' && item.data.private}<Icon
            name="lock"
            size={12}
          />{/if}</button
      >
      {#if !readonly}<button
          class="icon-button"
          aria-label={t('Detach evidence: {title}', {
            title: item?.title ?? t('Unavailable evidence'),
          })}
          onclick={() => onchange?.(ids.filter((value) => value !== id))}
          ><Icon name="close" size={14} /></button
        >{/if}
    </div>
  {:else}{#if readonly}<p class="muted small">{t('No evidence attached.')}</p>{/if}{/each}
  {#if !readonly}<div class="button-row">
      <label class="button small"
        ><Icon name="attach" size={14} />{busy ? t('Importing…') : t('Attach evidence')}<input
          class="sr-only"
          type="file"
          multiple
          disabled={busy}
          onchange={attach}
        /></label
      >
      {#if available.length}<select
          aria-label={t('Link existing evidence')}
          value=""
          disabled={busy}
          onchange={(e) => {
            if (e.currentTarget.value) onchange?.([...new Set([...ids, e.currentTarget.value])]);
            e.currentTarget.value = '';
          }}
          ><option value="">{t('Link existing evidence…')}</option>{#each available as item}<option
              value={item.id}>{item.title}</option
            >{/each}</select
        >{/if}
    </div>{/if}
</div>

<style>
  .evidence-links {
    display: grid;
    gap: 9px;
    margin-top: 12px;
    min-width: 0;
  }
  .evidence-link {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .evidence-link > .button {
    min-width: 0;
    white-space: normal;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .button-row select {
    max-width: 280px;
    font-size: 12px;
  }
  .button-row {
    flex-wrap: wrap;
  }
</style>
