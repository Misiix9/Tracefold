<script lang="ts">
  import { t } from '../../lib/i18n/i18n.svelte';
  import type { TemplateField } from '../../lib/domain/types';
  let {
    fields,
    values,
    onchange,
  }: {
    fields: TemplateField[];
    values: Record<string, unknown>;
    onchange: (values: Record<string, unknown>) => void;
  } = $props();
  const prefix = $props.id();
  function update(key: string, value: unknown) {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onchange(next);
  }
</script>

<div class="form-stack">
  {#each fields as field}
    {@const id = prefix + '-' + field.id}
    {#if field.type === 'checkbox'}<label class="check-row"
        ><input
          type="checkbox"
          checked={values[field.id] === true}
          onchange={(e) => update(field.id, e.currentTarget.checked)}
        />{field.label}</label
      >
    {:else}<div class="field">
        <label for={id}>{field.label}{field.required ? ' *' : ''}</label>
        {#if field.type === 'select' || field.type === 'multiselect'}
          <select
            {id}
            multiple={field.type === 'multiselect'}
            value={values[field.id] ?? (field.type === 'multiselect' ? [] : '')}
            onchange={(e) =>
              update(
                field.id,
                field.type === 'multiselect'
                  ? Array.from(e.currentTarget.selectedOptions).map((option) => option.value)
                  : e.currentTarget.value || undefined,
              )}
          >
            {#if field.type === 'select'}<option value="">{t('Choose…')}</option
              >{/if}{#each field.options ?? [] as option}<option value={option}>{option}</option
              >{/each}
          </select>
        {:else if field.type === 'multiline'}<textarea
            {id}
            value={String(values[field.id] ?? '')}
            oninput={(e) => update(field.id, e.currentTarget.value)}></textarea>
        {:else}<input
            {id}
            type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
            step={field.type === 'number' ? 'any' : undefined}
            value={String(values[field.id] ?? '')}
            oninput={(e) => {
              const input = e.currentTarget;
              if (input.validity.valid)
                update(
                  field.id,
                  input.value === ''
                    ? undefined
                    : field.type === 'number'
                      ? Number(input.value)
                      : input.value,
                );
            }}
          />{/if}
      </div>{/if}
  {/each}
</div>
