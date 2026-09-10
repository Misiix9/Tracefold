import type { Entity, RichDocument, TemplateData, TemplateField } from './types';
import type { ValidationIssue, ValidationResult } from './testing';
import { translate, type Language } from '../i18n/i18n.svelte';

export interface BuiltInTemplate {
  id: string;
  title: string;
  tags: string[];
  data: TemplateData;
}
const field = (
  id: string,
  label: string,
  type: TemplateField['type'] = 'text',
  required = false,
  options?: string[],
): TemplateField => ({ id, label, type, required, ...(options ? { options } : {}) });
const section = (id: string, title: string, guidance: string) => ({ id, title, guidance });
const environment = () => ({
  build: '',
  platform: '',
  browser: '',
  device: '',
  locale: '',
  extra: {},
});
const caseDefaults = (folder: string, steps: [string, string][], priority = 'normal') => ({
  prerequisites: '',
  steps: steps.map(([action, expected], index) => ({ id: `step-${index + 1}`, action, expected })),
  folder,
  requirementIds: [],
  datasets: [],
  priority,
  automated: false,
});
const documentDefaults = (category: string) => ({
  category,
  evidenceIds: [],
  private: false,
  fields: {},
});
const template = (
  id: string,
  title: string,
  targetKind: TemplateData['targetKind'],
  icon: string,
  description: string,
  fields: TemplateField[],
  sections: TemplateData['sections'],
  defaults: Record<string, unknown>,
): BuiltInTemplate => ({
  id: `builtin:${id}`,
  title,
  tags: ['built-in', id],
  data: { targetKind, description, icon, builtIn: true, fields, sections, defaults },
});

