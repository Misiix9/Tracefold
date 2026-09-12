import hu from './hu.json';

export type Language = 'hu' | 'en';
export type Parameters = Record<string, string | number>;
const pluginMessages: Readonly<Record<string, string>> = {
  EXTENSIONS: 'BŐVÍTMÉNYEK',
  Plugins: 'Bővítmények',
  'Extend Tracefold without turning the core into one giant application.': 'Bővítsd a Tracefoldot anélkül, hogy a mag egyetlen óriási alkalmazássá válna.',
  'Install plugin package': 'Bővítménycsomag telepítése',
  Dismiss: 'Bezárás',
  Installed: 'Telepítve',
  '{count} installed plugin.': '{count} telepített bővítmény.',
  '{count} installed plugins.': '{count} telepített bővítmény.',
  'No plugins installed': 'Nincs telepített bővítmény',
  'Install a verified or locally reviewed Tracefold plugin package to extend the workspace.': 'Telepíts ellenőrzött vagy helyileg átvizsgált Tracefold bővítménycsomagot a munkaterület kibővítéséhez.',
  Running: 'Fut',
  Enabled: 'Engedélyezve',
  Disabled: 'Letiltva',
  'No description provided.': 'Nincs leírás megadva.',
  'API {version}': 'API {version}',
  Open: 'Megnyitás',
  Stop: 'Leállítás',
  Disable: 'Letiltás',
  Enable: 'Engedélyezés',
  'Remove {name}': '{name} eltávolítása',
  'Plugin roadmap': 'Bővítmény ütemterv',
  'Only real packages appear as installable plugins. Planned tools stay clearly marked.': 'Csak valódi csomagok jelennek meg telepíthető bővítményként. A tervezett eszközök egyértelműen meg vannak jelölve.',
  Planned: 'Tervezett',
  'Plugin safety': 'Bővítménybiztonság',
  'Plugins are trusted local code. They run as your OS user and are not sandboxed by Tracefold.': 'A bővítmények megbízható helyi kódnak számítanak. A te operációs rendszerbeli felhasználód jogosultságaival futnak, és a Tracefold nem sandboxolja őket.',
  'The host keeps plugin web runtimes on 127.0.0.1, stores plugin data outside installed code, and validates package paths and size limits.': 'A host a bővítmények webes futtatókörnyezetét a 127.0.0.1 címre korlátozza, a bővítményadatokat a telepített kódon kívül tárolja, és ellenőrzi a csomagútvonalakat és méretkorlátokat.',
  'Capabilities are declared for transparency, but this beta does not enforce them as an OS permission boundary.': 'A képességek átláthatóság miatt deklarálva vannak, de ez a béta még nem érvényesíti őket operációs rendszer szintű jogosultsági határként.',
  'Desktop-only plugin runtime': 'A bővítmény-futtatókörnyezet csak asztali módban érhető el',
  'Plugins require the Tracefold desktop app because they run as trusted local processes and open native plugin windows.': 'A bővítményekhez a Tracefold asztali alkalmazása szükséges, mert megbízható helyi folyamatként futnak és natív bővítményablakokat nyitnak.',
  'Browser preview keeps plugin commands disabled so it never attempts to call native-only APIs.': 'A böngészős előnézet letiltja a bővítményparancsokat, ezért nem próbál natív API-kat meghívni.',
  'The plugin package exceeds the 256 MiB limit.': 'A bővítménycsomag meghaladja a 256 MiB-os korlátot.',
  'A plugin file exceeds the 64 MiB limit.': 'Egy bővítményfájl meghaladja a 64 MiB-os korlátot.',
  'The unpacked plugin package exceeds the 128 MiB limit.': 'A kicsomagolt bővítménycsomag meghaladja a 128 MiB-os korlátot.',
  'The plugin package is empty.': 'A bővítménycsomag üres.',
  'The plugin package exceeds the supported file or size limits.': 'A bővítménycsomag túllépi a támogatott fájl- vagy méretkorlátokat.',
  '{name} {version} installed.': '{name} {version} telepítve.',
  'Remove {name}? This stops the plugin and deletes its installed code. Persistent plugin data is kept.': 'Eltávolítod ezt: {name}? Ez leállítja a bővítményt és törli a telepített kódját. A tartós bővítményadatok megmaradnak.',
  'API Workbench': 'API Workbench',
  'BOLA & authorization': 'BOLA és jogosultságkezelés',
  'Browser automation': 'Böngésző-automatizálás',
  'API contracts': 'API-szerződések',
  'GraphQL & WebSocket': 'GraphQL és WebSocket',
  'Security toolkit': 'Biztonsági eszköztár',
  'Accessibility & performance': 'Akadálymentesítés és teljesítmény',
  'CI & reporting': 'CI és riportok',
  'Tracefold Assistant': 'Tracefold Assistant',
};
const messages: Readonly<Record<string, string>> = { ...hu, ...pluginMessages };
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
