<script lang="ts">
  import { t } from '../i18n/i18n.svelte';
  import type { Environment } from '../domain/types';
  let { value, onchange }: { value: Environment; onchange: (value: Environment) => void } =
    $props();
  const id = $props.id();
  const fields = ['build', 'platform', 'browser', 'device', 'locale'] as const;
</script>

<div class="form-stack">
  {#each fields as field}<div class="field">
      <label for={id + '-' + field}>{t(field.charAt(0).toUpperCase() + field.slice(1))}</label
      ><input
        id={id + '-' + field}
        value={value[field]}
        placeholder={field === 'build'
          ? t('e.g. 2.8.0')
          : field === 'platform'
            ? t('e.g. macOS')
            : field === 'browser'
              ? t('e.g. Safari')
              : field === 'device'
                ? t('e.g. MacBook Pro')
                : t('e.g. en-US')}
        oninput={(e) => onchange({ ...value, [field]: e.currentTarget.value })}
      />
    </div>{/each}
</div>