const definitions: BuiltInTemplate[] = [
  template(
    'walkthrough',
    'Product walkthrough',
    'document',
    'book-open',
    'Document a product flow with its context, observations, and evidence. Useful before a formal case library exists.',
    [
      field('audience', 'Audience'),
      field('journey', 'User journey', 'text', true),
      field('build', 'Build'),
      field('environment', 'Environment', 'multiline'),
      field('reviewedOn', 'Reviewed on', 'date'),
    ],
    [
      section(
        'purpose',
        'Purpose and reader',
        'Explain the task this walkthrough helps the reader understand and the intended audience.',
      ),
      section(
        'setup',
        'Setup and prerequisites',
        'Record account role, starting state, build, environment, permissions, and test data. Exclude credentials.',
      ),
      section(
        'journey',
        'Walkthrough',
        'For each action, describe what the user does, what appears, and why it matters. Add captioned evidence beside the relevant step.',
      ),
      section(
        'alternatives',
        'Alternative paths and recovery',
        'Describe empty, error, cancellation, interrupted, and recovery paths. Distinguish observed behavior from assumptions.',
      ),
      section(
        'observations',
        'Observations and questions',
        'Separate observed facts, open questions, and proposed improvements. Link findings without duplicating investigation history.',
      ),
      section(
        'scope',
        'Scope and exclusions',
        'State what was reviewed and what remains unverified, with reasons and follow-up links.',
      ),
    ],
    documentDefaults('walkthrough'),
  ),
  template(
    'documentation',
    'Technical documentation',
    'document',
    'file-text',
    'A structured reference for behavior, interfaces, decisions, and operational guidance.',
    [
      field('subject', 'Subject', 'text', true),
      field('owner', 'Local owner'),
      field('documentType', 'Document type', 'select', false, [
        'Reference',
        'How-to',
        'Decision',
        'Investigation',
      ]),
      field('reviewDate', 'Review date', 'date'),
    ],
    [
      section(
        'summary',
        'Purpose and scope',
        'Describe the problem, intended reader, and boundaries of this document.',
      ),
      section(
        'behavior',
        'Behavior and terminology',
        'Define terms, inputs, outputs, constraints, and user-visible states. Link authoritative local references.',
      ),
      section(
        'procedure',
        'Procedure or contract',
        'Write ordered instructions or an interface contract, including prerequisites and expected outcomes.',
      ),
      section(
        'examples',
        'Examples and evidence',
        'Include representative tables, code, and captioned evidence. Remove secrets and personal data.',
      ),
      section(
        'decisions',
        'Decisions and alternatives',
        'Record the decision, rationale, tradeoffs, and conditions that would trigger reconsideration.',
      ),
      section(
        'unknowns',
        'Limitations and open questions',
        'Identify unsupported scenarios, unresolved questions, owners, and verification needed.',
      ),
    ],
    documentDefaults('documentation'),
  ),
  template(
    'exploratory',
    'Exploratory session',
    'session',
    'compass',
    'A timeboxed charter that preserves investigation chronology, focus coverage, and unanswered questions.',
    [
      field('charter', 'Charter', 'multiline', true),
      field('timeboxMinutes', 'Timebox in minutes', 'number', true),
      field('tester', 'Tester label'),
      field('risk', 'Primary risk', 'multiline'),
      field('build', 'Build'),
    ],
    [
      section(
        'charter',
        'Charter',
        'Explore a named area using a strategy to discover a specific class of risk. State the timebox.',
      ),
      section(
        'setup',
        'Starting conditions',
        'Record environment, build, data, role, constraints, and known issues before exploration.',
      ),
      section(
        'focus',
        'Focus areas and heuristics',
        'List risky boundaries, state transitions, interruptions, negative paths, and accessibility considerations. Mark only areas actually explored.',
      ),
      section(
        'chronology',
        'Investigation chronology',
        'Capture observations, passes, issues, questions, and ideas in order. Preserve source entries when promoting findings or cases.',
      ),
      section(
        'hypotheses',
        'Hypotheses and experiments',
        'Separate suspected causes from verified causes and record the experiment and evidence for each conclusion.',
      ),
      section(
        'debrief',
        'Conclusion and remaining risk',
        'Summarize discoveries, findings, learning, untested areas, exclusions, and next charters. Do not infer a quality score.',
      ),
    ],
    {
      charter: '',
      state: 'active',
      environment: environment(),
      focusAreas: [
        { text: 'Core user journey', checked: false },
        { text: 'Error and recovery paths', checked: false },
        { text: 'Boundaries and interruptions', checked: false },
      ],
      conclusion: '',
      exclusions: '',
      durationSeconds: 0,
    },
  ),
  template(
    'bug',
    'Bug investigation',
    'finding',
    'bug',
    'A reproducible finding with explicit impact, original evidence, cause confidence, and a retest trail.',
    [
      field('component', 'Component', 'text', true),
      field('frequency', 'Reproduction frequency'),
      field('severity', 'Severity', 'select', true, [
        'blocker',
        'critical',
        'major',
        'minor',
        'trivial',
      ]),
      field('priority', 'Priority', 'select', false, ['urgent', 'high', 'normal', 'low']),
      field('owner', 'Local owner'),
      field('duplicateOf', 'Duplicate of finding ID'),
    ],
    [
      section(
        'problem',
        'Problem and impact',
        'Describe what is wrong, who is affected, and the consequence. Keep severity separate from scheduling priority.',
      ),
      section(
        'reproduction',
        'Reproduction',
        'Record prerequisites and ordered steps, expected behavior, actual behavior, and frequency. Capture the original environment and build.',
      ),
      section(
        'evidence',
        'Original evidence',
        'Attach captioned screenshots or log references showing the original failure. Keep sanitized and original evidence relationships intact.',
      ),
      section(
        'investigation',
        'Suspected and confirmed causes',
        'Label each hypothesis as suspected until an experiment supports it. Record confirmed cause separately with evidence.',
      ),
      section(
        'relationships',
        'Related cases and findings',
        'Link failing executions, affected requirements, related findings, and duplicate references. Repeated failures should reuse this finding.',
      ),
      section(
        'mitigation',
        'Workaround and resolution',
        'Describe temporary mitigation separately from the fix. A claimed resolution remains unverified until a passing retest.',
      ),
      section(
        'retests',
        'Retest history',
        'Append a new environment, outcome, notes, and evidence for each retest. Never replace the original reproduction or failure evidence.',
      ),
    ],
    {
      code: '',
      status: 'open',
      severity: 'major',
      priority: 'normal',
      type: 'defect',
      steps: [''],
      expected: '',
      actual: '',
      impact: '',
      environment: environment(),
      frequency: '',
      suspectedCause: '',
      confirmedCause: '',
      workaround: '',
      resolution: '',
      relatedIds: [],
      evidenceIds: [],
      caseIds: [],
      retests: [],
      owner: '',
      component: '',
    },
  ),
  template(
    'retest',
    'Finding retest comparison',
    'document',
    'repeat',
    'Compare an original failure with a new verification attempt without rewriting the original finding.',
    [
      field('findingId', 'Original finding ID', 'text', true),
      field('originalBuild', 'Original build'),
      field('retestBuild', 'Retest build', 'text', true),
      field('outcome', 'Retest outcome', 'select', true, [
        'passed',
        'failed',
        'blocked',
        'skipped',
      ]),
      field('reason', 'Blocked or skipped reason', 'multiline'),
    ],
    [
      section(
        'original',
        'Original failure reference',
        'Link the original finding and its exact reproduction, expected result, actual result, and evidence. Preserve that record.',
      ),
      section(
        'changes',
        'Fix and environment changes',
        'Record the claimed fix, new build, environment, data, and any difference from the original conditions.',
      ),
      section(
        'verification',
        'Retest execution',
        'Repeat the original steps and record the actual observations. Record a reason if blocked or skipped.',
      ),
      section(
        'comparison',
        'Evidence comparison',
        'Place original and retest evidence references side by side. Describe the observed difference without replacing either asset.',
      ),
      section(
        'regression',
        'Adjacent regression checks',
        'Identify related behaviors checked after the fix and their individual results. State exclusions.',
      ),
      section(
        'decision',
        'Outcome and lifecycle decision',
        'Append this attempt to retest history. Distinguish a verified resolution, a failed retest requiring reopening, and an unverified resolution.',
      ),
    ],
    documentDefaults('retest'),
  ),
  template(
    'case',
    'Structured test case',
    'case',
    'list-checks',
    'A reusable case with prerequisites, ordered expected results, datasets, and requirement links.',
    [
      field('objective', 'Test objective', 'text', true),
      field('risk', 'Risk addressed', 'multiline'),
      field('priority', 'Priority', 'select', false, ['high', 'normal', 'low']),
      field('dataNotes', 'Dataset notes', 'multiline'),
    ],
    [
      section(
        'purpose',
        'Objective and requirement links',
        'Describe one verifiable behavior and link its requirements or acceptance criteria.',
      ),
      section(
        'prerequisites',
        'Prerequisites',
        'Specify role, state, permissions, build constraints, and setup needed before the first step.',
      ),
      section(
        'steps',
        'Actions and expected results',
        'Write atomic ordered actions with an observable expected result for each action.',
      ),
      section(
        'datasets',
        'Datasets and boundaries',
        'Define named value sets, including representative and boundary inputs. Runs create a separate frozen execution for each dataset.',
      ),
      section(
        'cleanup',
        'Cleanup and independence',
        'Describe how to return data and state to a safe baseline. Avoid hidden dependencies on another case.',
      ),
      section(
        'execution',
        'Execution guidance',
        'Use step results and an explicit overall outcome. Blocked and skipped results require a reason; link recurring failures to the same finding.',
      ),
    ],
    caseDefaults('Functional', [
      ['Prepare the documented prerequisites.', 'The required starting state is available.'],
      [
        'Perform the behavior under test with the selected dataset.',
        'The specified observable result matches the acceptance criteria.',
      ],
      [
        'Check the resulting state and clean up.',
        'The expected state is retained and test data is safely reset.',
      ],
    ]),
  ),
  template(
    'smoke',
    'Build smoke check',
    'case',
    'flame',
    'A small critical-path check of whether a build is usable for further testing.',
    [
      field('build', 'Candidate build', 'text', true),
      field('platform', 'Platform'),
      field('criticalJourney', 'Critical journey', 'text', true),
      field('entryCriteria', 'Entry criteria', 'multiline'),
    ],
    [
      section(
        'scope',
        'Smoke scope',
        'List the minimal critical journeys and installation or launch conditions that gate further testing.',
      ),
      section(
        'setup',
        'Build and starting state',
        'Record the exact artifact, environment, account role, data, and known limitations.',
      ),
      section(
        'checks',
        'Critical-path checks',
        'Check launch, access to the main workflow, one representative operation, persistence, and recovery from a normal restart.',
      ),
      section(
        'result',
        'Disposition',
        'Record each result and blocker evidence. State whether deeper testing can proceed, with explicit exclusions.',
      ),
    ],
    caseDefaults(
      'Smoke',
      [
        [
          'Install or open the candidate build.',
          'The application launches to a usable starting state.',
        ],
        [
          'Complete the documented critical journey.',
          'The core operation completes and its result is visible.',
        ],
        [
          'Restart and inspect the saved result.',
          'Expected data remains available without a blocking error.',
        ],
      ],
      'high',
    ),
  ),
  template(
    'regression',
    'Risk-based regression case',
    'case',
    'git-compare',
    'Protect established behavior around a change using explicit affected areas and representative datasets.',
    [
      field('change', 'Change under review', 'multiline', true),
      field('baselineBuild', 'Baseline build'),
      field('candidateBuild', 'Candidate build'),
      field('affectedAreas', 'Affected areas', 'multiline', true),
      field('riskLevel', 'Risk level', 'select', false, ['High', 'Medium', 'Low']),
    ],
    [
      section(
        'change',
        'Change and impact analysis',
        'Describe the change, shared components, dependencies, and existing behavior at risk.',
      ),
      section(
        'baseline',
        'Expected baseline',
        'Link the requirement, prior case revision, or verified behavior that defines the expected result.',
      ),
      section(
        'matrix',
        'Regression matrix',
        'List supported environments and datasets selected by risk, including important boundaries and failure recovery.',
      ),
      section(
        'checks',
        'Regression checks',
        'Cover the changed path and adjacent unchanged behavior. Keep expected results explicit for every step.',
      ),
      section(
        'results',
        'Results and recurring failures',
        'Link runs and existing findings. Compare evidence with the baseline while retaining the earlier execution snapshots.',
      ),
      section(
        'exclusions',
        'Exclusions and residual risk',
        'Name omitted configurations and checks, explain why, and identify required follow-up.',
      ),
    ],
    caseDefaults('Regression', [
      [
        'Establish the documented baseline and dataset.',
        'The starting conditions match the intended regression scenario.',
      ],
      ['Exercise the changed behavior.', 'The change meets its acceptance criteria.'],
      [
        'Exercise the affected adjacent behavior.',
        'Previously supported behavior still produces the documented result.',
      ],
      ['Verify persistence and recovery.', 'No unintended state change or data loss occurs.'],
    ]),
  ),
  template(
    'uat',
    'User acceptance testing',
    'document',
    'users',
    'Business-facing acceptance evidence organized around real tasks and explicit approval conditions.',
    [
      field('businessGoal', 'Business goal', 'multiline', true),
      field('persona', 'User role', 'text', true),
      field('stakeholder', 'Acceptance owner label'),
      field('targetDate', 'Acceptance date', 'date'),
      field('decision', 'Decision', 'select', false, [
        'Pending',
        'Accepted',
        'Accepted with conditions',
        'Rejected',
      ]),
    ],
    [
      section(
        'objective',
        'Business objective and scope',
        'State the real-world outcome, intended users, business rules, and excluded processes.',
      ),
      section(
        'criteria',
        'Acceptance criteria',
        'List measurable acceptance criteria and link requirements. Name who can make the acceptance decision.',
      ),
      section(
        'scenarios',
        'User scenarios',
        'Describe realistic end-to-end tasks using representative roles and data. Include alternate and exception paths.',
      ),
      section(
        'environment',
        'Acceptance environment',
        'Record build, configuration, integrations represented by supplied evidence, and any differences from intended use.',
      ),
      section(
        'evidence',
        'Execution and evidence',
        'Link each scenario to results and captioned evidence. Show passed, failed, blocked, skipped, and not-run counts with denominators.',
      ),
      section(
        'gaps',
        'Open issues and conditions',
        'List acceptance blockers, workarounds, uncovered criteria, and any proposed conditions with owners.',
      ),
      section(
        'decision',
        'Acceptance decision',
        'Record the decision, rationale, date, and local stakeholder label. A label is not an authenticated signature.',
      ),
    ],
    documentDefaults('uat'),
  ),
  template(
    'accessibility',
    'Accessibility review',
    'document',
    'accessibility',
    'Evidence-led accessibility checks with criterion references, assistive technology context, and explicit limitations.',
    [
      field('scope', 'Pages and flows', 'multiline', true),
      field('standard', 'Standard and version'),
      field('targetLevel', 'Target level', 'select', false, ['A', 'AA', 'AAA', 'Other']),
      field('assistiveTechnology', 'Assistive technology and version', 'multiline'),
      field('inputMethods', 'Input methods', 'multiselect', false, [
        'Keyboard',
        'Screen reader',
        'Touch',
        'Switch',
        'Voice',
        'Pointer',
      ]),
    ],
    [
      section(
        'scope',
        'Scope, criteria, and environment',
        'Record the evaluated flows, applicable criterion references, build, OS, browser, and assistive technology versions.',
      ),
      section(
        'keyboard',
        'Keyboard and focus',
        'Check complete operation, focus order, visible focus, traps, modal behavior, shortcuts, and return focus after dismissal.',
      ),
      section(
        'semantics',
        'Semantics and screen readers',
        'Inspect names, roles, values, headings, landmarks, reading order, labels, instructions, and status announcements.',
      ),
      section(
        'visual',
        'Vision, zoom, and contrast',
        'Check text and non-text contrast, 200% zoom, text resizing, reflow, color independence, themes, and forced-color behavior where relevant.',
      ),
      section(
        'interaction',
        'Motion and interaction',
        'Check reduced motion, timing controls, touch targets, gestures, dragging alternatives, error identification, and recovery.',
      ),
      section(
        'media',
        'Content and media',
        'Review alternative text, evidence captions, meaningful link text, captions/transcripts, and document or table structure.',
      ),
      section(
        'findings',
        'Findings and evidence',
        'For each finding record affected users, criterion, reproduction, observed impact, evidence, and a verification method.',
      ),
      section(
        'limitations',
        'Coverage and limitations',
        'List untested criteria, environments, and flows. Tool output alone does not establish conformance.',
      ),
    ],
    documentDefaults('accessibility'),
  ),
  template(
    'api',
    'API and backend verification',
    'document',
    'braces',
    'Document contracts and supplied API/backend results. This template does not send requests or execute processes.',
    [
      field('service', 'Service or component', 'text', true),
      field('contractVersion', 'Contract version'),
      field('operation', 'Operation and method', 'text', true),
      field('authRole', 'Authorization role'),
      field('environment', 'Environment'),
      field('source', 'Result source'),
    ],
    [
      section(
        'contract',
        'Contract and business rules',
        'Record operation, request/response schema, required fields, status codes, error shapes, and acceptance criteria.',
      ),
      section(
        'authorization',
        'Authentication and authorization',
        'Document supplied evidence for permitted, denied, missing, expired, and cross-scope access. Never include live credentials.',
      ),
      section(
        'inputs',
        'Inputs and validation',
        'Cover boundaries, absent/null fields, malformed values, encoding, duplicates, pagination, sorting, and input size limits.',
      ),
      section(
        'state',
        'State and consistency',
        'Record transactional behavior, idempotency, retries, concurrency, duplicate delivery, ordering, and rollback expectations.',
      ),
      section(
        'errors',
        'Failure and recovery',
        'Review supplied results for unavailable dependencies, timeouts, rate limits, partial failure, and error disclosure.',
      ),
      section(
        'evidence',
        'Supplied results and evidence',
        'Attach sanitized request/response examples, imported automated results, logs, timestamps, and correlation references. Attribute the result source.',
      ),
      section(
        'gaps',
        'Coverage and unresolved risks',
        'Link requirements and cases. State untested operations and conditions, open findings, and needed verification.',
      ),
    ],
    documentDefaults('api'),
  ),
  template(
    'performance',
    'Performance investigation',
    'document',
    'gauge',
    'Record reproducible measurements and compare them with declared budgets, without inventing benchmark results.',
    [
      field('scenario', 'Measured scenario', 'text', true),
      field('build', 'Build', 'text', true),
      field('hardware', 'Hardware and OS', 'multiline', true),
      field('sampleCount', 'Sample count', 'number'),
      field('load', 'Workload and data size', 'multiline'),
      field('measurementSource', 'Measurement source'),
    ],
    [
      section(
        'goal',
        'Question and budgets',
        'Define the user-visible scenario, metric, units, acceptance budget, and the decision this measurement supports.',
      ),
      section(
        'setup',
        'Reproducible conditions',
        'Record hardware, OS, build mode, power state, background activity, data volume, configuration, and instrumentation overhead.',
      ),
      section(
        'method',
        'Measurement method',
        'Describe supplied tool output, warmup, cold versus warm conditions, repetitions, sampling intervals, and how percentiles are calculated.',
      ),
      section(
        'measurements',
        'Observed measurements',
        'Report samples, median and p95 where supported, memory, CPU, throughput, and latency with units and denominators. Leave unavailable metrics unmeasured.',
      ),
      section(
        'comparison',
        'Baseline and comparison',
        'Compare equivalent conditions against a prior baseline and budget. Identify variance, outliers, and confidence limitations.',
      ),
      section(
        'investigation',
        'Hypotheses and evidence',
        'Separate suspected bottlenecks from confirmed causes. Link profiles, traces, logs, and experiments.',
      ),
      section(
        'followup',
        'Conclusion and follow-up',
        'State observed budget failures, remaining unknowns, mitigation candidates, and the next measurement needed.',
      ),
    ],
    documentDefaults('performance'),
  ),
  template(
    'mobile',
    'Mobile testing',
    'document',
    'smartphone',
    'A device-focused review of lifecycle, connectivity, permissions, ergonomics, and persistence.',
    [
      field('build', 'App build', 'text', true),
      field('devices', 'Device and OS matrix', 'multiline', true),
      field('distribution', 'Install source'),
      field('orientations', 'Orientations', 'multiselect', false, [
        'Portrait',
        'Landscape',
        'Folded',
        'Unfolded',
      ]),
      field('network', 'Connectivity conditions', 'multiline'),
    ],
    [
      section(
        'matrix',
        'Device and installation matrix',
        'Record real devices versus simulators, OS versions, fresh install, upgrade, storage conditions, and supported form factors.',
      ),
      section(
        'lifecycle',
        'Lifecycle and interruptions',
        'Check background/foreground transitions, process termination, calls, notifications, lock/unlock, and restoration of unfinished work.',
      ),
      section(
        'permissions',
        'Permissions and privacy',
        'Check first-use prompts, denial, revocation, limited access, permission changes, and sensitive-data visibility.',
      ),
      section(
        'connectivity',
        'Connectivity and offline recovery',
        'Exercise available supplied scenarios for offline use, intermittent connections, switching networks, and retry behavior without duplicating actions.',
      ),
      section(
        'interaction',
        'Input, layout, and accessibility',
        'Review keyboards, safe areas, rotation, large text, screen readers, touch targets, gestures, and one-handed reach.',
      ),
      section(
        'resources',
        'Resources and data integrity',
        'Record observed memory, battery, thermal, storage, interrupted saves, and upgrade persistence issues with device context.',
      ),
      section(
        'summary',
        'Findings and matrix gaps',
        'Link results and evidence by configuration. Name untested devices, OS versions, lifecycle paths, and follow-up.',
      ),
    ],
    documentDefaults('mobile'),
  ),
  template(
    'game',
    'Game testing session',
    'session',
    'gamepad-2',
    'Explore gameplay, progression, controls, stability, and state recovery while preserving the play-session chronology.',
    [
      field('build', 'Game build', 'text', true),
      field('level', 'Level or scenario', 'text', true),
      field('saveState', 'Starting save state'),
      field('input', 'Input device'),
      field('mode', 'Play mode', 'select', false, [
        'Single player',
        'Local multiplayer',
        'Online results review',
      ]),
      field('timeboxMinutes', 'Timebox in minutes', 'number'),
    ],
    [
      section(
        'charter',
        'Play-session charter',
        'State the mechanic, progression path, level, or stability risk being explored and the timebox.',
      ),
      section(
        'setup',
        'Build and starting state',
        'Record platform, hardware, input device, difficulty, settings, save state, seed when available, and supplied network conditions.',
      ),
      section(
        'mechanics',
        'Mechanics and controls',
        'Check input mapping, remapping, responsiveness, camera, collision, physics, pause behavior, and unusual action sequences.',
      ),
      section(
        'progression',
        'Progression and economy',
        'Inspect objectives, rewards, inventory, unlocks, checkpoints, save/load, failure/retry, and potential progression blockers.',
      ),
      section(
        'presentation',
        'Presentation and accessibility',
        'Observe animation, audio, subtitles, readability, color cues, motion options, localization, and assistive settings.',
      ),
      section(
        'stability',
        'Stability and recovery',
        'Record crashes, hangs, frame pacing observations, loading, interruptions, disconnects, and recovery without inventing performance measurements.',
      ),
      section(
        'chronology',
        'Play chronology and reproduction',
        'Log events in order with timestamps, seeds, inputs, video references, and the smallest repeatable failure sequence.',
      ),
      section(
        'debrief',
        'Debrief and coverage gaps',
        'Summarize observed risks, findings, unvisited areas, untested configurations, and next-session charters.',
      ),
    ],
    {
      charter: '',
      state: 'active',
      environment: environment(),
      focusAreas: [
        { text: 'Mechanics and controls', checked: false },
        { text: 'Progression and save recovery', checked: false },
        { text: 'Presentation and stability', checked: false },
      ],
      conclusion: '',
      exclusions: '',
      durationSeconds: 0,
    },
  ),
  template(
    'localization',
    'Localization review',
    'document',
    'languages',
    'Verify language, regional formatting, layout, and input behavior with explicit locale coverage.',
    [
      field('sourceLocale', 'Source locale'),
      field('targetLocales', 'Target locales', 'multiline', true),
      field('build', 'Build'),
      field('reviewer', 'Language reviewer label'),
      field('direction', 'Text directions', 'multiselect', false, [
        'Left-to-right',
        'Right-to-left',
        'Mixed',
      ]),
    ],
    [
      section(
        'scope',
        'Locale and content scope',
        'List target languages and regions, reviewed flows, source revision, and language-review ownership.',
      ),
      section(
        'language',
        'Language and terminology',
        'Review meaning, grammar, tone, terminology, untranslated strings, context, pluralization, and variable interpolation.',
      ),
      section(
        'layout',
        'Layout and direction',
        'Check text expansion, truncation, wrapping, alignment, RTL mirroring, mixed-direction text, icons, and font glyph coverage.',
      ),
      section(
        'formats',
        'Regional formats',
        'Verify dates, time zones, numbers, decimal/group separators, currency, units, addresses, names, and sorting using explicit examples.',
      ),
      section(
        'input',
        'Input and locale switching',
        'Check Unicode, composed characters, input methods, search, pasted content, locale switching, and fallback behavior.',
      ),
      section(
        'evidence',
        'Evidence and linguistic findings',
        'Capture source and target text, locale, screen/context, expected correction, severity, and supporting evidence.',
      ),
      section(
        'gaps',
        'Coverage and exclusions',
        'State the reviewed locale/flow denominator, missing translations, unreviewed content, and configuration gaps.',
      ),
    ],
    documentDefaults('localization'),
  ),
  template(
    'compatibility',
    'Compatibility matrix',
    'document',
    'monitor',
    'Record behavior across supported configurations and show explicit matrix gaps.',
    [
      field('feature', 'Feature or journey', 'text', true),
      field('build', 'Build', 'text', true),
      field('platforms', 'Platform and version matrix', 'multiline', true),
      field('inputModes', 'Input modes', 'multiline'),
      field('displayModes', 'Display and theme modes', 'multiline'),
    ],
    [
      section(
        'support',
        'Support contract',
        'List configurations actually claimed as supported and the representative scenarios to verify on each.',
      ),
      section(
        'matrix',
        'Configuration matrix',
        'Include OS/browser versions, architecture, device/display scale, input method, theme, locale, and assistive technology where relevant.',
      ),
      section(
        'behavior',
        'Behavior and rendering checks',
        'Review primary flows, layout, fonts, scrolling, keyboard behavior, files, dialogs, clipboard, and platform-specific integrations.',
      ),
      section(
        'results',
        'Results by configuration',
        'Link each matrix cell to a run or supplied evidence. Preserve failed, blocked, skipped, and not-run distinctions.',
      ),
      section(
        'differences',
        'Differences and workarounds',
        'Record expected platform differences separately from defects. Link workarounds and affected versions.',
      ),
      section(
        'gaps',
        'Untested configurations',
        'Show tested over planned configurations with a denominator. Explain gaps and avoid claiming untested platform support.',
      ),
    ],
    documentDefaults('compatibility'),
  ),
  template(
    'release',
    'Release readiness summary',
    'document',
    'flag',
    'A report-ready release decision grounded in evidence, open findings, coverage, and unresolved risk.',
    [
      field('release', 'Release identifier', 'text', true),
      field('build', 'Candidate build', 'text', true),
      field('decisionDate', 'Decision date', 'date'),
      field('decisionOwner', 'Decision owner label'),
      field('recommendation', 'Recommendation', 'select', false, [
        'Pending',
        'Proceed',
        'Proceed with conditions',
        'Hold',
      ]),
      field('rollbackReviewed', 'Rollback reviewed', 'checkbox'),
    ],
    [
      section(
        'candidate',
        'Candidate and scope',
        'Identify the exact build, change scope, supported platforms, test window, and release acceptance criteria.',
      ),
      section(
        'evidence',
        'Test evidence and counts',
        'Summarize runs, sessions, and supplied automated results. Show every status with total counts; calculate pass rate only over passed plus failed.',
      ),
      section(
        'coverage',
        'Requirement coverage and gaps',
        'Report linked, tested, and passed requirements with denominators. List uncovered requirements, stale case revisions, and unexecuted datasets.',
      ),
      section(
        'findings',
        'Open findings and retests',
        'List blockers, severity and priority, owners, workarounds, and retest outcomes. Label resolutions without passing verification as unverified.',
      ),
      section(
        'nonfunctional',
        'Specialist and platform evidence',
        'Link accessibility, performance, security-related supplied evidence, localization, compatibility, installation, and recovery checks. State what remains unvalidated.',
      ),
      section(
        'operations',
        'Release and recovery readiness',
        'Reference artifact validation, configuration, upgrade/data safety, backup/recovery evidence, and the reviewed rollback procedure.',
      ),
      section(
        'risk',
        'Residual risk and exclusions',
        'Explain omitted scenarios, blocked tests, assumptions, accepted risks, conditions, and accountable local owner labels.',
      ),
      section(
        'decision',
        'Recommendation and decision',
        'Record the evidence-based recommendation, conditions, owner label, and date. Avoid synthetic quality scores and unsupported platform claims.',
      ),
    ],
    documentDefaults('release'),
  ),
];

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Immutable specialist definitions. Use getBuiltInTemplates for editable, project-scoped copies. */
export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = freeze(definitions);

