<script lang="ts">
  import { t } from '../../lib/i18n/i18n.svelte';
  import type { ReportAsset } from '../../lib/services/reports/types';
  let { asset, caption }: { asset: ReportAsset; caption: string } = $props();
  let source = $state('');
  const log = $derived(
    asset.mimeType === 'text/plain' ? new TextDecoder().decode(asset.bytes.slice(0, 65536)) : '',
  );
  $effect(() => {
    if (asset.mimeType !== 'image/png') return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(asset.bytes)], { type: 'image/png' }));
    source = url;
    return () => URL.revokeObjectURL(url);
  });
</script>

<figure>
  {#if asset.mimeType === 'image/png' && source}<img src={source} alt={caption} loading="lazy" />
  {:else if asset.mimeType === 'text/plain'}<textarea
      readonly
      aria-label={caption}
      value={log}
      rows="12"></textarea>{#if asset.bytes.length > 65536}<p class="small muted">
        {t('Preview shows the first 64 KiB. The export includes the full sanitized log.')}
      </p>{/if}{/if}
  <figcaption>{caption}</figcaption>
</figure>

<style>
  figure {
    margin: 20px 0;
    break-inside: avoid;
  }
  img {
    display: block;
    max-width: 100%;
    height: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  textarea {
    width: 100%;
    max-height: 320px;
    resize: vertical;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 16px;
    background: var(--recessed);
    border: 1px solid var(--border);
    font-family: 'iA Writer Mono', monospace;
    font-size: 12px;
  }
  figcaption {
    color: var(--muted);
    font-size: 12px;
    margin-top: 8px;
  }
</style>
