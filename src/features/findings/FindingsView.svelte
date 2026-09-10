<script lang="ts">
  import EvidenceLinks from '../evidence/EvidenceLinks.svelte';
  import { duplicateLinkIsValid } from '../../lib/domain/promotion';
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { Entity, FindingData, FindingStatus, Outcome } from '../../lib/domain/types';
  import {
    defaultData,
    emptyEnvironment,
    newId,
    outcomeLabels,
    statusLabels,
  } from '../../lib/domain/defaults';
  import {
    appendFindingRetest,
    getFindingVerification,
    transitionFinding,
  } from '../../lib/domain/testing';
  import Icon from '../../lib/ui/Icon.svelte';
  import Modal from '../../lib/ui/Modal.svelte';
  import EmptyState from '../../lib/ui/EmptyState.svelte';
  import TextField from '../../lib/ui/TextField.svelte';
  import RichEditor from '../../lib/ui/RichEditor.svelte';
  import EnvironmentFields from '../../lib/ui/EnvironmentFields.svelte';
  import { importEvidence } from '../evidence/evidence';
  let { workspace }: { workspace: Workspace } = $props();
  let query = $state(''),
    status = $state('all'),
    createOpen = $state(false),
    title = $state(''),
    retestOpen = $state(false),
    retestNotes = $state(''),
    retestOutcome = $state<Outcome>('passed'),
    retestEnvironment = $state(emptyEnvironment()),
    retestEvidence = $state<string[]>([]),
    saving = $state(false);
  const finding = $derived(workspace.selected?.kind === 'finding' ? workspace.selected : null);
  const findings = $derived(
    workspace.visible.filter((r): r is Entity<'finding'> => r.kind === 'finding'),
  );
  const items = $derived(
    findings.filter(
      (r) =>
        (status === 'all' || r.data.status === status) &&
        [r.title, r.data.code, r.data.component]
          .join(' ')
          .toLowerCase()
          .includes(query.toLowerCase()),
    ),
  );
  const cases = $derived(workspace.visible.filter((r): r is Entity<'case'> => r.kind === 'case'));
  function data(values: Partial<FindingData>) {
    if (finding) workspace.edit({ ...finding, data: { ...finding.data, ...values } });
  }
  function duplicate(targetId: string) {
    if (!finding) return;
    if (!duplicateLinkIsValid($state.snapshot(finding), targetId, $state.snapshot(findings))) {
      workspace.fail(
        t('Duplicate links cannot point to themselves, form a cycle, or cross projects.'),
      );
      return;
    }
    data({ duplicateOf: targetId || undefined });
  }
  function changeStatus(status: FindingStatus) {
    if (!finding) return;
    const result = transitionFinding($state.snapshot(finding.data), status);
    if (result.ok) data(result.value);
    else workspace.fail(result.issues.map((i) => i.message).join(' '));
  }
  async function create() {
    saving = true;
    try {
      const highest = Math.max(
        0,
        ...workspace.records
          .filter((r) => r.kind === 'finding')
          .map((r) => (r.kind === 'finding' ? Number(r.data.code.match(/-(\d+)$/)?.[1] ?? 0) : 0)),
      );
      const item = await workspace.create('finding', title.trim() || t('Untitled finding'), {
        ...defaultData('finding'),
        code: `${workspace.project?.prefix ?? 'TF'}-${String(highest + 1).padStart(3, '0')}`,
      });
      title = '';
      createOpen = false;
      workspace.navigate('findings', item.id);
    } catch (e) {
      workspace.fail(e);
    } finally {
      saving = false;
    }
  }
  async function attach(e: Event, retest = false) {
    const input = e.currentTarget as HTMLInputElement;
    if (!input.files?.length || !finding) return;
    try {
      const added = await importEvidence(workspace, Array.from(input.files));
      if (retest) retestEvidence = [...retestEvidence, ...added.map((r) => r.id)];
      else data({ evidenceIds: [...finding.data.evidenceIds, ...added.map((r) => r.id)] });
    } catch (e) {
      workspace.fail(e);
    }
    input.value = '';
  }
  async function addRetest() {
    if (!finding) return;
    const result = appendFindingRetest($state.snapshot(finding.data), {
      id: newId(),
      at: new Date().toISOString(),
      environment: $state.snapshot(retestEnvironment),
      outcome: retestOutcome,
      notes: retestNotes,
      evidenceIds: [...retestEvidence],
    });
    if (!result.ok) {
      workspace.fail(result.issues.map((i) => i.message).join(' '));
      return;
    }
    saving = true;
    try {
      data(result.value);
      await workspace.flush();
      retestOpen = false;
      workspace.notify(t('Retest recorded. The original finding is preserved.'));
    } catch (e) {
      workspace.fail(e);
    } finally {
      saving = false;
    }
  }
