<script lang="ts">
  import Icon from './Icon.svelte';
  let {
    icon = 'note',
    title,
    description,
    action = '',
    onclick,
  }: {
    icon?: string;
    title: string;
    description: string;
    action?: string;
    onclick?: () => void;
  } = $props();
</script>

<div class="empty-state">
  <div class="empty-mark"><Icon name={icon} size={28} /></div>
  <h2>{title}</h2>
  <p>{description}</p>
  {#if action}<button class="button primary" {onclick}
      ><Icon name="plus" size={16} />{action}</button
    >{/if}
</div>
