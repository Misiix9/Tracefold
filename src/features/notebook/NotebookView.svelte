<script lang="ts">
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import { findingFromEntry, caseFromEntry } from '../../lib/domain/promotion';
  import TextField from '../../lib/ui/TextField.svelte';
  import DocumentFields from '../templates/DocumentFields.svelte';
  import { onMount } from 'svelte';
  import {
    emptySessionDraft,
    formatSessionTime,
    sessionSeconds,
    transitionSession,
  } from '../../lib/domain/sessions';
  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type {
    AnyEntity,
    Entity,
    EntryData,
    RichDocument,
    SessionData,
    SessionDraft,
  } from '../../lib/domain/types';
  import { defaultData, emptyDoc, plainText, textDoc } from '../../lib/domain/defaults';
  import Icon from '../../lib/ui/Icon.svelte';
  import Modal from '../../lib/ui/Modal.svelte';
  import RichEditor from '../../lib/ui/RichEditor.svelte';
  import EmptyState from '../../lib/ui/EmptyState.svelte';
  import EnvironmentFields from '../../lib/ui/EnvironmentFields.svelte';
  let { workspace }: { workspace: Workspace } = $props();
  let filter = $state('');
  let kind = $state('all');
  let newOpen = $state(false);
  let newKind = $state<'document' | 'session'>('document');
  let newTitle = $state('');
  let creating = $state(false);
  let entrySaving = $state(false);
  let focusText = $state('');
  let editingEntryId = $state('');
  let entryOpen = $state(false);
  const editingEntry = $derived(
    workspace.visible.find(
      (r): r is Entity<'entry'> => r.kind === 'entry' && r.id === editingEntryId,
    ),
  );
  let clockNow = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (clockNow = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const selected = $derived(workspace.selected);
  const record = $derived(
    selected?.kind === 'document' || selected?.kind === 'session' ? selected : null,
  );
  const draft = $derived(
    record?.kind === 'session' ? (record.data.draft ?? emptySessionDraft()) : emptySessionDraft(),
  );
  const elapsed = $derived(record?.kind === 'session' ? sessionSeconds(record.data, clockNow) : 0);
  function updateDraft(change: Partial<SessionDraft>) {
    updateSession({ draft: { ...draft, ...change } });
  }
  function setSessionState(state: SessionData['state']) {
    if (record?.kind === 'session')
      workspace.edit({ ...record, data: transitionSession(record.data, state) });
  }
  const items = $derived(
    workspace.visible.filter(
      (r) =>
        (r.kind === 'document' || r.kind === 'session') &&
        (kind === 'all' || r.kind === kind) &&
        [r.title, plainText(r.body)].join(' ').toLowerCase().includes(filter.toLowerCase()),
    ),
  );
  const entries = $derived(
    workspace.visible
      .filter((r): r is Entity<'entry'> => r.kind === 'entry' && r.data.sessionId === record?.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
  function editTitle(title: string) {
    if (record) workspace.edit({ ...record, title });
  }
  async function create() {
    creating = true;
    try {
      const item = await workspace.create(
        newKind,
        newTitle.trim() || (newKind === 'session' ? t('Untitled session') : t('Untitled document')),
      );
      newOpen = false;
      newTitle = '';
      workspace.navigate('notebook', item.id);
    } catch (e) {
      workspace.fail(e);
    } finally {
      creating = false;
    }
  }
  function updateSession(data: Partial<SessionData>) {
    if (record?.kind === 'session')
      workspace.edit({ ...record, data: { ...record.data, ...data } });
  }
  async function addEntry() {
    if (!record || record.kind !== 'session' || !plainText(draft.body).trim()) return;
    entrySaving = true;
    const sessionId = record.id;
    const submitted = JSON.parse(JSON.stringify(draft)) as SessionDraft;
    try {
      const content = plainText(submitted.body);
      await workspace.create(
        'entry',
        content.split('\n')[0].slice(0, 140),
        {
          ...defaultData('entry'),
          sessionId,
          category: submitted.category,
          expected: submitted.expected,
          actual: submitted.actual,
        },
        submitted.body,
      );
      const latest = workspace.records.find((r) => r.id === sessionId);
      if (
        latest?.kind === 'session' &&
        JSON.stringify(latest.data.draft ?? emptySessionDraft()) === JSON.stringify(submitted)
      )
        workspace.edit({ ...latest, data: { ...latest.data, draft: undefined } });
      await workspace.flush();
      workspace.notify(t('Entry saved'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      entrySaving = false;
    }
  }
  async function promote(entry: Entity<'entry'>) {
    try {
      if (entry.data.findingId) {
        workspace.navigate('findings', entry.data.findingId);
        return;
      }
      const existing = workspace.visible.find(
        (r) => r.kind === 'finding' && r.data.sourceEntryId === entry.id,
      );
      const code = `${workspace.project?.prefix ?? 'TF'}-${String(Math.max(0, ...workspace.records.filter((r) => r.kind === 'finding').map((r) => (r.kind === 'finding' ? Number(r.data.code.match(/-(\d+)$/)?.[1] ?? 0) : 0))) + 1).padStart(3, '0')}`;
      const finding =
        existing ??
        (await workspace.create(
          'finding',
          entry.title,
          findingFromEntry(
            $state.snapshot(entry),
            record?.kind === 'session'
              ? $state.snapshot(record.data.environment)
              : defaultData('finding').environment,
            code,
          ),
          $state.snapshot(entry.body),
        ));
      workspace.edit({ ...entry, data: { ...entry.data, findingId: finding.id } });
      await workspace.flush();
      workspace.notify(t('Finding created. Your session entry is preserved.'));
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function makeCase(entry: Entity<'entry'>) {
    try {
      const existing = workspace.visible.find(
        (r) =>
          r.kind === 'case' && (r.id === entry.data.caseId || r.data.sourceEntryId === entry.id),
      );
      const c =
        existing ??
        (await workspace.create(
          'case',
          entry.title,
          caseFromEntry($state.snapshot(entry)),
          $state.snapshot(entry.body),
        ));
      workspace.edit({ ...entry, data: { ...entry.data, caseId: c.id } });
      await workspace.flush();
      workspace.navigate('cases', c.id);
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function attach(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (!input.files?.length || !record) return;
    try {
      const { importEvidence } = await import('../evidence/evidence');
      const added = await importEvidence(workspace, Array.from(input.files));
      if (record.kind === 'document')
        workspace.edit({
          ...record,
          data: {
            ...record.data,
            evidenceIds: [...record.data.evidenceIds, ...added.map((x) => x.id)],
          },
        });
      else {
        const entry = await workspace.create(
          'entry',
          added.length === 1
            ? added[0].title
            : t('{count} evidence files', { count: added.length }),
          { ...defaultData('entry'), sessionId: record.id, evidenceIds: added.map((x) => x.id) },
        );
        workspace.edit({ ...entry, body: textDoc(t('Evidence captured during this session.')) });
      }
      workspace.notify(t('Evidence attached'));
    } catch (e) {
      workspace.fail(e);
    }
    input.value = '';
  }
</script>

{#if !record}
  <section class="page">
    <div class="page-heading">
      <div>
        <h1>{t('Notebook')}</h1>
        <p>{t('A clear record of what you tried, learned, and discovered.')}</p>
      </div>
      <button
        class="button primary"
        onclick={() => {
          newKind = 'document';
          newOpen = true;
        }}><Icon name="plus" size={16} />{t('New document')}</button
      >
    </div>
    <div class="page-tools">
      <div class="filter-input">
        <Icon name="search" size={16} /><input
          aria-label={t('Search notebook')}
          placeholder={t('Find a document or session…')}
          bind:value={filter}
        />
      </div>
      <div class="segmented">
        <button class:active={kind === 'all'} onclick={() => (kind = 'all')}>{t('All')}</button
        ><button class:active={kind === 'document'} onclick={() => (kind = 'document')}
          >{t('Documents')}</button
        ><button class:active={kind === 'session'} onclick={() => (kind = 'session')}
          >{t('Sessions')}</button
        >
      </div>
      <span class="spacer"></span><button
        class="button"
        onclick={() => {
          newKind = 'session';
          newOpen = true;
        }}><Icon name="play" size={15} />{t('Start a session')}</button
      >
    </div>
    {#if !items.length}<EmptyState
        title={filter ? t('Nothing matches your search') : t('Every discovery starts with a note')}
        description={filter
          ? t('Try a different title or phrase.')
          : t(
              'Write a walkthrough, keep an exploratory journal, or capture a thought. Add structure when you need it.',
            )}
        action={filter ? '' : t('Write your first document')}
        onclick={() => {
          newKind = 'document';
          newOpen = true;
        }}
      />{:else}<div class="notebook-list">
        {#each items as item}<button
            class="list-row"
            onclick={() => workspace.navigate('notebook', item.id)}
            ><span class="list-icon"
              ><Icon name={item.kind === 'session' ? 'clock' : 'file'} size={21} /></span
            >
            <div>
              <div class="list-title">{item.title || t('Untitled')}</div>
              <div class="row-subtitle">
                {item.kind === 'session'
                  ? t('Exploratory session')
                  : plainText(item.body).slice(0, 100) ||
                    t('Document')}{#if item.kind === 'session'}
                  · {codeLabel(item.data.state)}{/if}
              </div>
            </div>
            <div class="row-meta">
              {new Date(item.updatedAt).toLocaleDateString(intlLocale(), {
                month: 'short',
                day: 'numeric',
              })}
            </div>
            <Icon name="arrow" size={16} /></button
          >{/each}
      </div>{/if}
  </section>
{:else}
  <div class="detail-layout">
    <article class="detail-main">
      <button class="detail-back" onclick={() => workspace.navigate('notebook')}
        ><Icon name="back" size={14} />{t('All notes')}</button
      >
      <div class="eyebrow">
        {record.kind === 'session' ? t('Exploratory session') : t('Document')}
      </div>
      <input
        class="title-input"
        style="margin-top:9px"
        aria-label={t('Title')}
        value={record.title}
        oninput={(e) => editTitle(e.currentTarget.value)}
      />
      {#if record.kind === 'session'}
        <div class="detail-summary">
          {record.data.charter ||
            t('Capture the path you took, the checks you made, and what you discovered.')}
        </div>
        <div class="detail-meta">
          <span
            class="status"
            style:color={record.data.state === 'completed' ? 'var(--success)' : 'var(--accent)'}
            ><span class="status-dot"></span>{record.data.state === 'active'
              ? t('Session in progress')
              : record.data.state === 'paused'
                ? t('Session paused')
                : t('Session completed')}</span
          ><span class="mono" aria-label={t('Active testing time')}
            >{formatSessionTime(elapsed)}</span
          ><span>{t('Build')} {record.data.environment.build || t('not set')}</span><span
            >{[record.data.environment.browser, record.data.environment.platform]
              .filter(Boolean)
              .join(' · ') || t('Environment not set')}</span
          ><span class="spacer"></span>{#if record.data.state !== 'completed'}<button
              class="button ghost small"
              onclick={() => setSessionState(record.data.state === 'active' ? 'paused' : 'active')}
              ><Icon name={record.data.state === 'active' ? 'pause' : 'play'} size={13} />{record
                .data.state === 'active'
                ? t('Pause')
                : t('Resume')}</button
            >{/if}
        </div>
        <div class="timeline">
          {#each entries as entry, i}<section class="timeline-entry">
              <div class="entry-marker">{i + 1}</div>
              <time
                >{new Date(entry.createdAt).toLocaleTimeString(intlLocale(), {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}</time
              >
              <div class="entry-content">
                <div class="entry-top">
                  <span class="status {entry.data.category}"
                    ><Icon
                      name={entry.data.category === 'passed'
                        ? 'check'
                        : entry.data.category === 'issue'
                          ? 'finding'
                          : entry.data.category === 'question'
                            ? 'question'
                            : entry.data.category === 'idea'
                              ? 'idea'
                              : 'note'}
                      size={15}
                    />{entry.data.category === 'passed'
                      ? t('Passed check')
                      : codeLabel(entry.data.category)}</span
                  >{#if entry.data.private}<span class="tag"
                      ><Icon name="lock" size={10} />{t('Private')}</span
                    >{/if}<span class="spacer"></span><button
                    class="button ghost small"
                    onclick={() => {
                      editingEntryId = entry.id;
                      entryOpen = true;
                    }}>{t('Edit entry')}</button
                  ><button
                    class="icon-button"
                    aria-label={t('Delete entry')}
                    title={t('Move to Trash')}
                    onclick={() => workspace.remove(entry.id).catch((e) => workspace.fail(e))}
                    ><Icon name="trash" size={14} /></button
                  >
                </div>
                <h3>{entry.title}</h3>
                {#if plainText(entry.body).trim() && plainText(entry.body) !== entry.title}<div
                    class="entry-description"
                  >
                    <RichEditor value={entry.body} readonly />
                  </div>{/if}
                {#if entry.data.expected || entry.data.actual}<div
                    class="comparison"
                    style="margin-top:12px"
                  >
                    <div>
                      <span class="field-label">{t('Expected')}</span>
                      <p>{entry.data.expected || t('Not recorded')}</p>
                    </div>
                    <div class="actual">
                      <span class="field-label">{t('Actual')}</span>
                      <p>{entry.data.actual || t('Not recorded')}</p>
                    </div>
                  </div>{/if}
                {#if entry.data.evidenceIds.length}<div class="button-row" style="margin-top:10px">
                    {#each entry.data.evidenceIds as id}<button
                        class="button small"
                        onclick={() => workspace.navigate('evidence', id)}
                        ><Icon name="attach" size={13} />{workspace.visible.find((r) => r.id === id)
                          ?.title ?? t('Evidence')}</button
                      >{/each}
                  </div>{/if}
                <div class="entry-actions">
                  <button onclick={() => promote(entry)}
                    ><Icon name={entry.data.findingId ? 'link' : 'finding'} size={13} />{entry.data
                      .findingId
                      ? t('View linked finding')
                      : t('Create finding')}</button
                  ><button onclick={() => makeCase(entry)}
                    ><Icon name="case" size={13} />{entry.data.caseId
                      ? t('View linked test case')
                      : t('Save as test case')}</button
                  ><button
                    onclick={() =>
                      workspace.edit({
                        ...entry,
                        data: { ...entry.data, private: !entry.data.private },
                      })}>{entry.data.private ? t('Make shareable') : t('Keep private')}</button
                  >
                </div>
              </div>
            </section>{/each}
        </div>
        {#if record.data.state !== 'completed'}<div class="entry-composer">
            <div class="composer-kind">
              <select
                aria-label={t('Entry type')}
                value={draft.category}
                onchange={(e) =>
                  updateDraft({ category: e.currentTarget.value as EntryData['category'] })}
                ><option value="observation">{t('Observation')}</option><option value="passed"
                  >{t('Passed check')}</option
                ><option value="issue">{t('Issue')}</option><option value="question"
                  >{t('Question')}</option
                ><option value="idea">{t('Idea')}</option></select
              ><span class="muted small">{t('Draft saved locally')}</span>
            </div>
            <RichEditor
              value={draft.body}
              onchange={(body) => updateDraft({ body })}
              placeholder={t('What did you try? What happened?')}
              compact
            />{#if draft.category === 'issue'}<div class="form-grid">
                <div class="field">
                  <label for="entry-expected">{t('Expected')}</label><textarea
                    id="entry-expected"
                    value={draft.expected}
                    oninput={(e) => updateDraft({ expected: e.currentTarget.value })}
                    placeholder={t('How should it work?')}></textarea>
                </div>
                <div class="field">
                  <label for="entry-actual">{t('Actual')}</label><textarea
                    id="entry-actual"
                    value={draft.actual}
                    oninput={(e) => updateDraft({ actual: e.currentTarget.value })}
                    placeholder={t('What happened instead?')}></textarea>
                </div>
              </div>{/if}
            <div class="composer-footer">
              <label class="button ghost small"
                ><Icon name="attach" size={15} />{t('Attach')}<input
                  class="sr-only"
                  type="file"
                  multiple
                  onchange={attach}
                /></label
              ><span class="spacer"></span><button
                class="button primary"
                disabled={entrySaving || !plainText(draft.body).trim()}
                onclick={addEntry}>{entrySaving ? t('Saving…') : t('Add entry')}</button
              >
            </div>
          </div>{:else}<div class="notice">
            <strong>{t('Session completed')}</strong>
            <p>{record.data.conclusion || t('No conclusion recorded.')}</p>
            <button class="button ghost small" onclick={() => setSessionState('active')}
              >{t('Reopen session')}</button
            >
          </div>{/if}
      {:else}
        <div class="detail-meta">
          <span><Icon name="file" size={13} /> {t('Working document')}</span><span
            >{t('Updated')} {new Date(record.updatedAt).toLocaleDateString(intlLocale())}</span
          ><span class="spacer"></span><span class="save-indicator"
            >{workspace.saveStatus === 'saved'
              ? t('Saved locally')
              : workspace.saveStatus === 'saving'
                ? t('Saving…')
                : t('Couldn’t save')}</span
          >
        </div>
        <RichEditor value={record.body} onchange={(body) => workspace.edit({ ...record, body })} />
        {#if record.data.evidenceIds.length}<div class="section-rule">
            <h3>{t('Attached evidence')}</h3>
            <div class="button-row" style="margin-top:12px">
              {#each record.data.evidenceIds as id}<button
                  class="button"
                  onclick={() => workspace.navigate('evidence', id)}
                  ><Icon name="attach" size={15} />{workspace.visible.find((r) => r.id === id)
                    ?.title ?? t('Evidence')}</button
                >{/each}
            </div>
          </div>{/if}
      {/if}
    </article>
    <aside class="context-panel">
      <div class="context-heading">
        <h2>{record.kind === 'session' ? t('Session context') : t('Document details')}</h2>
        <Icon name="more" size={19} />
      </div>
      {#if record.kind === 'document' && record.data.templateFields?.length}<section>
          <h3 class="subheading">{t('Custom fields')}</h3>
          <DocumentFields
            fields={record.data.templateFields}
            values={record.data.fields ?? {}}
            onchange={(fields) => workspace.edit({ ...record, data: { ...record.data, fields } })}
          />
        </section>{/if}
      {#if record.kind === 'session'}<section>
          <div class="field">
            <label for="session-timebox">{t('Timebox · minutes')}</label><input
              id="session-timebox"
              type="number"
              min="1"
              max="1440"
              placeholder={t('Optional')}
              value={record.data.timeboxMinutes ?? ''}
              onchange={(e) =>
                updateSession({
                  timeboxMinutes: e.currentTarget.value
                    ? Math.min(1440, Math.max(1, Number(e.currentTarget.value)))
                    : undefined,
                })}
            /><small>{t('Active time pauses when you close the app or switch projects.')}</small>
          </div>
          {#if record.data.timeboxMinutes}<p
              class:danger={elapsed >= record.data.timeboxMinutes * 60}
              class="muted small"
            >
              {elapsed >= record.data.timeboxMinutes * 60
                ? t('Timebox reached — wrap up or continue deliberately.')
                : t('{count} minutes left in this timebox.', {
                    count: Math.ceil((record.data.timeboxMinutes * 60 - elapsed) / 60),
                  })}
            </p>{/if}
        </section>
        <section>
          <div class="field">
            <label for="charter">{t('Charter')}</label><textarea
              id="charter"
              value={record.data.charter}
              placeholder={t('What are you exploring, and why?')}
              oninput={(e) => updateSession({ charter: e.currentTarget.value })}></textarea>
          </div>
        </section>
        <section>
          <h3>{t('Environment')}</h3>
          <EnvironmentFields
            value={record.data.environment}
            onchange={(environment) => updateSession({ environment })}
          />
        </section>
        <section>
          <h3>{t('Focus areas')}</h3>
          <div class="form-stack">
            {#each record.data.focusAreas as area, i}<label class="check-row"
                ><input
                  type="checkbox"
                  checked={area.checked}
                  onchange={(e) =>
                    updateSession({
                      focusAreas: record.data.focusAreas.map((a, j) =>
                        j === i ? { ...a, checked: e.currentTarget.checked } : a,
                      ),
                    })}
                />{area.text}</label
              >{/each}
            <form
              class="button-row"
              onsubmit={(e) => {
                e.preventDefault();
                if (focusText.trim()) {
                  updateSession({
                    focusAreas: [
                      ...record.data.focusAreas,
                      { text: focusText.trim(), checked: false },
                    ],
                  });
                  focusText = '';
                }
              }}
            >
              <input
                style="width:calc(100% - 40px)"
                aria-label={t('New focus area')}
                placeholder={t('Add a focus area…')}
                bind:value={focusText}
              /><button class="icon-button" aria-label={t('Add focus area')}
                ><Icon name="plus" size={16} /></button
              >
            </form>
          </div>
        </section>
        <section>
          <div class="field">
            <label for="conclusion">{t('Conclusion')}</label><textarea
              id="conclusion"
              value={record.data.conclusion}
              placeholder={t('What did you learn?')}
              oninput={(e) => updateSession({ conclusion: e.currentTarget.value })}></textarea>
          </div>
          <div class="field" style="margin-top:12px">
            <label for="exclusions">{t('Not tested / limitations')}</label><textarea
              id="exclusions"
              value={record.data.exclusions}
              placeholder={t('Make the remaining gaps explicit.')}
              oninput={(e) => updateSession({ exclusions: e.currentTarget.value })}></textarea>
          </div>
          {#if record.data.state !== 'completed'}<button
              class="button"
              style="margin-top:14px;width:100%"
              onclick={() => setSessionState('completed')}
              ><Icon name="check" size={14} />{t('Finish session')}</button
            >{/if}
        </section>
      {:else}<section>
          <div class="field">
            <label for="doc-tags">{t('Tags')}</label><input
              id="doc-tags"
              value={record.tags.join(', ')}
              placeholder={t('e.g. onboarding, mobile')}
              onchange={(e) =>
                workspace.edit({
                  ...record,
                  tags: e.currentTarget.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                })}
            />
          </div>
        </section>
        <label class="check-row"
          ><input
            type="checkbox"
            checked={record.data.private}
            onchange={(e) =>
              workspace.edit({
                ...record,
                data: { ...record.data, private: e.currentTarget.checked },
              })}
          />{t('Keep this document private')}</label
        >
        <p class="muted small">
          {t('Private documents are excluded from safe sharing by default.')}
        </p>
        <label class="button"
          ><Icon name="attach" size={15} />{t('Attach evidence')}<input
            class="sr-only"
            type="file"
            multiple
            onchange={attach}
          /></label
        >{/if}
      <section class="section-rule">
        <button
          class="button ghost danger"
          onclick={() => workspace.remove(record.id).catch((e) => workspace.fail(e))}
          ><Icon name="trash" size={14} />{t('Move to Trash')}</button
        >
      </section>
    </aside>
  </div>
{/if}
<Modal
  bind:open={newOpen}
  title={newKind === 'session' ? t('Start an exploratory session') : t('A fresh page')}
  description={newKind === 'session'
    ? t('Start with a question. Capture the answers as you test.')
    : t('Give it a name, or start writing and decide later.')}
  ><form
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <div class="field">
      <label for="new-note-title">{t('Title')}</label><input
        id="new-note-title"
        bind:value={newTitle}
        placeholder={newKind === 'session'
          ? t('e.g. Checkout and payment recovery')
          : t('e.g. Account setup walkthrough')}
      />
    </div>
    <div class="modal-actions">
      <button type="button" class="button" onclick={() => (newOpen = false)}>{t('Cancel')}</button
      ><button class="button primary" disabled={creating}
        >{newKind === 'session' ? t('Start session') : t('Create document')}</button
      >
    </div>
  </form></Modal
>

<Modal
  bind:open={entryOpen}
  title={t('Edit entry')}
  description={t('Changes are saved locally and earlier versions remain in history.')}
  wide
>
  {#if editingEntry}<div class="form-stack">
      <TextField
        label={t('Title')}
        value={editingEntry.title}
        onchange={(title) => workspace.edit({ ...editingEntry, title })}
      />
      <label class="field"
        ><span>{t('Category')}</span><select
          value={editingEntry.data.category}
          onchange={(e) =>
            workspace.edit({
              ...editingEntry,
              data: {
                ...editingEntry.data,
                category: e.currentTarget.value as EntryData['category'],
              },
            })}
        >
          {#each ['observation', 'passed', 'issue', 'question', 'idea'] as category}<option
              value={category}>{codeLabel(category)}</option
            >{/each}
        </select></label
      >
      <RichEditor
        value={editingEntry.body}
        onchange={(body) => workspace.edit({ ...editingEntry, body })}
      />
      <div class="form-grid">
        <TextField
          label={t('Expected')}
          multiline
          value={editingEntry.data.expected}
          onchange={(expected) =>
            workspace.edit({ ...editingEntry, data: { ...editingEntry.data, expected } })}
        /><TextField
          label={t('Actual')}
          multiline
          value={editingEntry.data.actual}
          onchange={(actual) =>
            workspace.edit({ ...editingEntry, data: { ...editingEntry.data, actual } })}
        />
      </div>
    </div>{/if}
  <div class="modal-actions">
    <button
      class="button primary"
      onclick={() => {
        void workspace
          .flush()
          .then(() => (entryOpen = false))
          .catch((e) => workspace.fail(e));
      }}>{t('Done')}</button
    >
  </div>
</Modal>

<style>
  .timeline {
    padding: 4px 0 12px;
  }
  .timeline-entry {
    display: grid;
    grid-template-columns: 27px 45px minmax(0, 1fr);
    gap: 12px;
    position: relative;
    padding: 0 0 28px;
  }
  .timeline-entry:before {
    content: '';
    position: absolute;
    left: 13px;
    top: 28px;
    bottom: 0;
    width: 1px;
    background: var(--line);
  }
  .entry-marker {
    width: 27px;
    height: 27px;
    display: grid;
    place-items: center;
    font-size: 11px;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: var(--surface);
    color: var(--muted);
  }
  time {
    font-family: 'iA Writer Mono', monospace;
    font-size: 10px;
    padding-top: 6px;
    color: var(--muted);
  }
  .entry-top {
    display: flex;
    align-items: center;
    min-height: 27px;
    gap: 8px;
    margin-bottom: 3px;
  }
  .entry-content h3 {
    font-size: 14px;
    line-height: 1.5;
  }
  .entry-description {
    margin-top: 7px;
    color: var(--muted);
    font-size: 12px;
  }
  .entry-actions {
    display: flex;
    gap: 14px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .entry-actions button {
    display: flex;
    gap: 5px;
    align-items: center;
    font-size: 10px;
    color: var(--muted);
    padding: 2px 0;
  }
  .entry-actions button:hover {
    color: var(--accent);
  }
  .entry-composer {
    border: 1px solid var(--line);
    border-radius: var(--panel-radius);
    padding: 12px 16px;
    margin-top: 8px;
  }
  .composer-kind {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .composer-kind select {
    border: 0;
    background: var(--canvas);
    font-size: 11px;
    padding: 5px 8px;
  }
  .composer-kind .small {
    font-size: 10px;
  }
  .composer-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  @media (max-width: 800px) {
    .timeline-entry {
      grid-template-columns: 26px minmax(0, 1fr);
      gap: 10px;
    }
    .timeline-entry time {
      display: none;
    }
    .entry-actions {
      gap: 10px;
    }
  }
</style>
