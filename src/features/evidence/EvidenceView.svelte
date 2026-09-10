<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { Entity } from '../../lib/domain/types';
  import Icon from '../../lib/ui/Icon.svelte';
  import Modal from '../../lib/ui/Modal.svelte';
  import EmptyState from '../../lib/ui/EmptyState.svelte';
  import TextField from '../../lib/ui/TextField.svelte';
  import AnnotationEditor from './AnnotationEditor.svelte';
  import { importEvidence, blobOf } from './evidence';
  let { workspace }: { workspace: Workspace } = $props();
  let query = $state(''),
    url = $state(''),
    content = $state(''),
    loading = $state(false),
    annotate = $state(false),
    dragging = $state(false),
    scrollTop = $state(0),
    video = $state<HTMLVideoElement>(),
    timestampLabel = $state(''),
    lineQuery = $state('');
  const evidence = $derived(workspace.selected?.kind === 'evidence' ? workspace.selected : null);
  const items = $derived(
    workspace.visible.filter(
      (r): r is Entity<'evidence'> =>
        r.kind === 'evidence' && r.title.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const lines = $derived(content.split('\n'));
  const firstLine = $derived(Math.max(0, Math.floor(scrollTop / 22) - 10));
  const shownLines = $derived(lines.slice(firstLine, firstLine + 100));
  const usedBy = $derived(
    evidence
      ? workspace.visible.filter(
          (r) => r.id !== evidence.id && JSON.stringify(r.data).includes(evidence.id),
        )
      : [],
  );
  $effect(() => {
    const item = evidence;
    if (!item) {
      url = '';
      content = '';
      return;
    }
    const assetId = item.data.sanitizedAssetId ?? item.data.assetId;
    let active = true,
      objectUrl = '';
    loading = true;
    url = '';
    content = '';
    scrollTop = 0;
    void workspace.repo
      .readAsset(item.projectId, assetId)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blobOf(bytes, item.data.mimeType));
        url = objectUrl;
        if (
          item.data.mimeType.startsWith('text/') ||
          ['application/json', 'application/xml'].includes(item.data.mimeType)
        )
          content = new TextDecoder().decode(bytes);
      })
      .catch((e) => workspace.fail(e))
      .finally(() => {
        if (active) loading = false;
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
  async function add(files: File[]) {
    loading = true;
    try {
      const added = await importEvidence(workspace, files);
      if (added[0]) workspace.navigate('evidence', added[0].id);
    } catch (e) {
      workspace.fail(e);
    } finally {
      loading = false;
    }
  }
  async function input(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    await add(Array.from(input.files ?? []));
    input.value = '';
  }
  async function saveCopy() {
    if (!evidence) return;
    try {
      const bytes = await workspace.repo.readAsset(
        evidence.projectId,
        evidence.data.sanitizedAssetId ?? evidence.data.assetId,
      );
      if (await workspace.repo.saveFile(evidence.data.filename, evidence.data.mimeType, bytes))
        workspace.notify(t('Evidence saved'));
    } catch (e) {
      workspace.fail(e);
    }
  }
  function usedRoute(r: Entity) {
    return {
      document: 'notebook',
      session: 'notebook',
      entry: 'notebook',
      finding: 'findings',
      case: 'cases',
      run: 'runs',
      requirement: 'coverage',
      evidence: 'evidence',
      template: 'templates',
    }[r.kind];
  }
  function addTimestamp() {
    if (!evidence || !video || !Number.isFinite(video.currentTime)) return;
    workspace.edit({
      ...evidence,
      data: {
        ...evidence.data,
        timestampReferences: [
          ...(evidence.data.timestampReferences ?? []),
          {
            seconds: video.currentTime,
            label: timestampLabel || `At ${video.currentTime.toFixed(1)}s`,
          },
        ],
      },
    });
    timestampLabel = '';
  }
</script>

<div
  class:dragging
  class="evidence-root"
  role="region"
  aria-label={t('Evidence workspace')}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => {
    e.preventDefault();
    dragging = false;
    void add(Array.from(e.dataTransfer?.files ?? []));
  }}
>
  {#if !evidence}<section class="page">
      <div class="page-heading">
        <div>
          <h1>{t('Evidence')}</h1>
          <p>{t('The details that make a finding reproducible.')}</p>
        </div>
        <label class="button primary"
          ><Icon name="upload" size={16} />{t('Import evidence')}<input
            class="sr-only"
            type="file"
            multiple
            onchange={input}
          /></label
        >
      </div>
      <div class="page-tools">
        <div class="filter-input">
          <Icon name="search" size={16} /><input
            bind:value={query}
            aria-label={t('Search evidence')}
            placeholder={t('Find an image, log, or recording…')}
          />
        </div>
        <span class="spacer"></span><span class="muted small"
          >{t('Drop files here or paste an image')}</span
        >
      </div>
      {#if !items.length}<EmptyState
          icon="evidence"
          title={t('Show exactly what happened')}
          description={t(
            'Keep screenshots, recordings, logs, and supporting files together. Annotate images and redact sensitive details before sharing.',
          )}
        />{:else}<div class="evidence-grid">
          {#each items as item}<button
              class="evidence-card"
              onclick={() => workspace.navigate('evidence', item.id)}
              ><div class="evidence-cover">
                <Icon
                  name={item.data.mimeType.startsWith('image/')
                    ? 'evidence'
                    : item.data.mimeType.startsWith('video/')
                      ? 'run'
                      : 'file'}
                  size={36}
                />{#if item.data.private}<span class="tag"
                    ><Icon name="lock" size={12} />{t('Private')}</span
                  >{/if}
              </div>
              <div class="evidence-caption">
                <strong>{item.title}</strong><span
                  >{item.data.mimeType} · {(item.data.size / 1024).toFixed(0)} KB</span
                >
              </div></button
            >{/each}
        </div>{/if}
    </section>
  {:else}<div class="detail-layout">
      <article class="detail-main">
        <button class="detail-back" onclick={() => workspace.navigate('evidence')}
          ><Icon name="back" size={14} />{t('All evidence')}</button
        ><input
          class="title-input"
          aria-label={t('Evidence title')}
          value={evidence.title}
          oninput={(e) => workspace.edit({ ...evidence, title: e.currentTarget.value })}
        />
        <div class="detail-meta">
          <span>{evidence.data.mimeType}</span><span
            >{(evidence.data.size / 1024).toFixed(0)} KB</span
          >{#if evidence.data.sanitizedAssetId}<span class="tag accent"
              >{t('Flattened sharing copy')}</span
            >{/if}<span class="spacer"
          ></span>{#if evidence.data.mimeType.startsWith('image/')}<button
              class="button small"
              onclick={() => (annotate = true)}
              ><Icon name="edit" size={14} />{t('Annotate & redact')}</button
            >{/if}
        </div>
        {#if loading}<p class="notice">
            {t('Loading evidence…')}
          </p>{:else if evidence.data.mimeType.startsWith('image/') && url}<div
            class="image-preview"
          >
            <img src={url} alt={evidence.data.caption || evidence.title} />
          </div>{:else if evidence.data.mimeType.startsWith('video/') && url}<video
            controls
            src={url}
            bind:this={video}
            aria-label={evidence.title}><track kind="captions" /></video
          >
          <p class="muted small" style="margin:12px 0">
            {t(
              'Playback depends on your system’s codecs. Save a copy to open it in another player if needed.',
            )}
          </p>
          <div class="button-row">
            <input
              aria-label={t('Timestamp label')}
              bind:value={timestampLabel}
              placeholder={t('What happens at this moment?')}
            /><button class="button" onclick={addTimestamp}
              ><Icon name="clock" size={15} />{t('Mark timestamp')}</button
            >
          </div>
          {#each evidence.data.timestampReferences ?? [] as point}<button
              class="list-row"
              onclick={() => {
                if (video) video.currentTime = point.seconds;
              }}
              ><span class="mono">{point.seconds.toFixed(1)}s</span><span>{point.label}</span
              ></button
            >{/each}
        {:else if content}<div class="button-row" style="margin-bottom:12px">
            <input
              aria-label={t('Find in log')}
              bind:value={lineQuery}
              placeholder={t('Find text in the log…')}
            /><span class="muted small"
              >{lines.length.toLocaleString(intlLocale())} {t('lines')}</span
            >
          </div>
          {#if lineQuery}<div class="log-matches">
              {#each lines
                .map((line, i) => ({ line, i }))
                .filter((x) => x.line.toLowerCase().includes(lineQuery.toLowerCase()))
                .slice(0, 100) as match}<p><span>{match.i + 1}</span>{match.line}</p>{:else}<p>
                  {t('No matching lines.')}
                </p>{/each}
            </div>{:else}<div
              class="log-view"
              onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
            >
              <div style:height="{lines.length * 22}px" style="position:relative">
                <div style:top="{firstLine * 22}px" style="position:absolute;min-width:100%">
                  {#each shownLines as line, i}<div class="log-line">
                      <span>{firstLine + i + 1}</span><code>{line || ' '}</code>
                    </div>{/each}
                </div>
              </div>
            </div>{/if}{:else}<EmptyState
            icon="file"
            title={t('File attached')}
            description={t(
              'This file is stored with your project. Save a copy to open it in its native application.',
            )}
            action={t('Save a copy')}
            onclick={saveCopy}
          />{/if}
        <div class="section-rule">
          <TextField
            label={t('Caption')}
            multiline
            value={evidence.data.caption}
            onchange={(caption) =>
              workspace.edit({ ...evidence, data: { ...evidence.data, caption } })}
            placeholder={t('Explain what this evidence establishes.')}
          />
        </div>
      </article>
      <aside class="context-panel">
        <div class="context-heading">
          <h2>{t('Evidence details')}</h2>
          <Icon name="evidence" size={18} />
        </div>
        <div class="form-stack">
          <label class="check-row"
            ><input
              type="checkbox"
              checked={evidence.data.private}
              onchange={(e) =>
                workspace.edit({
                  ...evidence,
                  data: { ...evidence.data, private: e.currentTarget.checked },
                })}
            />{t('Keep this evidence private')}</label
          >
          <p class="muted small">{t('Private evidence is excluded from share exports.')}</p>
          <button class="button" onclick={saveCopy}
            ><Icon name="download" size={15} />{t('Save a copy')}</button
          >
        </div>
        <section>
          <h3>{t('Where it’s used')}</h3>
          {#each usedBy as record}<button
              class="list-row"
              onclick={() =>
                workspace.navigate(
                  usedRoute(record),
                  record.kind === 'entry' ? record.data.sessionId : record.id,
                )}><span class="list-title">{record.title}</span></button
            >{:else}<p class="muted small">{t('No linked records yet.')}</p>{/each}
        </section>
        <section>
          <h3>{t('File integrity')}</h3>
          <p class="hash mono">{evidence.data.hash}</p>
          <p class="muted small">{t('SHA-256 · immutable original asset')}</p>
        </section>
        <button
          class="button ghost danger"
          onclick={() => workspace.remove(evidence.id).catch((e) => workspace.fail(e))}
          ><Icon name="trash" size={14} />{t('Move to Trash')}</button
        >
      </aside>
    </div>{/if}
</div>
<Modal
  bind:open={annotate}
  title={t('Make the evidence clear')}
  description={t('Annotate, crop, or permanently cover sensitive pixels in the sharing copy.')}
  wide
  >{#if evidence && annotate}<AnnotationEditor
      {workspace}
      {evidence}
      onclose={() => (annotate = false)}
    />{/if}</Modal
>

<style>
  .evidence-root {
    min-height: 100%;
  }
  .evidence-root.dragging {
    outline: 3px dashed var(--accent);
    outline-offset: -8px;
    background: var(--selected);
  }
  .evidence-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 20px;
  }
  .evidence-card {
    text-align: left;
    border: 1px solid var(--line);
    border-radius: var(--panel-radius);
    overflow: hidden;
    padding: 0;
  }
  .evidence-card:hover {
    border-color: var(--accent);
  }
  .evidence-cover {
    height: 140px;
    background: var(--canvas);
    color: var(--muted);
    display: grid;
    place-items: center;
    position: relative;
  }
  .evidence-cover .tag {
    position: absolute;
    top: 10px;
    right: 10px;
  }
  .evidence-caption {
    padding: 14px;
    display: grid;
    gap: 5px;
  }
  .evidence-caption strong {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .evidence-caption > span {
    font-size: 10px;
    color: var(--muted);
  }
  .image-preview {
    background: var(--canvas);
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--panel-radius);
    text-align: center;
  }
  .image-preview img {
    max-width: 100%;
    max-height: 65vh;
    object-fit: contain;
  }
  video {
    display: block;
    width: 100%;
    max-height: 60vh;
    background: #161514;
    border-radius: var(--radius);
  }
  .hash {
    overflow-wrap: anywhere;
    font-size: 10px;
    line-height: 1.8;
    margin-bottom: 8px;
  }
  .log-view {
    height: 440px;
    overflow: auto;
    background: var(--canvas);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .log-line {
    display: flex;
    height: 22px;
    line-height: 22px;
    font-size: 11px;
    white-space: pre;
  }
  .log-line > span,
  .log-matches span {
    min-width: 56px;
    padding-right: 12px;
    text-align: right;
    color: var(--muted);
    user-select: none;
    display: inline-block;
    flex: none;
  }
  .log-line code {
    padding-right: 20px;
  }
  .log-matches {
    font:
      11px/22px 'iA Writer Mono',
      monospace;
    max-height: 440px;
    overflow: auto;
    background: var(--canvas);
  }
  .log-matches p {
    white-space: pre;
  }
</style>
