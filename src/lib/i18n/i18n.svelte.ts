import hu from './hu.json';

export type Language = 'hu' | 'en';
export type Parameters = Record<string, string | number>;
const pluginMessages: Readonly<Record<string, string>> = {
  EXTENSIONS: 'BŐVÍTMÉNYEK',
  Plugins: 'Bővítmények',
  'Extend Tracefold without turning the core into one giant application.':
    'Bővítsd a Tracefoldot anélkül, hogy a mag egyetlen óriási alkalmazássá válna.',
  'Install plugin package': 'Bővítménycsomag telepítése',
  Dismiss: 'Bezárás',
  Installed: 'Telepítve',
  '{count} installed plugin.': '{count} telepített bővítmény.',
  '{count} installed plugins.': '{count} telepített bővítmény.',
  'No plugins installed': 'Nincs telepített bővítmény',
  'Install a verified or locally reviewed Tracefold plugin package to extend the workspace.':
    'Telepíts ellenőrzött vagy helyileg átvizsgált Tracefold bővítménycsomagot a munkaterület kibővítéséhez.',
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
  'Only real packages appear as installable plugins. Planned tools stay clearly marked.':
    'Csak valódi csomagok jelennek meg telepíthető bővítményként. A tervezett eszközök egyértelműen meg vannak jelölve.',
  Planned: 'Tervezett',
  'Plugin safety': 'Bővítménybiztonság',
  'Plugins are trusted local code. They run as your OS user and are not sandboxed by Tracefold.':
    'A bővítmények megbízható helyi kódnak számítanak. A te operációs rendszerbeli felhasználód jogosultságaival futnak, és a Tracefold nem sandboxolja őket.',
  'The host keeps plugin web runtimes on 127.0.0.1, stores plugin data outside installed code, and validates package paths and size limits.':
    'A host a bővítmények webes futtatókörnyezetét a 127.0.0.1 címre korlátozza, a bővítményadatokat a telepített kódon kívül tárolja, és ellenőrzi a csomagútvonalakat és méretkorlátokat.',
  'Capabilities are declared for transparency, but this beta does not enforce them as an OS permission boundary.':
    'A képességek átláthatóság miatt deklarálva vannak, de ez a béta még nem érvényesíti őket operációs rendszer szintű jogosultsági határként.',
  'Desktop-only plugin runtime': 'A bővítmény-futtatókörnyezet csak asztali módban érhető el',
  'Plugins require the Tracefold desktop app because they run as trusted local processes and open native plugin windows.':
    'A bővítményekhez a Tracefold asztali alkalmazása szükséges, mert megbízható helyi folyamatként futnak és natív bővítményablakokat nyitnak.',
  'Browser preview keeps plugin commands disabled so it never attempts to call native-only APIs.':
    'A böngészős előnézet letiltja a bővítményparancsokat, ezért nem próbál natív API-kat meghívni.',
  'The plugin package exceeds the 256 MiB limit.':
    'A bővítménycsomag meghaladja a 256 MiB-os korlátot.',
  'A plugin file exceeds the 64 MiB limit.': 'Egy bővítményfájl meghaladja a 64 MiB-os korlátot.',
  'The unpacked plugin package exceeds the 128 MiB limit.':
    'A kicsomagolt bővítménycsomag meghaladja a 128 MiB-os korlátot.',
  'The plugin package is empty.': 'A bővítménycsomag üres.',
  'The plugin package exceeds the supported file or size limits.':
    'A bővítménycsomag túllépi a támogatott fájl- vagy méretkorlátokat.',
  'The plugin package could not be read safely.': 'A bővítménycsomag nem olvasható biztonságosan.',
  'The plugin package or manifest is invalid.': 'A bővítménycsomag vagy a manifest érvénytelen.',
  'Tracefold could not update plugin storage.':
    'A Tracefold nem tudta frissíteni a bővítménytárolót.',
  'The plugin runtime could not start or stop safely.':
    'A bővítmény futtatókörnyezete nem indítható vagy állítható le biztonságosan.',
  'The plugin is disabled. Enable it before opening it.':
    'A bővítmény le van tiltva. Megnyitás előtt engedélyezd.',
  'Tracefold could not open the plugin window.':
    'A Tracefold nem tudta megnyitni a bővítményablakot.',
  '{name} {version} installed.': '{name} {version} telepítve.',
  'Remove {name}? This stops the plugin and deletes its installed code. Persistent plugin data is kept.':
    'Eltávolítod ezt: {name}? Ez leállítja a bővítményt és törli a telepített kódját. A tartós bővítményadatok megmaradnak.',
  'Install from file': 'Telepítés fájlból',
  'Browse plugins': 'Bővítmények böngészése',
  Browse: 'Böngészés',
  'Search plugins': 'Bővítmények keresése',
  Category: 'Kategória',
  'All categories': 'Összes kategória',
  Refresh: 'Frissítés',
  'Refreshing…': 'Frissítés…',
  'Loading the plugin catalog…': 'Bővítménykatalógus betöltése…',
  'No plugins match': 'Nincs találat',
  'Try a different search term or category.': 'Próbálj másik keresőkifejezést vagy kategóriát.',
  Install: 'Telepítés',
  'Installing…': 'Telepítés…',
  Reinstall: 'Újratelepítés',
  Update: 'Frissítés',
  'Update to {version}': 'Frissítés erre: {version}',
  'Installed version: {version}': 'Telepített verzió: {version}',
  'Requests these capabilities': 'Ezeket a képességeket kéri',
  'This plugin is not compatible with this Tracefold version.':
    'Ez a bővítmény nem kompatibilis ezzel a Tracefold verzióval.',
  'Every package is checked against the SHA-256 recorded in the catalog before it is installed.':
    'Minden csomagot a katalógusban rögzített SHA-256 ellenőrzőösszeggel vetünk össze a telepítés előtt.',
  'Catalog updated {when}.': 'Katalógus frissítve: {when}.',
  'The catalog is downloaded over HTTPS. Installed plugins keep working offline.':
    'A katalógus HTTPS-en keresztül töltődik le. A telepített bővítmények offline is működnek tovább.',
  'Browse the Tracefold plugin catalog, or install a plugin package you reviewed yourself.':
    'Böngészd a Tracefold bővítménykatalógust, vagy telepíts egy általad átvizsgált bővítménycsomagot.',
  'Starting…': 'Indítás…',
  'Back to plugins': 'Vissza a bővítményekhez',
  Reload: 'Újratöltés',
  'Open in a window': 'Megnyitás külön ablakban',
  'This plugin runs as a local process on 127.0.0.1 and is displayed inside Tracefold.':
    'Ez a bővítmény helyi folyamatként fut a 127.0.0.1 címen, és a Tracefoldon belül jelenik meg.',
  'The plugin catalog could not be reached. Check your connection and try again.':
    'A bővítménykatalógus nem érhető el. Ellenőrizd a kapcsolatot, és próbáld újra.',
  'The plugin catalog is invalid or uses an unsupported format.':
    'A bővítménykatalógus érvénytelen vagy nem támogatott formátumú.',
  'That plugin is no longer in the catalog. Refresh the catalog and try again.':
    'Ez a bővítmény már nincs a katalógusban. Frissítsd a katalógust, és próbáld újra.',
  'The plugin catalog is unavailable. Refresh it and try again.':
    'A bővítménykatalógus nem érhető el. Frissítsd, és próbáld újra.',
  'This plugin needs a different Tracefold version.':
    'Ehhez a bővítményhez másik Tracefold verzió szükséges.',
  'The downloaded plugin package failed its checksum check and was not installed.':
    'A letöltött bővítménycsomag nem felelt meg az ellenőrzőösszeg-vizsgálatnak, ezért nem lett telepítve.',
  'The downloaded plugin package does not match the checksum in the catalog. It was not installed.':
    'A letöltött bővítménycsomag nem egyezik a katalógusban szereplő ellenőrzőösszeggel. Nem lett telepítve.',
  'The downloaded package does not match the catalog entry it came from. It was not installed.':
    'A letöltött csomag nem egyezik azzal a katalógusbejegyzéssel, ahonnan származik. Nem lett telepítve.',
  'Refresh the plugin catalog before installing.':
    'Telepítés előtt frissítsd a bővítménykatalógust.',
  'Preparing update…': 'Frissítés előkészítése…',
  'Restart to update': 'Újraindítás a frissítéshez',
  'Version {version} is ready and installs when you restart.':
    'A(z) {version} verzió készen áll, és újraindításkor települ.',
  'Downloading the update in the background…': 'A frissítés letöltése a háttérben…',
  'The update is downloaded and installs when you restart Tracefold.':
    'A frissítés letöltve, és a Tracefold újraindításakor települ.',
  'Tracefold checks for updates on its own and downloads them quietly in the background.':
    'A Tracefold magától keres frissítéseket, és csendben, a háttérben tölti le őket.',
  'Last checked {when}.': 'Utolsó ellenőrzés: {when}.',
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
