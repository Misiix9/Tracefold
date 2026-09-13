import { locale, t, translate } from './i18n.svelte';
const messages: Record<string, string> = {
  CONFLICT: 'This item changed. Reload its current revision before saving.',
  NOT_FOUND: 'The requested item does not exist in this project.',
  INTEGRITY:
    'Stored data failed integrity verification. Keep the originals and restore a verified backup.',
  STORAGE_FULL: 'The storage device is full. Free space before retrying.',
  PERMISSION_DENIED: 'Storage access was denied.',
  BUSY: 'Storage is busy. Retry shortly.',
  DATABASE: 'The database operation failed.',
  IO: 'The local storage operation failed. The operation may need recovery before retrying.',
  WORKSPACE_LOCKED:
    'The workspace is already open in another process. Close that copy and try again.',
  CAPTURE_PERMISSION_DENIED:
    'Allow screen recording in system settings, then try again. You can also paste or import an image.',
  CAPTURE_BUSY:
    'A screenshot chooser is already open. Finish or cancel it before starting another capture.',
  CAPTURE_TIMEOUT: 'The screenshot chooser timed out. Start capture again when you are ready.',
  CAPTURE_UNAVAILABLE: 'Screen capture is unavailable. You can paste or import an image.',
  CAPTURE_FAILED: 'Screen capture failed. Try again, or paste or import an image.',
  CAPTURE_INVALID:
    'The screenshot could not be read safely. Try another capture or import an image.',
  DELETED: 'This record is in Trash. Restore it before editing.',
  VALIDATION: 'Review the entered values.',
  INVALID_DATA: 'The data does not match the supported schema.',
  INVALID_REPORT: 'The report or imported package is invalid.',
  LIMIT_EXCEEDED: 'This operation exceeds the supported size limit.',
  UNSUPPORTED_SCHEMA: 'This project uses an unsupported format version.',
  ASSET_NOT_FOUND: 'A required evidence file is missing.',
  STALE_CURSOR: 'Search results changed. Search again to refresh them.',
  CANCELLED: 'The operation was cancelled.',
  PLUGIN_INPUT: 'The plugin package could not be read safely.',
  PLUGIN_INVALID: 'The plugin package or manifest is invalid.',
  PLUGIN_STORAGE: 'Tracefold could not update plugin storage.',
  PLUGIN_RUNTIME: 'The plugin runtime could not start or stop safely.',
  PLUGIN_DISABLED: 'The plugin is disabled. Enable it before opening it.',
  PLUGIN_WINDOW: 'Tracefold could not open the plugin window.',
  CATALOG_NETWORK: 'The plugin catalog could not be reached. Check your connection and try again.',
  CATALOG_INVALID: 'The plugin catalog is invalid or uses an unsupported format.',
  CATALOG_NOT_FOUND: 'That plugin is no longer in the catalog. Refresh the catalog and try again.',
  CATALOG_UNAVAILABLE: 'The plugin catalog is unavailable. Refresh it and try again.',
  CATALOG_INCOMPATIBLE: 'This plugin needs a different Tracefold version.',
  CATALOG_CHECKSUM:
    'The downloaded plugin package failed its checksum check and was not installed.',
};
/** Technical diagnostics are retained when an exact translation is unavailable. */
export function errorText(error: unknown): string {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
  const translated = translate(message, locale.language);
  if (locale.language === 'en' || translated !== message) return translated;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const summary = messages[code];
  if (summary && !['VALIDATION', 'INVALID_REPORT', 'LIMIT_EXCEEDED'].includes(code))
    return t(summary);
  return `${t(summary ?? 'The operation could not be completed.')} ${t('Details')}: ${message}`;
}