/** Deterministic project-scoped template records; callers supply the timestamp when persisting them. */
export function getBuiltInTemplates(
  projectId: string,
  at = '1970-01-01T00:00:00.000Z',
  language: Language = 'en',
): Entity<'template'>[] {
  return BUILT_IN_TEMPLATES.map((definition) => {
    const t = (text: string) => translate(text, language);
    const data = structuredClone(definition.data);
    data.description = t(data.description);
    data.fields = data.fields.map((field) => ({
      ...field,
      label: t(field.label),
      ...(field.options
        ? { options: field.options.map((option) => (/^[A-Z]/.test(option) ? t(option) : option)) }
        : {}),
    }));
    data.sections = data.sections.map((section) => ({
      ...section,
      title: t(section.title),
      guidance: t(section.guidance),
    }));
    for (const key of ['folder', 'charter'])
      if (typeof data.defaults[key] === 'string')
        data.defaults[key] = t(data.defaults[key] as string);
    if (Array.isArray(data.defaults.steps))
      data.defaults.steps = data.defaults.steps.map((step) =>
        typeof step === 'string'
          ? t(step)
          : { ...step, action: t(step.action), expected: t(step.expected) },
      );
    if (Array.isArray(data.defaults.focusAreas))
      data.defaults.focusAreas = data.defaults.focusAreas.map((area) => ({
        ...area,
        text: t(area.text),
      }));
    return {
      id: definition.id,
      projectId,
      kind: 'template',
      title: t(definition.title),
      body: templateBody(data),
      tags: [...definition.tags],
      data,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
  });
}

/** Rich text uses text nodes only. Guidance cannot inject executable markup. */
export function templateBody(template: TemplateData): RichDocument {
  return {
    type: 'doc',
    content: template.sections.flatMap((section) => [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: section.title }] },
      { type: 'paragraph', content: [{ type: 'text', text: section.guidance }] },
    ]),
  };
}

