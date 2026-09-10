import hu from './hu.json';

export type Language = 'hu' | 'en';
export type Parameters = Record<string, string | number>;
const messages: Readonly<Record<string, string>> = hu;
export const locale = $state<{ language: Language }>({ language: 'hu' });
export const normalizeLanguage = (value: unknown): Language => (value === 'en' ? 'en' : 'hu');
export function setLanguage(language: Language) {
  locale.language = normalizeLanguage(language);
}
/** Only translate application-owned messages. Never pass user-authored content here. */
export function translate(
  message: string,
  language: Language,
  parameters: Parameters = {},
): string {
  const pattern = language === 'hu' ? (messages[message] ?? message) : message;
  return pattern.replace(/\{(\w+)\}/g, (token, key: string) =>
    Object.hasOwn(parameters, key) ? String(parameters[key]) : token,
  );
}
export function t(message: string, parameters: Parameters = {}): string {
  return translate(message, locale.language, parameters);
}
export const intlLocale = (language: Language = locale.language) =>
  language === 'hu' ? 'hu-HU' : 'en-GB';
export function date(
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
  language: Language = locale.language,
) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat(intlLocale(language), options).format(parsed)
    : '—';
}
export function number(
  value: number,
  options?: Intl.NumberFormatOptions,
  language: Language = locale.language,
) {
  return new Intl.NumberFormat(intlLocale(language), options).format(value);
}
const codes: Record<string, string> = {
  arrow: 'Arrow',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  highlight: 'Highlight',
  redact: 'Redact',
  crop: 'Crop',
  width: 'Width',
  height: 'Height',
  verified: 'Verified',
  unverified: 'Unverified',
  needs_retest: 'Needs retest',
  not_covered: 'Not covered',
  partially_tested: 'Partially tested',
  not_tested: 'Not tested',
  document: 'Document',
  session: 'Session',
  entry: 'Entry',
  finding: 'Finding',
  case: 'Test case',
  run: 'Test run',
  requirement: 'Requirement',
  evidence: 'Evidence',
  template: 'Template',
  open: 'Open',
  in_progress: 'In progress',
  ready_for_retest: 'Ready for retest',
  resolved: 'Resolved',
  deferred: 'Deferred',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  not_run: 'Not run',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  trivial: 'Trivial',
  blocker: 'Blocker',
  cosmetic: 'Cosmetic',
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
  defect: 'Defect',
  improvement: 'Improvement',
  question: 'Question',
  observation: 'Observation',
  idea: 'Idea',
  note: 'Note',
  issue: 'Issue',
  check: 'Check',
  pass: 'Passed check',
  text: 'Text',
  multiline: 'Multiline text',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  select: 'Selection',
  multiselect: 'Multiple selection',
  walkthrough: 'Walkthrough',
  documentation: 'Documentation',
  exploration: 'Exploration',
  regression: 'Regression',
  smoke: 'Smoke',
  accessibility: 'Accessibility',
  performance: 'Performance',
  security: 'Security',
  usability: 'Usability',
  release: 'Release',
  coverage: 'Coverage',
  custom: 'Custom',
};
/** Presentation of stable machine codes; unknown/custom values remain unchanged. */
export function codeLabel(value: string, language: Language = locale.language) {
  return translate(codes[value] ?? value, language);
}
