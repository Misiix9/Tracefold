<script lang="ts">
  let {
    label,
    value = '',
    onchange,
    multiline = false,
    placeholder = '',
    hint = '',
    type = 'text',
    disabled = false,
  }: {
    label: string;
    value?: string;
    onchange: (value: string) => void;
    multiline?: boolean;
    placeholder?: string;
    hint?: string;
    type?: string;
    disabled?: boolean;
  } = $props();
  const id = $props.id();
</script>

<div class="field">
  <label for={id}>{label}</label>{#if multiline}<textarea
      {id}
      {value}
      {placeholder}
      {disabled}
      oninput={(e) => onchange(e.currentTarget.value)}></textarea>{:else}<input
      {id}
      {type}
      {value}
      {placeholder}
      {disabled}
      oninput={(e) => onchange(e.currentTarget.value)}
    />{/if}{#if hint}<small>{hint}</small>{/if}
</div>
