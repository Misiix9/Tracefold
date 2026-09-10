<script lang="ts">
  import { untrack } from 'svelte';
  import RichEditor from '../../lib/ui/RichEditor.svelte';
  import type { RichDocument } from '../../lib/domain/types';
  let { initial, changed }: { initial: RichDocument; changed: (value: RichDocument) => void } =
    $props();
  let value = $state(untrack(() => initial));
  let open = $state(true);
</script>

<button onclick={() => (open = !open)}>Toggle editor</button>
<button
  onclick={() =>
    (value = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Restored revision' }] }],
    })}>Restore revision</button
>
{#if open}<RichEditor
    {value}
    onchange={(next) => {
      value = next;
      changed(next);
    }}
  />{:else}<p>Navigation completed</p>{/if}