/** Validate script-free typed custom fields. Required false/zero values are present, not empty. */
export function validateTemplateValues(
  template: TemplateData,
  values: Record<string, unknown>,
): ValidationResult<Record<string, unknown>> {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const add = (code: string, field: string, message: string) =>
    issues.push({ code, field, message });
  for (const field of template.fields) {
    if (
      !field.id.trim() ||
      ids.has(field.id) ||
      ['__proto__', 'prototype', 'constructor'].includes(field.id)
    )
      add('INVALID_FIELD_ID', field.id, 'Template field IDs must be safe, nonempty, and unique.');
    ids.add(field.id);
    if (
      !['text', 'multiline', 'number', 'date', 'checkbox', 'select', 'multiselect'].includes(
        field.type,
      )
    )
      add('INVALID_FIELD_TYPE', field.id, 'Only supported script-free field types are allowed.');
    if (
      ['select', 'multiselect'].includes(field.type) &&
      (!field.options?.length || new Set(field.options).size !== field.options.length)
    )
      add('INVALID_OPTIONS', field.id, 'Selection fields require unique options.');
    const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && !value.trim()) ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required) add('REQUIRED_FIELD', field.id, `${field.label} is required.`);
      continue;
    }
    let valid = true;
    switch (field.type) {
      case 'text':
      case 'multiline':
        valid = typeof value === 'string';
        break;
      case 'number':
        valid = typeof value === 'number' && Number.isFinite(value);
        break;
      case 'checkbox':
        valid = typeof value === 'boolean';
        break;
      case 'date': {
        const date =
          typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
            ? new Date(`${value}T00:00:00Z`)
            : undefined;
        valid =
          !!date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
        break;
      }
      case 'select':
        valid = typeof value === 'string' && !!field.options?.includes(value);
        break;
      case 'multiselect':
        valid =
          Array.isArray(value) &&
          value.every((option) => typeof option === 'string' && field.options?.includes(option)) &&
          new Set(value).size === value.length;
        break;
      default:
        valid = false;
    }
    if (!valid)
      add(
        'INVALID_FIELD_VALUE',
        field.id,
        `${field.label} must match its ${field.type} field definition.`,
      );
  }
  for (const key of Object.keys(values))
    if (!ids.has(key)) add('UNKNOWN_FIELD', key, 'This field is not defined by the template.');
  return issues.length ? { ok: false, issues } : { ok: true, value: structuredClone(values) };
}
