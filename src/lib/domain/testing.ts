import type {
  CaseData,
  Entity,
  Environment,
  Execution,
  FindingData,
  FindingStatus,
  Outcome,
  Retest,
  RunData,
} from './types';

export interface ValidationIssue {
  code: string;
  field: string;
  message: string;
}
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };
export const OUTCOMES: readonly Outcome[] = ['passed', 'failed', 'blocked', 'skipped', 'not_run'];

/** Additional snapshot metadata is persisted alongside the base Execution contract. */
export interface ExecutionSnapshot extends Execution {
  datasetId?: string;
  requirementIds?: string[];
  stepReasons?: Record<string, string>;
}
export interface RunSnapshot extends RunData {
  executions: ExecutionSnapshot[];
}
export interface SnapshotOptions {
  runId: string;
  at: string;
}
export interface Fraction {
  numerator: number;
  denominator: number;
  value: number | null;
}
export interface RunCounts {
  total: number;
  outcomes: Record<Outcome, number>;
  completed: number;
  remaining: number;
  /** Only passed and failed results enter the pass-rate denominator. */
  evaluated: number;
  passRate: Fraction;
  completionRate: Fraction;
}

const copy = <T>(value: T): T => structuredClone(value);
const issue = (code: string, field: string, message: string): ValidationIssue => ({
  code,
  field,
  message,
});
const fail = <T>(...issues: ValidationIssue[]): ValidationResult<T> => ({ ok: false, issues });
const fraction = (numerator: number, denominator: number): Fraction => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});