</script>

{#if !finding}<section class="page">
    <div class="page-heading">
      <div>
        <h1>{t('Findings')}</h1>
        <p>{t('From first observation to a verified resolution.')}</p>
      </div>
      <button class="button primary" onclick={() => (createOpen = true)}
        ><Icon name="plus" size={16} />{t('New finding')}</button
      >
    </div>
    <div class="page-tools">
      <div class="filter-input">
        <Icon name="search" size={16} /><input
          aria-label={t('Find a finding')}
          bind:value={query}
          placeholder={t('Search title, identifier, or component…')}
        />
      </div>
      <select aria-label={t('Filter finding status')} bind:value={status}
        ><option value="all">{t('All statuses')}</option
        >{#each Object.entries(statusLabels) as [key, label]}<option value={key}>{t(label)}</option
          >{/each}</select
      ><span class="spacer"></span><span class="muted small"
        >{items.length} {t('finding')}{items.length === 1 ? '' : 's'}</span
      >
    </div>
    {#if !items.length}<EmptyState
        icon="finding"
        title={query || status !== 'all'
          ? t('No matching findings')
          : t('Turn a discovery into a clear next step')}
        description={t(
          'Record what happened, what should happen, and enough context for someone else to reproduce it.',
        )}
        action={t('Document a finding')}
        onclick={() => (createOpen = true)}
      />{:else}<div class="table-wrapper">
        <table class="data-table">
          <thead
            ><tr
              ><th>{t('Identifier')}</th><th>{t('Finding')}</th><th>{t('Severity')}</th><th
                >{t('Status')}</th
              ><th>{t('Owner')}</th></tr
            ></thead
          ><tbody
            >{#each items as item}<tr
                ><td class="mono">{item.data.code}</td><td
                  ><button class="row-title" onclick={() => workspace.navigate('findings', item.id)}
                    >{item.title}</button
                  >
                  <div class="row-subtitle">
                    {item.data.component || t('No component')} · {item.data.priority}
                    {t('priority')}
                  </div></td
                ><td
                  ><span class="status {item.data.severity}"
                    ><span class="status-dot"></span>{codeLabel(item.data.severity)}</span
                  ></td
                ><td
                  ><span class="status {item.data.status}">{t(statusLabels[item.data.status])}</span
                  ></td
                ><td>{item.data.owner || t('Unassigned')}</td></tr
              >{/each}</tbody
          >
        </table>
      </div>{/if}
  </section>
{:else}<div class="detail-layout">
    <article class="detail-main">
      <button class="detail-back" onclick={() => workspace.navigate('findings')}
        ><Icon name="back" size={14} />{t('All findings')}</button
      >
      <div class="eyebrow mono">{finding.data.code}</div>
      <input
        class="title-input"
        style="margin-top:8px"
        aria-label={t('Finding title')}
        value={finding.title}
        oninput={(e) => workspace.edit({ ...finding, title: e.currentTarget.value })}
      />
      <div class="detail-meta">
        <span class="status {finding.data.status}"
          ><span class="status-dot"></span>{t(statusLabels[finding.data.status])}</span
        ><span>{codeLabel(finding.data.severity)} {t('severity')}</span
        >{#if finding.data.status === 'resolved'}<span class="tag"
            >{t('Resolution')} {codeLabel(getFindingVerification(finding.data))}</span
          >{/if}<span class="spacer"></span><span class="save-indicator"
          >{workspace.saveStatus === 'saved'
            ? t('Saved locally')
            : workspace.saveStatus === 'saving'
              ? t('Saving…')
              : t('Save failed')}</span
        >
      </div>
      <h3 class="subheading">{t('Context')}</h3>
      <RichEditor
        value={finding.body}
        onchange={(body) => workspace.edit({ ...finding, body })}
        compact
        placeholder={t('What were you testing when you found this?')}
      />
      <h3 class="subheading">{t('Steps to reproduce')}</h3>
      <div class="form-stack">
        {#each finding.data.steps as step, i}<div class="step-row">
            <span class="mono muted">{i + 1}</span><textarea
              aria-label={t('Reproduction step {step}', { step: i + 1 })}
              value={step}
              placeholder={t('Describe one action…')}
              oninput={(e) =>
                data({
                  steps: finding.data.steps.map((s, j) => (i === j ? e.currentTarget.value : s)),
                })}></textarea><button
              class="icon-button"
              aria-label={t('Remove step {step}', { step: i + 1 })}
              onclick={() => data({ steps: finding.data.steps.filter((_, j) => j !== i) })}
              ><Icon name="close" size={14} /></button
            >
          </div>{/each}<button
          class="button ghost"
          style="justify-self:start"
          onclick={() => data({ steps: [...finding.data.steps, ''] })}
          ><Icon name="plus" size={14} />{t('Add step')}</button
        >
      </div>
      <div class="comparison" style="margin-top:24px">
        <div>
          <label for="finding-expected">{t('Expected behavior')}</label><textarea
            id="finding-expected"
            value={finding.data.expected}
            oninput={(e) => data({ expected: e.currentTarget.value })}
            placeholder={t('How should it work?')}></textarea>
        </div>
        <div class="actual">
          <label for="finding-actual">{t('Actual behavior')}</label><textarea
            id="finding-actual"
            value={finding.data.actual}
            oninput={(e) => data({ actual: e.currentTarget.value })}
            placeholder={t('What happened instead?')}></textarea>
        </div>
      </div>
      <div class="form-stack section-rule">
        <TextField
          label={t('Impact')}
          value={finding.data.impact}
          multiline
          onchange={(impact) => data({ impact })}
          placeholder={t('Who is affected, and what can they no longer do?')}
        />
        <div class="form-grid">
          <TextField
            label={t('Suspected cause')}
            value={finding.data.suspectedCause}
            multiline
            onchange={(suspectedCause) => data({ suspectedCause })}
            hint={t('A hypothesis to investigate.')}
          /><TextField
            label={t('Confirmed cause')}
            value={finding.data.confirmedCause}
            multiline
            onchange={(confirmedCause) => data({ confirmedCause })}
            hint={t('Only what the evidence establishes.')}
          />
        </div>
        <TextField
          label={t('Workaround')}
          value={finding.data.workaround}
          multiline
          onchange={(workaround) => data({ workaround })}
        /><TextField
          label={t('Resolution')}
          value={finding.data.resolution}
          multiline
          onchange={(resolution) => data({ resolution })}
          hint={t('Required to resolve a finding. Verification remains separate.')}
        />
      </div>
      <h3 class="subheading section-rule">{t('Evidence')}</h3>
      <EvidenceLinks
        {workspace}
        recordId={finding.id}
        ids={finding.data.evidenceIds}
        onchange={(evidenceIds) => data({ evidenceIds })}
      />
      <div class="subheading section-rule">
        <h3>{t('Retest history')}</h3>
        <button
          class="button"
          onclick={() => {
            retestNotes = '';
            retestOutcome = 'passed';
            retestEnvironment = JSON.parse(JSON.stringify(finding.data.environment));
            retestEvidence = [];
            retestOpen = true;
          }}><Icon name="play" size={14} />{t('Record a retest')}</button
        >
      </div>
      {#if finding.data.retests.length}
        {@const latest = [...finding.data.retests].sort((a, b) => b.at.localeCompare(a.at))[0]}
        <div class="comparison section-rule">
          <div>
            <h3>{t('Original failure')}</h3>
            <p class="muted small">
              {t('Build')}
              {finding.data.environment.build || t('Not recorded')}
            </p>
            <p>{finding.data.actual || t('No additional notes.')}</p>
            <EvidenceLinks
              {workspace}
              recordId={finding.id}
              ids={finding.data.evidenceIds}
              readonly
            />
          </div>
          <div class="actual">
            <h3>{t('Latest retest')}</h3>
            <p class="status {latest.outcome}">{codeLabel(latest.outcome)}</p>
            <p class="muted small">{t('Build')} {latest.environment.build || t('Not recorded')}</p>
            <p>{latest.notes || t('No additional notes.')}</p>
            <EvidenceLinks {workspace} recordId={latest.id} ids={latest.evidenceIds} readonly />
          </div>
        </div>
      {/if}
      {#each [...finding.data.retests].reverse() as retest}<div class="retest">
          <div class="button-row">
            <span class="status {retest.outcome}"
              ><span class="status-dot"></span>{t(outcomeLabels[retest.outcome])}</span
            ><span class="muted small"
              >{t('Build')}
              {retest.environment.build || t('not set')} · {new Date(retest.at).toLocaleString(
                intlLocale(),
              )}</span
            >
          </div>
          <p>{retest.notes || t('No additional notes.')}</p>
          <div class="button-row">
            {#each retest.evidenceIds as id}<button
                class="button small"
                onclick={() => workspace.navigate('evidence', id)}>{t('View evidence')}</button
              >{/each}
          </div>
        </div>{:else}<p class="muted small">
          {t('No retests yet. Each retest keeps its own environment and evidence.')}
        </p>{/each}
    </article>
    <aside class="context-panel">
      <div class="context-heading">
        <h2>{t('Finding details')}</h2>
        <Icon name="finding" size={18} />
      </div>
      <section class="form-stack">
        <div class="field">
          <label for="finding-status">{t('Status')}</label><select
            id="finding-status"
            value={finding.data.status}
            onchange={(e) => changeStatus(e.currentTarget.value as FindingStatus)}
            >{#each Object.entries(statusLabels) as [key, label]}<option value={key}
                >{t(label)}</option
              >{/each}</select
          >
        </div>
        <div class="field">
          <label for="finding-severity">{t('Severity')}</label><select
            id="finding-severity"
            value={finding.data.severity}
            onchange={(e) => data({ severity: e.currentTarget.value as FindingData['severity'] })}
            >{#each ['blocker', 'critical', 'major', 'minor', 'trivial'] as value}<option {value}
                >{codeLabel(value)}</option
              >{/each}</select
          >
        </div>
        <div class="field">
          <label for="finding-priority">{t('Priority')}</label><select
            id="finding-priority"
            value={finding.data.priority}
            onchange={(e) => data({ priority: e.currentTarget.value as FindingData['priority'] })}
            >{#each ['urgent', 'high', 'normal', 'low'] as value}<option {value}
                >{codeLabel(value)}</option
              >{/each}</select
          >
        </div>
        <label class="check-row"
          ><input
            type="checkbox"
            checked={finding.data.private ?? false}
            onchange={(e) => data({ private: e.currentTarget.checked })}
          />{t('Keep private')}</label
        >
        <label class="field"
          ><span>{t('Duplicate of')}</span><select
            value={finding.data.duplicateOf ?? ''}
            onchange={(e) => duplicate(e.currentTarget.value)}
            ><option value="">{t('Not a duplicate')}</option
            >{#each findings.filter((f) => f.id !== finding.id) as other}<option value={other.id}
                >{other.data.code} · {other.title}</option
              >{/each}</select
          ></label
        >
        <details class="section-rule">
          <summary>{t('Related findings')}</summary>
          <div class="form-stack" style="margin-top:12px">
            {#each findings.filter((f) => f.id !== finding.id) as other}<label class="check-row"
                ><input
                  type="checkbox"
                  checked={finding.data.relatedIds.includes(other.id)}
                  onchange={(e) =>
                    data({
                      relatedIds: e.currentTarget.checked
                        ? [...new Set([...finding.data.relatedIds, other.id])]
                        : finding.data.relatedIds.filter((id) => id !== other.id),
                    })}
                />{other.data.code} · {other.title}</label
              >{/each}
          </div>
        </details>
        <TextField
          label={t('Owner')}
          value={finding.data.owner}
          onchange={(owner) => data({ owner })}
          hint={t('A local label; no account is required.')}
        /><TextField
          label={t('Component')}
          value={finding.data.component}
          onchange={(component) => data({ component })}
        /><TextField
          label={t('Frequency')}
          value={finding.data.frequency}
          onchange={(frequency) => data({ frequency })}
          placeholder={t('e.g. 3 of 5 attempts')}
        />
      </section>
      <section>
        <h3>{t('Original environment')}</h3>
        <EnvironmentFields
          value={finding.data.environment}
          onchange={(environment) => data({ environment })}
        />
      </section>
      <section>
        <h3>{t('Linked test cases')}</h3>
        <div class="form-stack">
          {#each cases as c}<label class="check-row"
              ><input
                type="checkbox"
                checked={finding.data.caseIds.includes(c.id)}
                onchange={(e) =>
                  data({
                    caseIds: e.currentTarget.checked
                      ? [...finding.data.caseIds, c.id]
                      : finding.data.caseIds.filter((id) => id !== c.id),
                  })}
              />{c.title}</label
            >{:else}<p class="muted small">
              {t('Create a test case to track regression coverage.')}
            </p>{/each}
        </div>
      </section>
      <section>
        <TextField
          label={t('Tags')}
          value={finding.tags.join(', ')}
          onchange={(value) =>
            workspace.edit({
              ...finding,
              tags: value
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
            })}
        />
      </section>
      <button
        class="button ghost danger"
        onclick={() => workspace.remove(finding.id).catch((e) => workspace.fail(e))}
        ><Icon name="trash" size={14} />{t('Move to Trash')}</button
      >
    </aside>
  </div>{/if}
<Modal
  bind:open={createOpen}
  title={t('Document a finding')}
  description={t('Start with the observable problem. Add the detail as you investigate.')}
  ><form
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <TextField
      label={t('Title')}
      value={title}
      onchange={(v) => (title = v)}
      placeholder={t('e.g. Saved address disappears after refresh')}
    />
    <div class="modal-actions">
      <button type="button" class="button" onclick={() => (createOpen = false)}
        >{t('Cancel')}</button
      ><button class="button primary" disabled={saving}>{t('Create finding')}</button>
    </div>
  </form></Modal
>
<Modal
  bind:open={retestOpen}
  title={t('Record a retest')}
  description={t('A new record of what happened, with its own build and evidence.')}
  wide
  ><div class="form-grid">
    <div class="form-stack">
      <div class="field">
        <label for="retest-outcome">{t('Outcome')}</label><select
          id="retest-outcome"
          bind:value={retestOutcome}
          >{#each ['passed', 'failed', 'blocked', 'skipped'] as value}<option {value}
              >{t(outcomeLabels[value as Outcome])}</option
            >{/each}</select
        >
      </div>
      <TextField
        label={t('Retest notes')}
        value={retestNotes}
        onchange={(v) => (retestNotes = v)}
        multiline
        hint={t('Blocked or skipped retests require an explanation.')}
      /><label class="button"
        ><Icon name="attach" size={14} />{t('Attach retest evidence')}<input
          class="sr-only"
          type="file"
          multiple
          onchange={(e) => attach(e, true)}
        /></label
      ><span class="muted small">{retestEvidence.length} {t('evidence files attached')}</span>
    </div>
    <EnvironmentFields value={retestEnvironment} onchange={(v) => (retestEnvironment = v)} />
  </div>
  <div class="modal-actions">
    <button class="button" onclick={() => (retestOpen = false)}>{t('Cancel')}</button><button
      class="button primary"
      disabled={saving}
      onclick={addRetest}>{t('Save retest')}</button
    >
  </div></Modal
>

<style>
  .step-row {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) 32px;
    gap: 10px;
    align-items: start;
  }
  .step-row > span {
    padding-top: 9px;
  }
  .step-row textarea {
    min-height: 58px;
    width: 100%;
    font-size: 13px;
  }
  .retest {
    border-bottom: 1px solid var(--line);
    padding: 16px 0;
  }
  .retest p {
    white-space: pre-wrap;
    font-size: 12px;
    margin: 10px 0;
  }
</style>
