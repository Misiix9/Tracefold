<script lang="ts">
  import EvidenceLinks from '../evidence/EvidenceLinks.svelte';
  import { t, codeLabel, intlLocale, date } from '../../lib/i18n/i18n.svelte';

  import type { Workspace } from '../../lib/services/workspace.svelte';
  import type { Entity, CaseData, RunData, RequirementData, Outcome } from '../../lib/domain/types';
  import { defaultData, emptyEnvironment, newId, outcomeLabels } from '../../lib/domain/defaults';
  import {
    createRunSnapshot,
    getRunCounts,
    getRequirementsCoverage,
    updateRunExecution,
    updateRunStep,
  } from '../../lib/domain/testing';
  import type { ExecutionUpdate } from '../../lib/domain/testing';
  import { previewImport, parseCsv } from '../../lib/domain/imports';
  import type { ImportFormat, ImportPreview, CsvColumnMapping } from '../../lib/domain/imports';
  import Icon from '../../lib/ui/Icon.svelte';
  import Modal from '../../lib/ui/Modal.svelte';
  import EmptyState from '../../lib/ui/EmptyState.svelte';
  import TextField from '../../lib/ui/TextField.svelte';
  import EnvironmentFields from '../../lib/ui/EnvironmentFields.svelte';
  import RichEditor from '../../lib/ui/RichEditor.svelte';
  let { workspace, section }: { workspace: Workspace; section: 'cases' | 'runs' | 'coverage' } =
    $props();
  let query = $state(''),
    createOpen = $state(false),
    newTitle = $state(''),
    selectedCases = $state<string[]>([]),
    runEnvironment = $state(emptyEnvironment()),
    busy = $state(false),
    executionId = $state(''),
    reasonOpen = $state(false),
    reason = $state(''),
    pendingOutcome = $state<Outcome>('blocked'),
    pendingStep = $state<string | null>(null),
    datasetName = $state('');
  let importOpen = $state(false),
    importSource = $state(''),
    importName = $state(''),
    importFormat = $state<ImportFormat>('junit'),
    importPreview = $state<ImportPreview | null>(null),
    repeat = $state(false),
    mapping = $state<CsvColumnMapping>({ title: 'name', outcome: 'status' }),
    columns = $state<string[]>([]);
  const cases = $derived(workspace.visible.filter((r): r is Entity<'case'> => r.kind === 'case'));
  const runs = $derived(workspace.visible.filter((r): r is Entity<'run'> => r.kind === 'run'));
  const requirements = $derived(
    workspace.visible.filter((r): r is Entity<'requirement'> => r.kind === 'requirement'),
  );
  const testCase = $derived(
    section === 'cases' && workspace.selected?.kind === 'case' ? workspace.selected : null,
  );
  const run = $derived(
    section === 'runs' && workspace.selected?.kind === 'run' ? workspace.selected : null,
  );
  const requirement = $derived(
    section === 'coverage' && workspace.selected?.kind === 'requirement'
      ? workspace.selected
      : null,
  );
  const execution = $derived(
    run?.data.executions.find((e) => e.id === executionId) ?? run?.data.executions[0],
  );
  const coverage = $derived(getRequirementsCoverage(requirements, cases, runs));
  const counts = $derived(run ? getRunCounts(run.data.executions) : null);
  function caseData(values: Partial<CaseData>) {
    if (testCase) workspace.edit({ ...testCase, data: { ...testCase.data, ...values } });
  }
  function runData(values: Partial<RunData>) {
    if (run) workspace.edit({ ...run, data: { ...run.data, ...values } });
  }
  function requirementData(values: Partial<RequirementData>) {
    if (requirement) workspace.edit({ ...requirement, data: { ...requirement.data, ...values } });
  }
  async function create() {
    busy = true;
    try {
      await workspace.flush();
      let item;
      if (section === 'cases')
        item = await workspace.create('case', newTitle.trim() || t('Untitled test case'));
      else if (section === 'coverage')
        item = await workspace.create('requirement', newTitle.trim() || t('Untitled requirement'));
      else {
        const snapshot = createRunSnapshot(
          $state.snapshot(cases.filter((c) => selectedCases.includes(c.id))),
          $state.snapshot(runEnvironment),
          { runId: newId(), at: new Date().toISOString() },
        );
        if (!snapshot.ok) throw new Error(snapshot.issues.map((i) => i.message).join(' '));
        item = await workspace.create(
          'run',
          newTitle.trim() || t('Test run · {date}', { date: date(new Date()) }),
          snapshot.value,
        );
      }
      createOpen = false;
      newTitle = '';
      workspace.navigate(section, item.id);
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
  function editExecution(update: ExecutionUpdate) {
    if (!run || !execution) return;
    const result = updateRunExecution(
      $state.snapshot(run.data),
      execution.id,
      update,
      new Date().toISOString(),
    );
    if (result.ok) runData(result.value);
    else workspace.fail(result.issues.map((i) => i.message).join(' '));
  }
  function outcome(value: Outcome, step: string | null = null) {
    if (!run || !execution) return;
    if (value === 'blocked' || value === 'skipped') {
      reason = '';
      pendingOutcome = value;
      pendingStep = step;
      reasonOpen = true;
      return;
    }
    applyOutcome(value, '', step);
  }
  function applyOutcome(value: Outcome, text: string, step: string | null) {
    if (!run || !execution) return;
    if (step) {
      const result = updateRunStep(
        $state.snapshot(run.data),
        execution.id,
        step,
        value,
        text,
        new Date().toISOString(),
      );
      if (result.ok) runData(result.value);
      else workspace.fail(result.issues.map((i) => i.message).join(' '));
    } else editExecution({ outcome: value, reason: text });
  }
  function finishRun() {
    if (!run) return;
    if (run.data.executions.some((e) => e.outcome === 'not_run') && !run.data.exclusions.trim()) {
      workspace.fail(
        t('Describe the untested scope before completing a run with remaining tests.'),
      );
      return;
    }
    runData({ state: 'completed', completedAt: new Date().toISOString() });
  }
  async function retestRun() {
    if (!run) return;
    try {
      const copy = JSON.parse(JSON.stringify(run.data)) as RunData;
      copy.state = 'active';
      copy.startedAt = new Date().toISOString();
      copy.completedAt = undefined;
      copy.conclusion = '';
      copy.exclusions = '';
      copy.executions = copy.executions.map((e) => ({
        ...e,
        id: newId(),
        outcome: 'not_run',
        reason: '',
        notes: '',
        stepReasons: {},
        durationMs: undefined,
        stepResults: Object.fromEntries(e.steps.map((s) => [s.id, 'not_run'])),
        evidenceIds: [],
        updatedAt: copy.startedAt,
      }));
      const item = await workspace.create('run', `${run.title} · ${t('Retest')}`, copy);
      workspace.navigate('runs', item.id);
      executionId = '';
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function findingFromFailure() {
    if (!run || !execution) return;
    if (execution.findingIds.length) {
      workspace.navigate('findings', execution.findingIds[0]);
      return;
    }
    try {
      const highest = Math.max(
        0,
        ...workspace.records
          .filter((r) => r.kind === 'finding')
          .map((r) => (r.kind === 'finding' ? Number(r.data.code.match(/-(\d+)$/)?.[1] ?? 0) : 0)),
      );
      const item = await workspace.create('finding', execution.caseTitle, {
        ...defaultData('finding'),
        private: run.data.private ?? false,
        code: `${workspace.project?.prefix ?? 'TF'}-${String(highest + 1).padStart(3, '0')}`,
        steps: execution.steps.map((s) => s.action),
        expected: execution.steps
          .map((s) => s.expected)
          .filter(Boolean)
          .join('\n'),
        actual: execution.notes || execution.reason,
        environment: JSON.parse(JSON.stringify(run.data.environment)),
        caseIds: cases.some((c) => c.id === execution.caseId) ? [execution.caseId] : [],
        evidenceIds: [...execution.evidenceIds],
      });
      editExecution({ findingIds: [item.id] });
      workspace.notify(t('Finding created and linked to this result.'));
    } catch (e) {
      workspace.fail(e);
    }
  }
  function datasetValues(id: string, text: string) {
    try {
      const entries = text
        .split('\n')
        .filter((x) => x.trim())
        .map((line) => {
          const split = line.indexOf('=');
          if (split < 1) throw new Error(t('Use one key=value pair per line.'));
          return [line.slice(0, split).trim(), line.slice(split + 1)];
        });
      if (new Set(entries.map((e) => e[0])).size !== entries.length)
        throw new Error(t('Each dataset key must be unique.'));
      if (testCase)
        caseData({
          datasets: testCase.data.datasets.map((d) =>
            d.id === id ? { ...d, values: Object.fromEntries(entries) } : d,
          ),
        });
    } catch (e) {
      workspace.fail(e);
    }
  }
  function preview() {
    try {
      importPreview = previewImport(importFormat, importSource, {
        filename: importName,
        importedAt: new Date().toISOString(),
        existingFingerprints: runs.flatMap((r) =>
          r.data.source ? [r.data.source.fingerprint] : [],
        ),
        repeatPolicy: repeat ? 'allow' : 'reject',
        csvMapping: importFormat === 'csv' ? $state.snapshot(mapping) : undefined,
      });
    } catch (e) {
      workspace.fail(e);
    }
  }
  async function readImport(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5_000_000) {
      workspace.fail(t('Results imports are limited to 5 MB.'));
      return;
    }
    importName = file.name;
    importSource = await file.text();
    importFormat = file.name.toLowerCase().endsWith('.csv')
      ? 'csv'
      : file.name.toLowerCase().endsWith('.json')
        ? 'tracefold-json'
        : 'junit';
    repeat = false;
    if (importFormat === 'csv') {
      const result = parseCsv(importSource);
      columns = result.rows[0]?.cells ?? [];
      mapping = {
        title: columns.includes('name') ? 'name' : (columns[0] ?? ''),
        outcome: columns.includes('status') ? 'status' : (columns[1] ?? ''),
      };
    }
    preview();
  }
  async function confirmImport() {
    if (!importPreview?.canImport || !importPreview.run) return;
    busy = true;
    try {
      const item = await workspace.create(
        'run',
        importName.replace(/\.[^.]+$/, ''),
        $state.snapshot(importPreview.run),
      );
      importOpen = false;
      workspace.navigate('runs', item.id);
    } catch (e) {
      workspace.fail(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if testCase}
  <div class="detail-layout">
    <article class="detail-main">
      <button class="detail-back" onclick={() => workspace.navigate('cases')}
        ><Icon name="back" size={14} />{t('All test cases')}</button
      >
      <div class="eyebrow">{t('Reusable test case')}</div>
      <input
        class="title-input"
        style="margin-top:8px"
        aria-label={t('Test case title')}
        value={testCase.title}
        oninput={(e) => workspace.edit({ ...testCase, title: e.currentTarget.value })}
      />
      <div class="detail-meta">
        <span>{testCase.data.steps.length} {t('steps')}</span><span
          >{testCase.data.datasets.length || 1} {t('data variations')}</span
        ><span>{t('Revision')} {testCase.revision}</span>
      </div>
      <TextField
        label={t('Prerequisites')}
        multiline
        value={testCase.data.prerequisites}
        onchange={(prerequisites) => caseData({ prerequisites })}
        placeholder={t('What must be true before the tester begins?')}
      />
      <h3 class="subheading">{t('Actions & expected results')}</h3>
      <div class="form-stack">
        {#each testCase.data.steps as step, i}<div class="case-step">
            <span class="step-number mono">{i + 1}</span>
            <div class="form-grid">
              <TextField
                label={t('Action')}
                multiline
                value={step.action}
                onchange={(action) =>
                  caseData({
                    steps: testCase.data.steps.map((s) =>
                      s.id === step.id ? { ...s, action } : s,
                    ),
                  })}
              /><TextField
                label={t('Expected result')}
                multiline
                value={step.expected}
                onchange={(expected) =>
                  caseData({
                    steps: testCase.data.steps.map((s) =>
                      s.id === step.id ? { ...s, expected } : s,
                    ),
                  })}
              />
            </div>
            <div>
              <button
                class="icon-button"
                aria-label={t('Move step {step} up', { step: i + 1 })}
                disabled={i === 0}
                onclick={() => {
                  const steps = [...testCase.data.steps];
                  [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
                  caseData({ steps });
                }}>↑</button
              ><button
                class="icon-button"
                aria-label={t('Remove step {step}', { step: i + 1 })}
                onclick={() =>
                  caseData({ steps: testCase.data.steps.filter((s) => s.id !== step.id) })}
                ><Icon name="trash" size={14} /></button
              >
            </div>
          </div>{/each}<button
          class="button"
          style="justify-self:start"
          onclick={() =>
            caseData({
              steps: [...testCase.data.steps, { id: newId(), action: '', expected: '' }],
            })}><Icon name="plus" size={14} />{t('Add step')}</button
        >
      </div>
      <div class="section-rule">
        <h3>{t('Additional notes')}</h3>
        <RichEditor
          compact
          value={testCase.body}
          onchange={(body) => workspace.edit({ ...testCase, body })}
        />
      </div>
      <div class="section-rule">
        <h3>{t('Evidence')}</h3>
        <EvidenceLinks
          {workspace}
          recordId={testCase.id}
          ids={testCase.data.evidenceIds}
          onchange={(evidenceIds) => caseData({ evidenceIds })}
        />
        <h3>{t('Datasets')}</h3>
        <p class="muted small" style="margin:8px 0 18px">
          {t('Each dataset creates a separate execution. Use')}
          {`{{key}}`}
          {t('in steps to identify a value.')}
        </p>
        {#each testCase.data.datasets as dataset}<div class="dataset">
            <TextField
              label={t('Dataset name')}
              value={dataset.name}
              onchange={(name) =>
                caseData({
                  datasets: testCase.data.datasets.map((d) =>
                    d.id === dataset.id ? { ...d, name } : d,
                  ),
                })}
            /><label class="field"
              ><span class="field-label">{t('Values (key=value, one per line)')}</span><textarea
                class="mono"
                value={Object.entries(dataset.values)
                  .map(([k, v]) => `${k}=${v}`)
                  .join('\n')}
                onchange={(e) => datasetValues(dataset.id, e.currentTarget.value)}
              ></textarea></label
            ><button
              class="button ghost danger small"
              onclick={() =>
                caseData({ datasets: testCase.data.datasets.filter((d) => d.id !== dataset.id) })}
              >{t('Remove dataset')}</button
            >
          </div>{/each}<button
          class="button"
          onclick={() =>
            caseData({
              datasets: [
                ...testCase.data.datasets,
                {
                  id: newId(),
                  name: t('Variation {index}', { index: testCase.data.datasets.length + 1 }),
                  values: {},
                },
              ],
            })}><Icon name="plus" size={14} />{t('Add dataset')}</button
        >
      </div>
    </article>
    <aside class="context-panel">
      <div class="context-heading">
        <h2>{t('Case details')}</h2>
        <Icon name="case" size={18} />
      </div>
      <label class="check-row"
        ><input
          type="checkbox"
          checked={testCase.data.private ?? false}
          onchange={(e) => caseData({ private: e.currentTarget.checked })}
        />{t('Keep private')}</label
      >
      <TextField
        label={t('Folder')}
        value={testCase.data.folder}
        onchange={(folder) => caseData({ folder })}
        placeholder={t('e.g. Checkout / Payments')}
      />
      <div class="field">
        <label for="case-priority">{t('Priority')}</label><select
          id="case-priority"
          value={testCase.data.priority}
          onchange={(e) => caseData({ priority: e.currentTarget.value as CaseData['priority'] })}
          ><option value="high">{t('high')}</option><option value="normal">{t('normal')}</option
          ><option value="low">{t('low')}</option></select
        >
      </div>
      <label class="check-row"
        ><input
          type="checkbox"
          checked={testCase.data.automated}
          onchange={(e) => caseData({ automated: e.currentTarget.checked })}
        />{t('Covered by automation')}</label
      >
      <section>
        <h3>{t('Requirements')}</h3>
        <div class="form-stack">
          {#each requirements as r}<label class="check-row"
              ><input
                type="checkbox"
                checked={testCase.data.requirementIds.includes(r.id)}
                onchange={(e) =>
                  caseData({
                    requirementIds: e.currentTarget.checked
                      ? [...testCase.data.requirementIds, r.id]
                      : testCase.data.requirementIds.filter((id) => id !== r.id),
                  })}
              />{r.title}</label
            >{:else}<p class="muted small">
              {t('Add requirements in Coverage to make gaps visible.')}
            </p>{/each}
        </div>
      </section>
      <button
        class="button ghost danger"
        onclick={() => workspace.remove(testCase.id).catch((e) => workspace.fail(e))}
        ><Icon name="trash" size={14} />{t('Move to Trash')}</button
      >
    </aside>
  </div>
{:else if run}
  <section class="page">
    <button class="detail-back" onclick={() => workspace.navigate('runs')}
      ><Icon name="back" size={14} />{t('All runs')}</button
    >
    <div class="page-heading">
      <div>
        <div class="eyebrow">
          {run.data.state === 'active' ? t('Run in progress') : t('Completed run')}
        </div>
        <h1 style="margin-top:8px">{run.title}</h1>
        <p>
          {Object.values(run.data.environment)
            .filter((v) => typeof v === 'string' && v)
            .join(' · ') || t('No environment recorded')}
          {t('· Started')}
          {new Date(run.data.startedAt).toLocaleDateString(intlLocale())}
        </p>
      </div>
      {#if run.data.state === 'active'}<button class="button" onclick={finishRun}
          ><Icon name="check" size={15} />{t('Complete run')}</button
        >{:else}<button class="button" onclick={retestRun}
          ><Icon name="play" size={15} />{t('Create retest run')}</button
        >{/if}
    </div>
    {#if counts}<div class="metrics-line">
        {#each Object.entries(counts.outcomes) as [key, count]}<div class="metric">
            <strong class="status {key}">{count}</strong><span
              >{t(outcomeLabels[key as Outcome])}</span
            >
          </div>{/each}
        <div class="metric">
          <strong
            >{counts.passRate.value === null
              ? '—'
              : Math.round(counts.passRate.value * 100) + '%'}</strong
          ><span>{t('Pass rate ·')} {counts.evaluated} {t('evaluated')}</span>
        </div>
      </div>{/if}
    <div class="run-workbench">
      <nav class="execution-list" aria-label={t('Executions')}>
        {#each run.data.executions as e}<button
            class:active={execution?.id === e.id}
            onclick={() => (executionId = e.id)}
            ><span class="status {e.outcome}"
              ><span class="status-dot"></span>{t(outcomeLabels[e.outcome])}</span
            ><strong>{e.caseTitle}</strong>{#if e.dataset}<small>{e.dataset.name}</small
              >{/if}</button
          >{/each}
      </nav>
      <div class="execution-detail">
        {#if execution}<div class="eyebrow">
            {t('Case snapshot · revision')}
            {execution.caseRevision}
          </div>
          <h2 style="margin-top:8px">{execution.caseTitle}</h2>
          {#if execution.prerequisites}<p class="notice" style="margin-top:16px">
              {execution.prerequisites}
            </p>{/if}{#if execution.dataset}<div class="dataset-values">
              {#each Object.entries(execution.dataset.values) as [key, value]}<div>
                  <code>{key}</code><span>{value}</span>
                </div>{/each}
            </div>{/if}
          <div class="table-wrapper" style="margin:20px 0">
            <table class="data-table">
              <thead
                ><tr><th>{t('Action')}</th><th>{t('Expected')}</th><th>{t('Step result')}</th></tr
                ></thead
              ><tbody
                >{#each execution.steps as step, i}<tr
                    ><td>{i + 1}. {step.action}</td><td>{step.expected || t('Not specified')}</td
                    ><td
                      ><select
                        aria-label={t('Step {step} outcome', { step: i + 1 })}
                        value={execution.stepResults[step.id] ?? 'not_run'}
                        disabled={run.data.state === 'completed'}
                        onchange={(e) => outcome(e.currentTarget.value as Outcome, step.id)}
                        >{#each Object.entries(outcomeLabels) as [value, label]}<option {value}
                            >{t(label)}</option
                          >{/each}</select
                      ></td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>
          <h3>{t('Overall result')}</h3>
          <p class="muted small" style="margin:6px 0 12px">
            {t('Step results inform your decision. Set the overall outcome explicitly.')}
          </p>
          <div class="button-row">
            {#each Object.entries(outcomeLabels) as [value, label]}<button
                class="button"
                class:chosen={execution.outcome === value}
                disabled={run.data.state === 'completed'}
                onclick={() => outcome(value as Outcome)}
                ><span class="status {value}"><span class="status-dot"></span>{t(label)}</span
                ></button
              >{/each}
          </div>
          {#if execution.reason}<div class="notice" style="margin-top:16px">
              <strong>{t('Reason')}</strong>
              <p>{execution.reason}</p>
            </div>{/if}
          <div style="margin-top:20px">
            <TextField
              label={t('Execution notes')}
              multiline
              value={execution.notes}
              disabled={run.data.state === 'completed'}
              onchange={(notes) => editExecution({ notes })}
            />
          </div>
          <h3 class="subheading">{t('Evidence')}</h3>
          <EvidenceLinks
            {workspace}
            recordId={execution.id}
            ids={execution.evidenceIds}
            readonly={run.data.state === 'completed'}
            onchange={(evidenceIds) => editExecution({ evidenceIds })}
          />
          {#if execution.outcome === 'failed'}<div class="button-row" style="margin-top:16px">
              <button
                class="button"
                disabled={run.data.state === 'completed' && !execution.findingIds.length}
                onclick={findingFromFailure}
                ><Icon name="finding" size={15} />{execution.findingIds.length
                  ? t('View linked finding')
                  : t('Create linked finding')}</button
              ><select
                aria-label={t('Link an existing finding')}
                value=""
                disabled={run.data.state === 'completed'}
                onchange={(e) => {
                  if (e.currentTarget.value)
                    editExecution({
                      findingIds: [...new Set([...execution.findingIds, e.currentTarget.value])],
                    });
                }}
                ><option value="">{t('Link existing finding…')}</option
                >{#each workspace.visible.filter((r) => r.kind === 'finding') as f}<option
                    value={f.id}>{f.title}</option
                  >{/each}</select
              >
            </div>{/if}{/if}
      </div>
    </div>
    <label class="check-row section-rule"
      ><input
        type="checkbox"
        checked={run.data.private ?? false}
        onchange={(e) => runData({ private: e.currentTarget.checked })}
      />{t('Keep this run private')}</label
    >
    <div class="form-grid section-rule">
      <TextField
        label={t('Run conclusion')}
        multiline
        value={run.data.conclusion}
        disabled={run.data.state === 'completed'}
        onchange={(conclusion) => runData({ conclusion })}
      /><TextField
        label={t('Untested scope & limitations')}
        multiline
        value={run.data.exclusions}
        disabled={run.data.state === 'completed'}
        onchange={(exclusions) => runData({ exclusions })}
        hint={t('Required when completing with tests still not run.')}
      />
    </div>
  </section>
{:else if requirement}
  <div class="detail-layout">
    <article class="detail-main">
      <button class="detail-back" onclick={() => workspace.navigate('coverage')}
        ><Icon name="back" size={14} />{t('Coverage')}</button
      >
      <div class="eyebrow">{t('Requirement')}</div>
      <input
        class="title-input"
        style="margin:8px 0 28px"
        aria-label={t('Requirement title')}
        value={requirement.title}
        oninput={(e) => workspace.edit({ ...requirement, title: e.currentTarget.value })}
      />
      <div class="form-stack">
        <TextField
          label={t('Description')}
          multiline
          value={requirement.data.description}
          onchange={(description) => requirementData({ description })}
        /><TextField
          label={t('Acceptance criteria')}
          multiline
          value={requirement.data.acceptanceCriteria}
          onchange={(acceptanceCriteria) => requirementData({ acceptanceCriteria })}
        />
      </div>
      <div class="section-rule">
        <h3>{t('Linked test cases')}</h3>
        {#each cases.filter((c) => c.data.requirementIds.includes(requirement.id)) as c}<button
            class="list-row"
            onclick={() => workspace.navigate('cases', c.id)}
            ><Icon name="case" size={18} /><span class="list-title">{c.title}</span></button
          >{:else}<p class="muted small" style="margin-top:12px">
            {t('No cases cover this requirement. Link it from a test case’s details.')}
          </p>{/each}
      </div>
      <div class="section-rule">
        <h3>{t('Current gaps')}</h3>
        {#each coverage.requirements.find((r) => r.requirementId === requirement.id)?.gaps ?? [] as gap}<p
            class="notice"
            style="margin-top:10px"
          >
            {gap.message}
          </p>{:else}<p class="muted small">
            {t('All linked current case variations have a passing result.')}
          </p>{/each}
      </div>
    </article>
    <aside class="context-panel">
      <h2>{t('Requirement details')}</h2>
      <TextField
        label={t('Reference')}
        value={requirement.data.code}
        onchange={(code) => requirementData({ code })}
      /><TextField
        label={t('Owner')}
        value={requirement.data.owner}
        onchange={(owner) => requirementData({ owner })}
      /><button
        class="button ghost danger"
        onclick={() => workspace.remove(requirement.id).catch((e) => workspace.fail(e))}
        ><Icon name="trash" size={14} />{t('Move to Trash')}</button
      >
    </aside>
  </div>
{:else}
  <section class="page">
    <div class="page-heading">
      <div>
        <h1>
          {section === 'cases'
            ? t('Test cases')
            : section === 'runs'
              ? t('Test runs')
              : t('Coverage')}
        </h1>
        <p>
          {section === 'cases'
            ? t('Build a library of repeatable checks, one clear step at a time.')
            : section === 'runs'
              ? t('Keep a trustworthy record of what passed, failed, and remains untested.')
              : t('Connect expectations to evidence. Make the gaps explicit.')}
        </p>
      </div>
      <div class="button-row">
        {#if section === 'runs'}<button class="button" onclick={() => (importOpen = true)}
            ><Icon name="upload" size={15} />{t('Import results')}</button
          >{/if}<button
          class="button primary"
          onclick={() => {
            newTitle = '';
            selectedCases = cases.map((c) => c.id);
            createOpen = true;
          }}
          ><Icon name="plus" size={16} />{section === 'cases'
            ? t('New test case')
            : section === 'runs'
              ? t('Start a run')
              : t('New requirement')}</button
        >
      </div>
    </div>
    {#if section === 'coverage'}<div class="metrics-line">
        <div class="metric">
          <strong>{coverage.linked.numerator} / {coverage.linked.denominator}</strong><span
            >{t('Requirements linked to cases')}</span
          >
        </div>
        <div class="metric">
          <strong>{coverage.tested.numerator} / {coverage.tested.denominator}</strong><span
            >{t('Requirements with evaluated results')}</span
          >
        </div>
        <div class="metric">
          <strong>{coverage.passed.numerator} / {coverage.passed.denominator}</strong><span
            >{t('Requirements fully passing')}</span
          >
        </div>
      </div>{/if}
    <div class="page-tools">
      <div class="filter-input">
        <Icon name="search" size={16} /><input
          aria-label={t('Filter records')}
          bind:value={query}
          placeholder={t('Find by title…')}
        />
      </div>
    </div>
    {#if section === 'coverage' && requirements.length}<div class="table-wrapper">
        <table class="data-table">
          <thead
            ><tr
              ><th>{t('Requirement')}</th><th>{t('Cases')}</th><th>{t('Current status')}</th><th
                >{t('Gaps')}</th
              ></tr
            ></thead
          ><tbody
            >{#each coverage.requirements.filter((r) => r.title
                .toLowerCase()
                .includes(query.toLowerCase())) as row}<tr
                ><td
                  ><button
                    class="row-title"
                    onclick={() => workspace.navigate('coverage', row.requirementId)}
                    >{row.title}</button
                  ></td
                ><td>{row.caseIds.length}</td><td
                  ><span class="status {row.status}"
                    ><span class="status-dot"></span>{codeLabel(row.status)}</span
                  ></td
                ><td>{row.gaps[0]?.message ?? t('No current gaps')}</td></tr
              >{/each}</tbody
          >
        </table>
      </div>
    {:else}{@const records =
        section === 'cases'
          ? cases
          : section === 'runs'
            ? runs
            : requirements}{#each records.filter((r) => r.title
          .toLowerCase()
          .includes(query.toLowerCase())) as item}<button
          class="list-row"
          onclick={() => workspace.navigate(section, item.id)}
          ><span class="list-icon"><Icon name={item.kind} size={20} /></span>
          <div>
            <div class="list-title">{item.title}</div>
            <div class="row-subtitle">
              {#if item.kind === 'case'}{item.data.folder || t('Unfiled')} · {item.data.steps
                  .length}
                {t('steps ·')}
                {item.data.priority}
                {t('priority')}{:else if item.kind === 'run'}{item.data.executions.length}
                {t('executions ·')}
                {item.data.state}{:else}{t('Requirement')}{/if}
            </div>
          </div>
          <span class="row-meta">{new Date(item.updatedAt).toLocaleDateString(intlLocale())}</span
          ><Icon name="arrow" size={15} /></button
        >{:else}<EmptyState
          icon={section === 'cases' ? 'case' : section === 'runs' ? 'run' : 'coverage'}
          title={section === 'cases'
            ? t('A good check is worth keeping')
            : section === 'runs'
              ? t('Give every result a place')
              : t('Know what your testing covers')}
          description={section === 'cases'
            ? t(
                'Save actions, expected results, and data variations. Every run keeps its own frozen copy.',
              )
            : section === 'runs'
              ? t(
                  'Run your saved cases or import results from your existing test tools. Tracefold documents the results locally.',
                )
              : t(
                  'Add requirements and link your test cases. Stale results and untested variations stay visible.',
                )}
          action={section === 'cases'
            ? t('Create a test case')
            : section === 'runs'
              ? t('Start a test run')
              : t('Add a requirement')}
          onclick={() => {
            selectedCases = cases.map((c) => c.id);
            createOpen = true;
          }}
        />{/each}{/if}
  </section>{/if}
<Modal
  bind:open={createOpen}
  title={section === 'cases'
    ? t('A reusable check')
    : section === 'runs'
      ? t('Start a test run')
      : t('Define an expectation')}
  description={section === 'runs'
    ? t('Case steps, data variations, and this environment will be frozen for this run.')
    : t('Start with a clear, specific title.')}
  wide={section === 'runs'}
  ><form
    onsubmit={(e) => {
      e.preventDefault();
      void create();
    }}
  >
    <TextField
      label={t('Title')}
      value={newTitle}
      onchange={(v) => (newTitle = v)}
    />{#if section === 'runs'}<div class="form-grid section-rule">
        <div>
          <h3 style="margin-bottom:14px">{t('Include test cases')}</h3>
          <div class="case-picker">
            {#each cases as c}<label class="check-row"
                ><input
                  type="checkbox"
                  checked={selectedCases.includes(c.id)}
                  onchange={(e) =>
                    (selectedCases = e.currentTarget.checked
                      ? [...selectedCases, c.id]
                      : selectedCases.filter((id) => id !== c.id))}
                />{c.title}</label
              >{:else}<p class="muted small">
                {t('Create cases first, or import results from your test tools.')}
              </p>{/each}
          </div>
        </div>
        <EnvironmentFields value={runEnvironment} onchange={(v) => (runEnvironment = v)} />
      </div>{/if}
    <div class="modal-actions">
      <button class="button" type="button" onclick={() => (createOpen = false)}
        >{t('Cancel')}</button
      ><button
        class="button primary"
        disabled={busy || (section === 'runs' && !selectedCases.length)}
        >{section === 'runs' ? t('Start run') : t('Create')}</button
      >
    </div>
  </form></Modal
>
<Modal
  bind:open={reasonOpen}
  title={t('Reason for {outcome}', { outcome: codeLabel(pendingOutcome) })}
  description={t('Keep the limitation alongside the result.')}
  ><TextField label={t('Reason')} multiline value={reason} onchange={(v) => (reason = v)} />
  <div class="modal-actions">
    <button class="button" onclick={() => (reasonOpen = false)}>{t('Cancel')}</button><button
      class="button primary"
      disabled={!reason.trim()}
      onclick={() => {
        applyOutcome(pendingOutcome, reason, pendingStep);
        reasonOpen = false;
      }}>{t('Save result')}</button
    >
  </div></Modal
>
<Modal
  bind:open={importOpen}
  title={t('Import test results')}
  description={t(
    'Review JUnit XML, CSV, or versioned Tracefold JSON before adding a run. No tests are executed.',
  )}
  wide
  ><div class="form-stack">
    <label class="button"
      ><Icon name="upload" size={16} />{t('Choose results file')}<input
        class="sr-only"
        type="file"
        accept=".xml,.csv,.json"
        onchange={(e) => void readImport(e)}
      /></label
    >{#if importFormat === 'csv' && columns.length}<div class="form-grid">
        <label class="field"
          ><span class="field-label">{t('Case title column')}</span><select
            bind:value={mapping.title}
            onchange={preview}
            >{#each columns as c}<option>{c}</option>{/each}</select
          ></label
        ><label class="field"
          ><span class="field-label">{t('Outcome column')}</span><select
            bind:value={mapping.outcome}
            onchange={preview}
            >{#each columns as c}<option>{c}</option>{/each}</select
          ></label
        ><label class="field"
          ><span class="field-label">{t('Reason column')}</span><select
            bind:value={mapping.reason}
            onchange={preview}
            ><option value={undefined}>{t('Not mapped')}</option>{#each columns as c}<option
                >{c}</option
              >{/each}</select
          ></label
        >
      </div>{/if}{#if importPreview}<p class="muted small">
        {importName} · {importPreview.executions.length}
        {t('results')}
      </p>
      {#if importPreview.duplicate}<label class="check-row"
          ><input type="checkbox" bind:checked={repeat} onchange={preview} />{t(
            'Import this file again as a separate run',
          )}</label
        >{/if}{#each importPreview.issues as issue}<div
          class="notice"
          class:warning={issue.severity === 'error'}
        >
          {issue.message}
        </div>{/each}
      <div class="import-preview table-wrapper">
        <table class="data-table">
          <thead><tr><th>{t('Case')}</th><th>{t('Outcome')}</th><th>{t('Reason')}</th></tr></thead
          ><tbody
            >{#each importPreview.executions.slice(0, 100) as e}<tr
                ><td>{e.caseTitle}</td><td>{t(outcomeLabels[e.outcome])}</td><td>{e.reason}</td></tr
              >{/each}</tbody
          >
        </table>
      </div>
      {#if importPreview.executions.length > 100}<p class="muted small">
          {t('Showing the first 100 results. All')}
          {importPreview.executions.length}
          {t('will be imported.')}
        </p>{/if}{/if}
  </div>
  <div class="modal-actions">
    <button class="button" onclick={() => (importOpen = false)}>{t('Cancel')}</button><button
      class="button primary"
      disabled={busy || !importPreview?.canImport || !importPreview.run}
      onclick={confirmImport}>{t('Import reviewed run')}</button
    >
  </div></Modal
>

<style>
  .case-step {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) 32px;
    gap: 12px;
  }
  .step-number {
    padding-top: 29px;
    color: var(--muted);
  }
  .dataset {
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--panel-radius);
    margin: 12px 0;
    display: grid;
    gap: 12px;
  }
  .run-workbench {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 28px;
  }
  .execution-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .execution-list button {
    text-align: left;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 12px;
    display: grid;
    gap: 6px;
  }
  .execution-list button.active {
    border-color: var(--accent);
    background: var(--selected);
  }
  .execution-list strong {
    font-size: 12px;
    font-weight: 500;
  }
  .execution-list small {
    color: var(--muted);
    font-size: 11px;
  }
  .execution-detail {
    min-width: 0;
  }
  .execution-detail .chosen {
    border-color: var(--accent);
    background: var(--selected);
  }
  .dataset-values {
    padding: 12px;
    background: var(--canvas);
    border-radius: var(--radius);
    margin-top: 12px;
    display: grid;
    gap: 8px;
    font-size: 12px;
  }
  .dataset-values > div {
    display: flex;
    gap: 20px;
  }
  .dataset-values code {
    min-width: 80px;
  }
  .case-picker {
    display: grid;
    gap: 12px;
    max-height: 300px;
    overflow: auto;
  }
  .import-preview {
    max-height: 300px;
  }
  @media (max-width: 1000px) {
    .run-workbench {
      grid-template-columns: minmax(0, 1fr);
    }
    .execution-list {
      flex-direction: row;
      overflow: auto;
      padding-bottom: 12px;
    }
    .execution-list button {
      min-width: 190px;
    }
  }
  @media (max-width: 800px) {
    .case-step .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
