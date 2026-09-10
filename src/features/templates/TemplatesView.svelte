<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { DataMap, Entity, TemplateData, TemplateField } from '../../lib/domain/types';
  import {
    getBuiltInTemplates,
    templateBody,
    validateTemplateValues,
  } from '../../lib/domain/templates';
  import { defaultData, newId, textDoc } from '../../lib/domain/defaults';
  import Icon from '../../lib/ui/Icon.svelte';
  import Modal from '../../lib/ui/Modal.svelte';
  import TextField from '../../lib/ui/TextField.svelte';
  let { workspace }: { workspace: Workspace } = $props();
  let query = $state(''),
    filter = $state('all'),
    useOpen = $state(false),
    chosen = $state<Entity<'template'> | null>(null),
    title = $state(''),
    values = $state<Record<string, unknown>>({}),
    fieldErrors = $state(''),
    busy = $state(false);
  const builtin = $derived(
    getBuiltInTemplates(workspace.projectId, undefined, workspace.settings.language),
  );
  const custom = $derived(
    workspace.visible.filter((r): r is Entity<'template'> => r.kind === 'template'),
  );
  const selected = $derived(workspace.selected?.kind === 'template' ? workspace.selected : null);
  const items = $derived(
    [...custom, ...builtin].filter(
      (t) =>
        (filter === 'all' || t.data.targetKind === filter) &&
        [t.title, t.data.description].join(' ').toLowerCase().includes(query.toLowerCase()),
    ),
  );
  function update(data: Partial<TemplateData>) {
    if (selected) workspace.edit({ ...selected, data: { ...selected.data, ...data } });
  }
  function field(id: string, patch: Partial<TemplateField>) {
    if (selected)
      update({ fields: selected.data.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  }
  async function duplicate(t: Entity<'template'>) {
    try {
      const item = await workspace.create('template', `${t.title} · custom`, {
        ...JSON.parse(JSON.stringify(t.data)),
        builtIn: false,
      });
      workspace.navigate('templates', item.id);
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function newTemplate() {
    try {
      const item = await workspace.create('template', t('Untitled template'));
      workspace.navigate('templates', item.id);
    } catch (e) {
      workspace.fail(e);
    }
  }
  function choose(t: Entity<'template'>) {
    chosen = t;
    title = t.title;
    values = {};
    fieldErrors = '';
    useOpen = true;
  }
  async function use() {
    if (!chosen) return;
    const result = validateTemplateValues($state.snapshot(chosen.data), $state.snapshot(values));
    if (!result.ok) {
      fieldErrors = result.issues.map((i) => i.message).join(' ');
      return;
    }
    busy = true;
    try {
      const kind = chosen.data.targetKind;
      const data = {
        ...defaultData(kind),
        ...JSON.parse(JSON.stringify(chosen.data.defaults)),
      } as DataMap[typeof kind];
      if (kind === 'session') {
        const session = data as DataMap['session'];
        session.startedAt = new Date().toISOString();
        if (typeof values.charter === 'string') session.charter = values.charter;
      }
      if (kind === 'finding') {
        const finding = data as DataMap['finding'];
        const highest = Math.max(
          0,
          ...workspace.records
            .filter((r) => r.kind === 'finding')
            .map((r) =>
              r.kind === 'finding' ? Number(r.data.code.match(/-(\d+)$/)?.[1] ?? 0) : 0,
            ),
        );
        finding.code = `${workspace.project?.prefix ?? 'TF'}-${String(highest + 1).padStart(3, '0')}`;
        for (const key of ['component', 'frequency', 'owner', 'severity', 'priority'] as const)
          if (typeof values[key] === 'string' && values[key])
            (finding as unknown as Record<string, unknown>)[key] = values[key];
      }
      if (kind === 'document') {
        (data as DataMap['document']).fields = result.value;
        (data as DataMap['document']).templateId = chosen.id;
        (data as DataMap['document']).templateFields = $state.snapshot(chosen.data.fields);
      }
      const item = await workspace.create(kind, title.trim() || chosen.title, data);
      const body = templateBody(chosen.data);
      const details = chosen.data.fields
        .filter((f) => result.value[f.id] !== undefined && result.value[f.id] !== '')
        .map(
          (f) =>
            `${f.label}: ${Array.isArray(result.value[f.id]) ? (result.value[f.id] as string[]).join(', ') : String(result.value[f.id])}`,
        );
      if (details.length && kind !== 'document')
        body.content = [...(textDoc(details.join('\n')).content ?? []), ...(body.content ?? [])];
      workspace.edit({ ...item, body } as Entity<'document'>);
      await workspace.flush();
      useOpen = false;
      workspace.navigate(
        { document: 'notebook', session: 'notebook', finding: 'findings', case: 'cases' }[kind],
        item.id,
      );
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if selected}<section class="page">
    <button class="detail-back" onclick={() => workspace.navigate('templates')}
      ><Icon name="back" size={14} />{t('All templates')}</button
    >
    <div class="page-heading">
      <div>
        <div class="eyebrow">{t('Custom template')}</div>
        <input
          class="title-input"
          style="margin-top:8px"
          aria-label={t('Template title')}
          value={selected.title}
          oninput={(e) => workspace.edit({ ...selected, title: e.currentTarget.value })}
        />
      </div>
      <button class="button primary" onclick={() => choose(selected)}>{t('Use template')}</button>
    </div>
    <div class="form-grid">
      <TextField
        label={t('Description')}
        multiline
        value={selected.data.description}
        onchange={(description) => update({ description })}
      />
      <div class="field">
        <label for="template-kind">{t('Creates')}</label><select
          id="template-kind"
          value={selected.data.targetKind}
          onchange={(e) =>
            update({
              targetKind: e.currentTarget.value as TemplateData['targetKind'],
              defaults: {},
            })}
          ><option value="document">{t('Document')}</option><option value="session"
            >{t('Session')}</option
          ><option value="finding">{t('Finding')}</option><option value="case"
            >{t('Test case')}</option
          ></select
        >
      </div>
    </div>
    <div class="section-rule">
      <h3>{t('Document sections')}</h3>
      {#each selected.data.sections as section}<div class="template-section">
          <TextField
            label={t('Section title')}
            value={section.title}
            onchange={(title) =>
              update({
                sections: selected.data.sections.map((s) =>
                  s.id === section.id ? { ...s, title } : s,
                ),
              })}
          /><TextField
            label={t('Writing guidance')}
            multiline
            value={section.guidance}
            onchange={(guidance) =>
              update({
                sections: selected.data.sections.map((s) =>
                  s.id === section.id ? { ...s, guidance } : s,
                ),
              })}
          /><button
            class="button ghost danger small"
            onclick={() =>
              update({ sections: selected.data.sections.filter((s) => s.id !== section.id) })}
            >{t('Remove section')}</button
          >
        </div>{/each}<button
        class="button"
        style="margin-top:12px"
        onclick={() =>
          update({
            sections: [
              ...selected.data.sections,
              { id: newId(), title: t('New section'), guidance: '' },
            ],
          })}><Icon name="plus" size={14} />{t('Add section')}</button
      >
    </div>
    <div class="section-rule">
      <h3>{t('Custom fields')}</h3>
      {#each selected.data.fields as f}<div class="template-section">
          <div class="form-grid">
            <TextField
              label={t('Field label')}
              value={f.label}
              onchange={(label) => field(f.id, { label })}
            /><label class="field"
              ><span class="field-label">{t('Field type')}</span><select
                value={f.type}
                onchange={(e) =>
                  field(f.id, { type: e.currentTarget.value as TemplateField['type'] })}
                >{#each ['text', 'multiline', 'number', 'date', 'checkbox', 'select', 'multiselect'] as type}<option
                    value={type}>{codeLabel(type)}</option
                  >{/each}</select
              ></label
            >
          </div>
          {#if f.type === 'select' || f.type === 'multiselect'}<TextField
              label={t('Options (one per line)')}
              multiline
              value={f.options?.join('\n') ?? ''}
              onchange={(v) => field(f.id, { options: v.split('\n').filter(Boolean) })}
            />{/if}
          <div class="button-row">
            <label class="check-row"
              ><input
                type="checkbox"
                checked={f.required}
                onchange={(e) => field(f.id, { required: e.currentTarget.checked })}
              />{t('Required')}</label
            ><span class="spacer"></span><button
              class="button ghost danger small"
              onclick={() =>
                update({ fields: selected.data.fields.filter((field) => field.id !== f.id) })}
              >{t('Remove field')}</button
            >
          </div>
        </div>{/each}<button
        class="button"
        style="margin-top:12px"
        onclick={() =>
          update({
            fields: [
              ...selected.data.fields,
              { id: newId(), label: t('New field'), type: 'text', required: false },
            ],
          })}><Icon name="plus" size={14} />{t('Add field')}</button
      >
    </div>
    <div class="section-rule">
      <button
        class="button ghost danger"
        onclick={() => workspace.remove(selected.id).catch((e) => workspace.fail(e))}
        ><Icon name="trash" size={14} />{t('Move to Trash')}</button
      >
    </div>
  </section>
{:else}<section class="page">
    <div class="page-heading">
      <div>
        <h1>{t('A thoughtful starting point')}</h1>
        <p>{t('Templates for the work you do. Adapt them to the way you test.')}</p>
      </div>
      <button class="button" onclick={newTemplate}
        ><Icon name="plus" size={15} />{t('Create template')}</button
      >
    </div>
    <div class="page-tools">
      <div class="filter-input">
        <Icon name="search" size={16} /><input
          aria-label={t('Find a template')}
          bind:value={query}
          placeholder={t('Search templates…')}
        />
      </div>
      <select aria-label={t('Template type')} bind:value={filter}
        ><option value="all">{t('Every workflow')}</option><option value="document"
          >{t('Documentation')}</option
        ><option value="session">{t('Exploration')}</option><option value="finding"
          >{t('Findings')}</option
        ><option value="case">{t('Test cases')}</option></select
      >
    </div>
    <div class="template-list">
      {#each items as item}<article>
          <div class="template-top">
            <span class="eyebrow">{codeLabel(item.data.targetKind)}</span
            >{#if !item.data.builtIn}<span class="tag">{t('Custom')}</span>{/if}
          </div>
          <h2>{item.title}</h2>
          <p>{item.data.description}</p>
          <div class="button-row">
            <button class="button small" onclick={() => choose(item)}
              >{t('Use template')}<Icon name="arrow" size={13} /></button
            ><button
              class="button ghost small"
              onclick={() =>
                item.data.builtIn ? duplicate(item) : workspace.navigate('templates', item.id)}
              >{item.data.builtIn ? t('Customize a copy') : t('Edit template')}</button
            >
          </div>
        </article>{/each}
    </div>
  </section>{/if}
<Modal
  bind:open={useOpen}
  title={chosen?.title ?? t('Use template')}
  description={t('A few details now will give your document a useful starting point.')}
  wide
  ><div class="form-stack">
    <TextField
      label={t('Title')}
      value={title}
      onchange={(v) => (title = v)}
    />{#each chosen?.data.fields ?? [] as f}<div class="field">
        {#if f.type === 'checkbox'}<label class="check-row"
            ><input
              type="checkbox"
              checked={values[f.id] === true}
              onchange={(e) => (values = { ...values, [f.id]: e.currentTarget.checked })}
            />{f.label}{f.required ? ' *' : ''}</label
          >{:else if f.type === 'select' || f.type === 'multiselect'}<label
            for={'template-value-' + f.id}>{f.label}{f.required ? ' *' : ''}</label
          ><select
            id={'template-value-' + f.id}
            multiple={f.type === 'multiselect'}
            value={(values[f.id] as string | string[]) ?? ''}
            onchange={(e) =>
              (values = {
                ...values,
                [f.id]:
                  f.type === 'multiselect'
                    ? Array.from(e.currentTarget.selectedOptions).map((o) => o.value)
                    : e.currentTarget.value,
              })}
            >{#if f.type === 'select'}<option value="">{t('Choose…')}</option
              >{/if}{#each f.options ?? [] as option}<option value={option}
                >{chosen?.data.builtIn ? codeLabel(option) : option}</option
              >{/each}</select
          >{:else}<TextField
            label={f.label + (f.required ? ' *' : '')}
            multiline={f.type === 'multiline'}
            type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
            value={String(values[f.id] ?? '')}
            onchange={(v) =>
              (values = { ...values, [f.id]: f.type === 'number' && v !== '' ? Number(v) : v })}
          />{/if}
      </div>{/each}{#if fieldErrors}<div class="notice warning" role="alert">
        {fieldErrors}
      </div>{/if}
  </div>
  <div class="modal-actions">
    <button class="button" onclick={() => (useOpen = false)}>{t('Cancel')}</button><button
      class="button primary"
      disabled={busy}
      onclick={use}>{t('Create from template')}</button
    >
  </div></Modal
>

<style>
  .template-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 40px;
  }
  .template-list article {
    border-top: 1px solid var(--line);
    padding: 24px 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .template-top {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 10px;
  }
  .template-list h2 {
    font-family: Newsreader, serif;
    font-size: 25px;
    font-weight: 500;
  }
  .template-list p {
    font-size: 12px;
    line-height: 1.75;
    color: var(--muted);
    margin: 10px 0 18px;
    max-width: 470px;
  }
  .template-list .button-row {
    margin-top: auto;
  }
  .template-section {
    border: 1px solid var(--line);
    border-radius: var(--panel-radius);
    padding: 20px;
    margin-top: 14px;
    display: grid;
    gap: 14px;
  }
  @media (max-width: 900px) {
    .template-list {
      grid-template-columns: 1fr;
    }
  }
</style>
