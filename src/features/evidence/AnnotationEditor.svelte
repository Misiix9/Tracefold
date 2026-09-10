<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import { onMount } from 'svelte';
  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { Annotation, Entity, EvidenceData } from '../../lib/domain/types';
  import { newId } from '../../lib/domain/defaults';
  import Icon from '../../lib/ui/Icon.svelte';
  import { imageFrom, drawAnnotation, flattenImage } from './evidence';
  let {
    workspace,
    evidence,
    onclose,
  }: { workspace: Workspace; evidence: Entity<'evidence'>; onclose: () => void } = $props();
  let canvas: HTMLCanvasElement;
  let image: HTMLImageElement | undefined;
  let bytes: Uint8Array;
  let annotations = $state<Annotation[]>([]),
    crop = $state<EvidenceData['crop']>(),
    tool = $state<Annotation['tool'] | 'crop'>('arrow'),
    color = $state('#B13E32'),
    text = $state(''),
    zoom = $state(1),
    saving = $state(false),
    loaded = $state(false),
    drawing = $state<Annotation | null>(null),
    undo = $state<{ annotations: Annotation[]; crop?: EvidenceData['crop'] }[]>([]),
    redo = $state<typeof undo>([]);
  let x = $state(40),
    y = $state(40),
    width = $state(160),
    height = $state(80);
  const tools = [
    'arrow',
    'rectangle',
    'ellipse',
    'highlight',
    'text',
    'number',
    'redact',
    'crop',
  ] as const;
  onMount(() => {
    let live = true;
    void (async () => {
      bytes = await workspace.repo.readAsset(evidence.projectId, evidence.data.assetId);
      image = await imageFrom(bytes, evidence.data.mimeType);
      if (!live) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      annotations = JSON.parse(JSON.stringify(evidence.data.annotations));
      crop = evidence.data.crop ? { ...evidence.data.crop } : undefined;
      loaded = true;
      paint();
    })().catch((e) => workspace.fail(e));
    return () => {
      live = false;
    };
  });
  $effect(() => {
    annotations;
    crop;
    drawing;
    if (loaded) paint();
  });
  function paint() {
    if (!image || !canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const all = [...annotations, ...(drawing ? [drawing] : [])];
    for (const a of all.filter((a) => a.tool !== 'redact')) drawAnnotation(ctx, a);
    for (const a of all.filter((a) => a.tool === 'redact')) drawAnnotation(ctx, a);
    if (crop) {
      ctx.save();
      ctx.strokeStyle = '#783D49';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
      ctx.restore();
    }
  }
  function checkpoint() {
    undo = [
      ...undo,
      {
        annotations: JSON.parse(JSON.stringify(annotations)),
        crop: crop ? { ...crop } : undefined,
      },
    ];
    redo = [];
  }
  function history(direction: 'undo' | 'redo') {
    const source = direction === 'undo' ? undo : redo;
    const item = source.at(-1);
    if (!item) return;
    const current = {
      annotations: JSON.parse(JSON.stringify(annotations)),
      crop: crop ? { ...crop } : undefined,
    };
    if (direction === 'undo') {
      undo = undo.slice(0, -1);
      redo = [...redo, current];
    } else {
      redo = redo.slice(0, -1);
      undo = [...undo, current];
    }
    annotations = item.annotations;
    crop = item.crop;
  }
  function annotation(px: number, py: number, w: number, h: number): Annotation {
    return {
      id: newId(),
      tool: tool === 'crop' ? 'rectangle' : tool,
      x: px,
      y: py,
      width: w,
      height: h,
      color,
      stroke: tool === 'text' ? 24 : Math.max(3, (image?.naturalWidth ?? 1000) / 500),
      text:
        tool === 'number'
          ? String(annotations.filter((a) => a.tool === 'number').length + 1)
          : text,
    };
  }
  function coordinates(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, ((e.clientX - rect.left) * canvas.width) / rect.width)),
      y: Math.max(
        0,
        Math.min(canvas.height, ((e.clientY - rect.top) * canvas.height) / rect.height),
      ),
    };
  }
  function start(e: PointerEvent) {
    if (e.button !== 0 || !loaded) return;
    const p = coordinates(e);
    canvas.setPointerCapture(e.pointerId);
    drawing = annotation(p.x, p.y, 0, 0);
  }
  function move(e: PointerEvent) {
    if (!drawing) return;
    const p = coordinates(e);
    drawing = { ...drawing, width: p.x - drawing.x, height: p.y - drawing.y };
  }
  function end() {
    if (!drawing) return;
    const a = drawing;
    drawing = null;
    if (!['text', 'number'].includes(tool) && Math.abs(a.width) < 2 && Math.abs(a.height) < 2)
      return;
    checkpoint();
    if (tool === 'crop')
      crop = {
        x: Math.min(a.x, a.x + a.width),
        y: Math.min(a.y, a.y + a.height),
        width: Math.abs(a.width),
        height: Math.abs(a.height),
      };
    else annotations = [...annotations, a];
  }
  function addByCoordinates() {
    checkpoint();
    if (tool === 'crop') crop = { x, y, width, height };
    else annotations = [...annotations, annotation(x, y, width, height)];
  }
  async function save() {
    if (!loaded) return;
    saving = true;
    try {
      const flat = await flattenImage(
        bytes,
        evidence.data.mimeType,
        $state.snapshot(annotations),
        crop ? $state.snapshot(crop) : undefined,
      );
      const asset = await workspace.repo.importAsset(
        evidence.projectId,
        'annotated.png',
        'image/png',
        flat.bytes,
      );
      const current = workspace.records.find((r) => r.id === evidence.id);
      if (current?.kind !== 'evidence') throw new Error(t('This evidence is no longer available.'));
      workspace.edit({
        ...current,
        data: {
          ...current.data,
          annotations: $state.snapshot(annotations),
          crop: crop ? $state.snapshot(crop) : undefined,
          sanitizedAssetId: asset.id,
        },
      });
      await workspace.flush();
      onclose();
      workspace.notify(t('Annotations saved. Sharing uses the flattened image.'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="annotation-editor">
  <div class="annotation-tools" aria-label={t('Annotation tools')}>
    {#each tools as item}<button
        class="button small"
        class:active={tool === item}
        aria-pressed={tool === item}
        onclick={() => (tool = item)}>{codeLabel(item)}</button
      >{/each}<span class="spacer"></span><button
      class="icon-button"
      disabled={!undo.length}
      aria-label={t('Undo annotation')}
      onclick={() => history('undo')}><Icon name="undo" size={16} /></button
    ><button
      class="icon-button"
      disabled={!redo.length}
      aria-label={t('Redo annotation')}
      onclick={() => history('redo')}><Icon name="redo" size={16} /></button
    >
  </div>
  <div class="annotation-options">
    <label>{t('Color')} <input type="color" bind:value={color} /></label>{#if tool === 'text'}<label
        >{t('Text')} <input bind:value={text} placeholder={t('Annotation text')} /></label
      >{/if}<label
      >{t('Zoom')}
      <select bind:value={zoom}
        ><option value={0.5}>50%</option><option value={1}>{t('Fit')}</option><option value={1.5}
          >150%</option
        ><option value={2}>200%</option></select
      ></label
    >{#if crop}<button
        class="button ghost small"
        onclick={() => {
          checkpoint();
          crop = undefined;
        }}>{t('Clear crop')}</button
      >{/if}
  </div>
  {#if tool === 'redact'}<p class="notice">
      {t(
        'Redaction replaces pixels with solid black. Only the flattened image is shared; the original remains in your private local backup.',
      )}
    </p>{/if}
  <div class="canvas-viewport">
    <canvas
      bind:this={canvas}
      style:width="{zoom * 100}%"
      onpointerdown={start}
      onpointermove={move}
      onpointerup={end}
      onpointercancel={() => (drawing = null)}
      aria-label={t(
        'Evidence annotation canvas. Use the coordinate controls below as a keyboard alternative.',
      )}
    ></canvas>
  </div>
  <details>
    <summary>{t('Precise placement & keyboard controls')}</summary>
    <div class="coordinate-fields">
      {#each ['x', 'y', 'width', 'height'] as field}<label
          >{codeLabel(field)}<input
            type="number"
            min="0"
            value={field === 'x' ? x : field === 'y' ? y : field === 'width' ? width : height}
            oninput={(e) => {
              const value = Math.max(0, Number(e.currentTarget.value));
              if (field === 'x') x = value;
              else if (field === 'y') y = value;
              else if (field === 'width') width = value;
              else height = value;
            }}
          /></label
        >{/each}<button class="button" disabled={!loaded} onclick={addByCoordinates}
        >{t('Add')} · {codeLabel(tool)}</button
      >
    </div>
  </details>
  <div class="modal-actions">
    <span class="muted small"
      >{annotations.length} {t('annotations')}{crop ? ' · ' + t('Cropped') : ''}</span
    ><span class="spacer"></span><button class="button" disabled={saving} onclick={onclose}
      >{t('Cancel')}</button
    ><button class="button primary" disabled={!loaded || saving} onclick={save}
      >{saving ? t('Saving…') : t('Apply changes')}</button
    >
  </div>
</div>

<style>
  .annotation-tools {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .annotation-tools .active {
    border-color: var(--accent);
    background: var(--selected);
  }
  .annotation-options {
    display: flex;
    gap: 20px;
    align-items: center;
    margin: 12px 0;
    font-size: 11px;
  }
  .annotation-options label {
    display: flex;
    gap: 7px;
    align-items: center;
  }
  .annotation-options input[type='color'] {
    width: 34px;
    padding: 3px;
    height: 30px;
  }
  .canvas-viewport {
    margin: 16px 0;
    max-height: 52vh;
    overflow: auto;
    background: var(--recessed);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  canvas {
    display: block;
    max-width: none;
    touch-action: none;
    cursor: crosshair;
  }
  details {
    font-size: 12px;
    color: var(--muted);
  }
  summary {
    cursor: pointer;
  }
  .coordinate-fields {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: end;
    margin-top: 12px;
  }
  .coordinate-fields label {
    display: grid;
    gap: 4px;
  }
  .coordinate-fields input {
    width: 85px;
  }
  .modal-actions {
    margin-top: 16px;
  }
</style>
