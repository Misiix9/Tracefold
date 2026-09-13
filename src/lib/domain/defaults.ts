import type { AppSettings, DataMap, Entity, EntityKind, Environment, RichDocument } from './types';
export const emptyDoc = (): RichDocument => ({ type: 'doc', content: [{ type: 'paragraph' }] });
export const textDoc = (text: string): RichDocument => ({
  type: 'doc',
  content: text
    .split('\n')
    .map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
});
export function plainText(node: RichDocument | undefined): string {
  if (!node) return '';
  if (node.text) return node.text;
  if (node.type === 'hardBreak') return '\n';
  const blockParents = new Set([
    'doc',
    'bulletList',
    'orderedList',
    'taskList',
    'listItem',
    'taskItem',
    'blockquote',
    'table',
  ]);
  const separator = node.type === 'tableRow' ? '\t' : blockParents.has(node.type) ? '\n' : '';
  return (node.content ?? []).map(plainText).join(separator);
}
export const emptyEnvironment = (): Environment => ({
  build: '',
  platform: '',
  browser: '',
  device: '',
  locale: '',
  extra: {},
});
export const defaultSettings: AppSettings = {
  language: 'hu',
  theme: 'system',
  density: 'comfortable',
  editorFontSize: 15,
  lastProjectId: null,
  lastView: 'notebook',
  onboardingComplete: false,
  author: '',
  pageSize: 'A4',
  backupEnabled: true,
  autoUpdate: true,
  autoUpdatePlugins: true,
  updateCheckSeconds: 60,
  pluginCheckSeconds: 900,
  shortcuts: {},
};
export const newId = () => crypto.randomUUID();
export function createEntity<K extends EntityKind>(
  projectId: string,
  kind: K,
  title: string,
  data: DataMap[K],
  body = emptyDoc(),
): Entity<K> {
  const at = new Date().toISOString();
  return {
    id: newId(),
    projectId,
    kind,
    title,
    body,
    tags: [],
    data,
    revision: 0,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}
export function defaultData<K extends EntityKind>(kind: K): DataMap[K] {
  const map: DataMap = {
    document: { evidenceIds: [], private: false },
    session: {
      charter: '',
      state: 'active',
      startedAt: new Date().toISOString(),
      activeSince: new Date().toISOString(),
      environment: emptyEnvironment(),
      focusAreas: [],
      conclusion: '',
      exclusions: '',
      durationSeconds: 0,
    },
    entry: {
      sessionId: '',
      category: 'observation',
      expected: '',
      actual: '',
      evidenceIds: [],
      private: false,
    },
    finding: {
      code: '',
      status: 'open',
      severity: 'major',
      priority: 'normal',
      type: 'defect',
      steps: [''],
      expected: '',
      actual: '',
      impact: '',
      environment: emptyEnvironment(),
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
    case: {
      prerequisites: '',
      steps: [{ id: newId(), action: '', expected: '' }],
      folder: '',
      requirementIds: [],
      datasets: [],
      priority: 'normal',
      automated: false,
    },
    run: {
      state: 'active',
      environment: emptyEnvironment(),
      executions: [],
      conclusion: '',
      exclusions: '',
      startedAt: new Date().toISOString(),
    },
    requirement: {
      code: '',
      description: '',
      acceptanceCriteria: '',
      priority: 'normal',
      owner: '',
    },
    evidence: {
      assetId: '',
      filename: '',
      mimeType: '',
      size: 0,
      hash: '',
      caption: '',
      annotations: [],
      private: false,
      source: 'import',
    },
    template: {
      targetKind: 'document',
      description: '',
      icon: 'file',
      builtIn: false,
      fields: [],
      sections: [],
      defaults: {},
    },
  };
  return map[kind];
}
export const outcomeLabels = {
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  not_run: 'Not run',
};
export const statusLabels = {
  open: 'Open',
  in_progress: 'In progress',
  ready_for_retest: 'Ready for retest',
  resolved: 'Resolved',
  deferred: 'Deferred',
};