/** Accept ISO instants with an explicit timezone; never consult the wall clock. */
export function isValidInstant(value: string): boolean {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return false;
  if (
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return false;
  const day = value.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00Z`);
  return (
    Number.isFinite(Date.parse(value)) &&
    Number.isFinite(parsedDay.getTime()) &&
    parsedDay.toISOString().slice(0, 10) === day
  );
}

/** Shared runtime validation for manual outcomes and imported results. */
export function validateOutcome(
  outcome: Outcome,
  reason = '',
  field = 'outcome',
): ValidationIssue[] {
  if (!OUTCOMES.includes(outcome))
    return [
      issue('INVALID_OUTCOME', field, 'Choose passed, failed, blocked, skipped, or not_run.'),
    ];
  if (
    (outcome === 'blocked' || outcome === 'skipped') &&
    (typeof reason !== 'string' || !reason.trim())
  ) {
    return [
      issue(
        'REASON_REQUIRED',
        field.replace(/outcome$/, 'reason'),
        `A ${outcome} result requires a reason.`,
      ),
    ];
  }
  return [];
}

/** One detached execution per case/dataset; no datasets means one execution. IDs are stable within a run. */
export function createExecutionSnapshots(
  cases: readonly Entity<'case'>[],
  options: SnapshotOptions,
): ValidationResult<ExecutionSnapshot[]> {
  const issues: ValidationIssue[] = [];
  if (!options.runId.trim())
    issues.push(
      issue('RUN_ID_REQUIRED', 'runId', 'A run ID is required to identify its executions.'),
    );
  if (!isValidInstant(options.at))
    issues.push(issue('INVALID_TIMESTAMP', 'at', 'Supply a valid ISO timestamp with a timezone.'));
  if (!cases.length) issues.push(issue('EMPTY_RUN', 'cases', 'Select at least one test case.'));
  const caseIds = new Set<string>();
  const projectIds = new Set(cases.map((testCase) => testCase.projectId));
  if (projectIds.size > 1)
    issues.push(issue('PROJECT_MISMATCH', 'cases', 'All cases must belong to one project.'));
  for (const testCase of cases) {
    const field = `cases.${testCase.id}`;
    if (!testCase.id.trim() || caseIds.has(testCase.id))
      issues.push(issue('DUPLICATE_CASE', field, 'Case IDs must be nonempty and unique.'));
    caseIds.add(testCase.id);
    if (testCase.deletedAt)
      issues.push(issue('DELETED_CASE', field, 'Restore the case before adding it to a run.'));
    if (!testCase.title.trim())
      issues.push(issue('TITLE_REQUIRED', `${field}.title`, 'A case title is required.'));
    if (!Number.isSafeInteger(testCase.revision) || testCase.revision < 0)
      issues.push(
        issue(
          'INVALID_REVISION',
          `${field}.revision`,
          'Case revision must be a nonnegative integer.',
        ),
      );
    for (const [name, items] of [
      ['steps', testCase.data.steps],
      ['datasets', testCase.data.datasets],
    ] as const) {
      const seen = new Set<string>();
      for (const item of items) {
        if (!item.id.trim() || seen.has(item.id))
          issues.push(
            issue('DUPLICATE_ID', `${field}.${name}`, `${name} must have unique nonempty IDs.`),
          );
        seen.add(item.id);
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  const executions = cases.flatMap((testCase) => {
    const datasets: (CaseData['datasets'][number] | undefined)[] = testCase.data.datasets.length
      ? testCase.data.datasets
      : [undefined];
    return datasets.map((dataset): ExecutionSnapshot => ({
      id: `${encodeURIComponent(options.runId)}:${encodeURIComponent(testCase.id)}:${dataset ? `dataset:${encodeURIComponent(dataset.id)}` : 'default'}`,
      caseId: testCase.id,
      caseTitle: testCase.title,
      caseRevision: testCase.revision,
      prerequisites: testCase.data.prerequisites,
      steps: copy(testCase.data.steps),
      requirementIds: [...new Set(testCase.data.requirementIds)],
      ...(dataset
        ? { datasetId: dataset.id, dataset: copy({ name: dataset.name, values: dataset.values }) }
        : {}),
      outcome: 'not_run',
      reason: '',
      notes: '',
      stepResults: Object.fromEntries(testCase.data.steps.map((step) => [step.id, 'not_run'])),
      stepReasons: {},
      findingIds: [],
      evidenceIds: [],
      updatedAt: options.at,
    }));
  });
  return { ok: true, value: executions };
}

/** Freeze case, dataset, requirements, and environment values at run creation. */
export function createRunSnapshot(
  cases: readonly Entity<'case'>[],
  environment: Environment,
  options: SnapshotOptions,
): ValidationResult<RunSnapshot> {
  const result = createExecutionSnapshots(cases, options);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      state: 'active',
      ...(cases.some((record) => record.data.private) ? { private: true } : {}),
      environment: copy(environment),
      executions: result.value,
      conclusion: '',
      exclusions: '',
      startedAt: options.at,
    },
  };
}

export interface ExecutionUpdate {
  outcome?: Outcome;
  reason?: string;
  notes?: string;
  durationMs?: number;
  findingIds?: string[];
  evidenceIds?: string[];
}

function validateUpdateTime(previous: string, at: string): ValidationIssue[] {
  if (!isValidInstant(at))
    return [issue('INVALID_TIMESTAMP', 'at', 'Supply a valid ISO timestamp with a timezone.')];
  if (isValidInstant(previous) && Date.parse(at) < Date.parse(previous))
    return [issue('STALE_UPDATE', 'at', 'An update cannot precede the stored result.')];
  return [];
}

/** Validate an execution patch without touching the case snapshot or the input object. */
export function updateExecution(
  execution: ExecutionSnapshot,
  update: ExecutionUpdate,
  at: string,
): ValidationResult<ExecutionSnapshot> {
  const issues = validateUpdateTime(execution.updatedAt, at);
  const allowed = ['outcome', 'reason', 'notes', 'durationMs', 'findingIds', 'evidenceIds'];
  for (const key of Object.keys(update))
    if (!allowed.includes(key))
      issues.push(issue('IMMUTABLE_SNAPSHOT', key, 'Case and dataset snapshots cannot be edited.'));
  for (const key of ['reason', 'notes'] as const)
    if (key in update && typeof update[key] !== 'string')
      issues.push(issue('INVALID_TEXT', key, 'Expected text.'));
  const outcome = update.outcome ?? execution.outcome;
  const reason = update.reason ?? (outcome === execution.outcome ? execution.reason : '');
  issues.push(...validateOutcome(outcome, reason));
  if ('outcome' in update && !OUTCOMES.includes(update.outcome as Outcome))
    issues.push(issue('INVALID_OUTCOME', 'outcome', 'An explicit supported outcome is required.'));
  if (
    'durationMs' in update &&
    (typeof update.durationMs !== 'number' ||
      !Number.isFinite(update.durationMs) ||
      update.durationMs < 0 ||
      update.durationMs > Number.MAX_SAFE_INTEGER)
  ) {
    issues.push(
      issue(
        'INVALID_DURATION',
        'durationMs',
        'Duration must be a finite nonnegative number of milliseconds.',
      ),
    );
  }
  for (const key of ['findingIds', 'evidenceIds'] as const) {
    if (
      key in update &&
      (!Array.isArray(update[key]) ||
        update[key]!.some((id) => typeof id !== 'string' || !id.trim()))
    )
      issues.push(issue('INVALID_IDS', key, 'References must be nonempty IDs.'));
  }
  if (issues.length) return { ok: false, issues };
  const next = { ...copy(execution), ...copy(update), outcome, reason, updatedAt: at };
  next.findingIds = [...new Set(next.findingIds)];
  next.evidenceIds = [...new Set(next.evidenceIds)];
  return { ok: true, value: next };
}

/** Step reasons are stored per step. A step edit does not silently set the overall execution result. */
export function updateStepOutcome(
  execution: ExecutionSnapshot,
  stepId: string,
  outcome: Outcome,
  reason: string,
  at: string,
): ValidationResult<ExecutionSnapshot> {
  const issues = [
    ...validateUpdateTime(execution.updatedAt, at),
    ...validateOutcome(outcome, reason, `steps.${stepId}.outcome`),
  ];
  if (!execution.steps.some((step) => step.id === stepId))
    issues.push(
      issue('UNKNOWN_STEP', 'stepId', 'This step is not part of the execution snapshot.'),
    );
  if (typeof reason !== 'string')
    issues.push(issue('INVALID_TEXT', 'reason', 'Expected a textual reason.'));
  if (issues.length) return { ok: false, issues };
  const next = copy(execution);
  next.stepResults = { ...next.stepResults, [stepId]: outcome };
  next.stepReasons = { ...next.stepReasons, [stepId]: reason };
  next.updatedAt = at;
  return { ok: true, value: next };
}

function editRun(
  run: RunData,
  executionId: string,
  edit: (execution: ExecutionSnapshot) => ValidationResult<ExecutionSnapshot>,
): ValidationResult<RunSnapshot> {
  if (run.state !== 'active')
    return fail(
      issue(
        'RUN_COMPLETED',
        'state',
        'Completed run history is immutable. Create a new run to retest.',
      ),
    );
  const matches = run.executions.filter((execution) => execution.id === executionId);
  if (matches.length !== 1)
    return fail(
      issue('UNKNOWN_EXECUTION', 'executionId', 'Select a unique execution from this run.'),
    );
  const result = edit(matches[0]);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      ...copy(run),
      executions: run.executions.map((execution) =>
        execution.id === executionId ? result.value : copy(execution),
      ),
    },
  };
}

/** Run-scoped outcome update: completed runs are read-only. */
export function updateRunExecution(
  run: RunData,
  executionId: string,
  update: ExecutionUpdate,
  at: string,
): ValidationResult<RunSnapshot> {
  return editRun(run, executionId, (execution) => updateExecution(execution, update, at));
}

/** Run-scoped step update: completed runs are read-only. */
export function updateRunStep(
  run: RunData,
  executionId: string,
  stepId: string,
  outcome: Outcome,
  reason: string,
  at: string,
): ValidationResult<RunSnapshot> {
  return editRun(run, executionId, (execution) =>
    updateStepOutcome(execution, stepId, outcome, reason, at),
  );
}

/** Report every status separately; undefined rates use null, never a misleading 0% or 100%. */
export function getRunCounts(executions: readonly Pick<Execution, 'outcome'>[]): RunCounts {
  const outcomes: Record<Outcome, number> = {
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    not_run: 0,
  };
  for (const execution of executions) {
    if (!OUTCOMES.includes(execution.outcome))
      throw new TypeError(`Invalid execution outcome: ${String(execution.outcome)}`);
    outcomes[execution.outcome]++;
  }
  const total = executions.length;
  const evaluated = outcomes.passed + outcomes.failed;
  const completed = total - outcomes.not_run;
  return {
    total,
    outcomes,
    evaluated,
    completed,
    remaining: outcomes.not_run,
    passRate: fraction(outcomes.passed, evaluated),
    completionRate: fraction(completed, total),
  };
}

export interface CoverageGap {
  code:
    | 'NO_LINKED_CASES'
    | 'NOT_RUN'
    | 'STALE_EXECUTION'
    | 'DATASET_NOT_RUN'
    | 'FAILED'
    | 'BLOCKED'
    | 'SKIPPED';
  message: string;
  caseId?: string;
  executionId?: string;
}
export interface RequirementCoverage {
  requirementId: string;
  title: string;
  caseIds: string[];
  status: 'uncovered' | 'not_run' | 'partial' | 'passed' | 'failed' | 'blocked' | 'skipped';
  counts: RunCounts;
  gaps: CoverageGap[];
}
export interface CoverageReport {
  requirements: RequirementCoverage[];
  /** linked: at least one active case; tested: at least one pass/fail; passed: every current case/dataset passed. */
  linked: Fraction;
  tested: Fraction;
  passed: Fraction;
  orphanLinks: { caseId: string; requirementId: string }[];
}

function sameDataset(
  execution: ExecutionSnapshot,
  dataset: CaseData['datasets'][number] | undefined,
): boolean {
  if (!dataset) return !execution.dataset && !execution.datasetId;
  if (
    !execution.dataset ||
    (execution.datasetId !== undefined && execution.datasetId !== dataset.id)
  )
    return false;
  const values = execution.dataset.values;
  return (
    execution.dataset.name === dataset.name &&
    Object.keys(values).length === Object.keys(dataset.values).length &&
    Object.entries(dataset.values).every(
      ([key, value]) => Object.hasOwn(values, key) && values[key] === value,
    )
  );
}

/** Current coverage uses each current case/dataset's latest run, never a stale revision's pass. */
export function getRequirementsCoverage(
  requirements: readonly Entity<'requirement'>[],
  cases: readonly Entity<'case'>[],
  runs: readonly Entity<'run'>[] = [],
): CoverageReport {
  const activeRequirements = requirements.filter((record) => !record.deletedAt);
  const activeCases = cases.filter((record) => !record.deletedAt);
  const orderedRuns = runs
    .filter((record) => !record.deletedAt)
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.data.startedAt) - Date.parse(a.data.startedAt) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  const rows = activeRequirements.map((requirement): RequirementCoverage => {
    const linked = activeCases.filter(
      (testCase) =>
        testCase.projectId === requirement.projectId &&
        testCase.data.requirementIds.includes(requirement.id),
    );
    const gaps: CoverageGap[] = [];
    const results: Pick<Execution, 'outcome'>[] = [];
    if (!linked.length)
      gaps.push({
        code: 'NO_LINKED_CASES',
        message: 'No active test case is linked to this requirement.',
      });
    for (const testCase of linked) {
      const history = orderedRuns
        .filter((run) => run.projectId === requirement.projectId)
        .flatMap((run) => run.data.executions as ExecutionSnapshot[])
        .filter((execution) => execution.caseId === testCase.id);
      const datasets = testCase.data.datasets.length ? testCase.data.datasets : [undefined];
      for (const dataset of datasets) {
        // Select the newest matching dataset first. An older revision cannot supersede a newer, stale run.
        const latest = history.find((execution) => sameDataset(execution, dataset));
        const execution = latest?.caseRevision === testCase.revision ? latest : undefined;
        if (!execution) {
          results.push({ outcome: 'not_run' });
          gaps.push({
            code: latest ? 'STALE_EXECUTION' : dataset ? 'DATASET_NOT_RUN' : 'NOT_RUN',
            caseId: testCase.id,
            message: latest
              ? `${testCase.title} has no result for revision ${testCase.revision}.`
              : `${testCase.title}${dataset ? ` / ${dataset.name}` : ''} has not been run.`,
          });
          continue;
        }
        results.push(execution);
        if (execution.outcome !== 'passed')
          gaps.push({
            code: execution.outcome.toUpperCase() as CoverageGap['code'],
            caseId: testCase.id,
            executionId: execution.id,
            message: `${testCase.title}${dataset ? ` / ${dataset.name}` : ''}: ${execution.outcome.replace('_', ' ')}${execution.reason ? ` — ${execution.reason}` : '.'}`,
          });
      }
    }
    const counts = getRunCounts(results);
    const status = !linked.length
      ? 'uncovered'
      : counts.outcomes.failed
        ? 'failed'
        : counts.outcomes.blocked
          ? 'blocked'
          : counts.outcomes.passed === counts.total
            ? 'passed'
            : counts.outcomes.not_run === counts.total
              ? 'not_run'
              : counts.outcomes.skipped === counts.total
                ? 'skipped'
                : 'partial';
    return {
      requirementId: requirement.id,
      title: requirement.title,
      caseIds: linked.map((testCase) => testCase.id),
      status,
      counts,
      gaps,
    };
  });
  return {
    requirements: rows,
    linked: fraction(rows.filter((row) => row.caseIds.length).length, rows.length),
    tested: fraction(rows.filter((row) => row.counts.evaluated > 0).length, rows.length),
    passed: fraction(rows.filter((row) => row.status === 'passed').length, rows.length),
    orphanLinks: activeCases.flatMap((testCase) =>
      [...new Set(testCase.data.requirementIds)]
        .filter(
          (id) =>
            !activeRequirements.some(
              (requirement) =>
                requirement.id === id && requirement.projectId === testCase.projectId,
            ),
        )
        .map((requirementId) => ({ caseId: testCase.id, requirementId })),
    ),
  };
}

/** Append immutable retest evidence; original reproduction, environment, resolution and status are preserved. */
export function appendFindingRetest(
  finding: FindingData,
  retest: Retest,
): ValidationResult<FindingData> {
  const issues = validateOutcome(retest.outcome, retest.notes, 'retest.outcome');
  if (retest.outcome === 'not_run')
    issues.push(
      issue('RETEST_NOT_RUN', 'retest.outcome', 'A retest must record an actual outcome.'),
    );
  if (!retest.id.trim() || finding.retests.some((previous) => previous.id === retest.id))
    issues.push(issue('DUPLICATE_RETEST', 'retest.id', 'Retest IDs must be nonempty and unique.'));
  if (!isValidInstant(retest.at))
    issues.push(
      issue('INVALID_TIMESTAMP', 'retest.at', 'Supply a valid ISO timestamp with a timezone.'),
    );
  if (finding.retests.some((previous) => Date.parse(previous.at) > Date.parse(retest.at)))
    issues.push(issue('STALE_RETEST', 'retest.at', 'Append retests in chronological order.'));
  if (
    !Array.isArray(retest.evidenceIds) ||
    retest.evidenceIds.some((id) => typeof id !== 'string' || !id.trim())
  )
    issues.push(
      issue('INVALID_IDS', 'retest.evidenceIds', 'Evidence references must be nonempty IDs.'),
    );
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      ...copy(finding),
      retests: [
        ...copy(finding.retests),
        { ...copy(retest), evidenceIds: [...new Set(retest.evidenceIds)] },
      ],
    },
  };
}

/** A resolution is verified only when the most recent retest passed. No inferred pass from skipped/blocked. */
export function getFindingVerification(
  finding: FindingData,
): 'unresolved' | 'unverified' | 'verified' {
  if (finding.status !== 'resolved') return 'unresolved';
  const latest = finding.retests.reduce<Retest | undefined>(
    (result, retest) =>
      !result || Date.parse(retest.at) >= Date.parse(result.at) ? retest : result,
    undefined,
  );
  return latest?.outcome === 'passed' ? 'verified' : 'unverified';
}

/** Lifecycle changes preserve the original finding and all retests. Unverified resolutions remain explicit. */
export function transitionFinding(
  finding: FindingData,
  status: FindingStatus,
  resolution = finding.resolution,
): ValidationResult<FindingData> {
  if (
    !(
      ['open', 'in_progress', 'ready_for_retest', 'resolved', 'deferred'] as FindingStatus[]
    ).includes(status)
  )
    return fail(issue('INVALID_STATUS', 'status', 'Choose a supported finding status.'));
  if (status === 'resolved' && !resolution.trim())
    return fail(
      issue(
        'RESOLUTION_REQUIRED',
        'resolution',
        'Describe the resolution, even when it has not been verified.',
      ),
    );
  return { ok: true, value: { ...copy(finding), status, resolution } };
}
