import type { ReportOptions, ReportSnapshot as WorkspaceSnapshot } from '../../domain/types';

export type ReportFormat = ReportOptions['format'];
export type ReportPreset = 'finding' | 'walkthrough' | 'session' | 'run' | 'coverage' | 'release';
export interface SnapshotOptions extends ReportOptions {
  /** Frozen presentation language. Absent in older packages: render their original English labels. */
  language?: 'hu' | 'en';
  audience?: string;
  build?: string;
  preset?: ReportPreset;
}
export interface ReportAsset {
  mimeType: 'image/png' | 'text/plain';
  bytes: Uint8Array;
  filename: string;
  hash: string;
  size: number;
  width?: number;
  height?: number;
}
/** IDs are package-local aliases, never workspace IDs. All content is public and history-free. */
export interface ReportSnapshot extends WorkspaceSnapshot {
  kind: 'tracefold-report';
  options: SnapshotOptions;
  assets: Record<string, ReportAsset>;
}
export interface ExportFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface ReportOutput extends ExportFile {
  attachments: ExportFile[];
  warnings: string[];
}
export class ReportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}
export function requireThat(
  value: unknown,
  message: string,
  code = 'INVALID_REPORT',
): asserts value {
  if (!value) throw new ReportError(code, message);
}
export const REPORT_LIMITS = Object.freeze({
  records: 10_000,
  assets: 1_000,
  assetBytes: 32 * 1024 * 1024,
  totalAssetBytes: 128 * 1024 * 1024,
  jsonBytes: 24 * 1024 * 1024,
  nodes: 200_000,
  depth: 32,
  textLength: 1_000_000,
  imagePixels: 16_000_000,
  imageDimension: 8192,
});
