<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../i18n/i18n.svelte';

  import { Dialog } from 'bits-ui';
  import Icon from './Icon.svelte';
  import type { Snippet } from 'svelte';
  let {
    open = $bindable(false),
    title,
    description = '',
    children,
    wide = false,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    children: Snippet;
    wide?: boolean;
  } = $props();
  let content = $state<HTMLDivElement | null>(null);
  function focusContent(event: Event) {
    const input = content?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]',
    );
    if (input) {
      event.preventDefault();
      input.focus({ preventScroll: true });
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal
    ><Dialog.Overlay class="modal-scrim" /><Dialog.Content
      bind:ref={content}
      onOpenAutoFocus={focusContent}
      class="modal {wide ? 'wide' : ''}"
    >
      <div class="modal-heading">
        <div>
          <Dialog.Title class="modal-title">{title}</Dialog.Title
          >{#if description}<Dialog.Description class="muted">{description}</Dialog.Description
            >{/if}
        </div>
        <Dialog.Close class="icon-button" aria-label={t('Close')}
          ><Icon name="close" /></Dialog.Close
        >
      </div>
      {@render children()}
    </Dialog.Content></Dialog.Portal
  >
</Dialog.Root>
