import type { AnyEntity, Project } from '../../domain/types';
import { newId } from '../../domain/defaults';
import type { ProjectImport, WorkspaceRepository } from '../repository';
import { crc32, decodeUtf8, fromBase64, inflateBounded } from '../reports/binary';
import { object } from '../reports/schema';
import { remapReferences, validateReportSnapshot } from '../reports/snapshot';
import { REPORT_LIMITS, requireThat } from '../reports/types';
import type { ReportSnapshot } from '../reports/types';
const MAX_ARCHIVE = 160 * 1024 * 1024;
/** Parse before allocation. ZIP64, encryption, links, duplicate names and undeclared bytes are rejected. */
export function readPackageZip(input: Uint8Array): Map<string, Uint8Array> {
  requireThat(input.length >= 22 && input.length <= MAX_ARCHIVE, 'Package size is unsupported');
  const v = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let end = -1;
  for (let p = input.length - 22; p >= Math.max(0, input.length - 65557); p--)
    if (
      v.getUint32(p, true) === 0x06054b50 &&
      p + 22 + v.getUint16(p + 20, true) === input.length
    ) {
      end = p;
      break;
    }
  requireThat(end >= 0, 'Missing ZIP directory');
  requireThat(
    v.getUint16(end + 4, true) === 0 && v.getUint16(end + 6, true) === 0,
    'Split archives are unsupported',
  );
  const count = v.getUint16(end + 10, true),
    directorySize = v.getUint32(end + 12, true),
    directoryOffset = v.getUint32(end + 16, true);
  requireThat(
    count > 0 &&
      count <= REPORT_LIMITS.assets + 1 &&
      count === v.getUint16(end + 8, true) &&
      directoryOffset + directorySize === end,
    'Invalid ZIP directory',
  );
  const files = new Map<string, Uint8Array>(),
    names = new Set<string>(),
    ranges: { start: number; end: number }[] = [];
  let at = directoryOffset,
    total = 0;
  for (let i = 0; i < count; i++) {
    requireThat(at + 46 <= end && v.getUint32(at, true) === 0x02014b50, 'Invalid ZIP entry');
    const flags = v.getUint16(at + 8, true),
      method = v.getUint16(at + 10, true),
      crc = v.getUint32(at + 16, true),
      compressed = v.getUint32(at + 20, true),
      size = v.getUint32(at + 24, true),
      nameLength = v.getUint16(at + 28, true),
      extraLength = v.getUint16(at + 30, true),
      commentLength = v.getUint16(at + 32, true),
      local = v.getUint32(at + 42, true),
      mode = v.getUint32(at + 38, true) >>> 16;
    requireThat(
      !(flags & ~0x808) && [0, 8].includes(method) && v.getUint16(at + 34, true) === 0,
      'Encrypted or unsupported ZIP entry',
    );
    requireThat(
      (mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000,
      'ZIP links and special files are unsupported',
    );
    requireThat(at + 46 + nameLength + extraLength + commentLength <= end, 'Truncated ZIP name');
    const name = decodeUtf8(input.subarray(at + 46, at + 46 + nameLength));
    requireThat(
      name === 'manifest.json' || /^assets\/[a-f0-9]{64}\.(png|txt)$/.test(name),
      'Unexpected package path',
    );
    requireThat(!names.has(name.toLowerCase()), 'Duplicate package path');
    names.add(name.toLowerCase());
    requireThat(
      size <= (name === 'manifest.json' ? REPORT_LIMITS.jsonBytes : REPORT_LIMITS.assetBytes),
      'Package entry is too large',
    );
    total += size;
    requireThat(
      total <= REPORT_LIMITS.totalAssetBytes + REPORT_LIMITS.jsonBytes,
      'Expanded package is too large',
    );
    requireThat(
      local + 30 <= directoryOffset && v.getUint32(local, true) === 0x04034b50,
      'Invalid local ZIP entry',
    );
    const localNameLength = v.getUint16(local + 26, true),
      localExtraLength = v.getUint16(local + 28, true),
      dataStart = local + 30 + localNameLength + localExtraLength;
    requireThat(
      v.getUint16(local + 6, true) === flags &&
        v.getUint16(local + 8, true) === method &&
        dataStart + compressed <= directoryOffset,
      'ZIP header mismatch',
    );
    requireThat(
      decodeUtf8(input.subarray(local + 30, local + 30 + localNameLength)) === name,
      'ZIP path mismatch',
    );
    if (!(flags & 8))
      requireThat(
        v.getUint32(local + 14, true) === crc &&
          v.getUint32(local + 18, true) === compressed &&
          v.getUint32(local + 22, true) === size,
        'ZIP size mismatch',
      );
    let dataEnd = dataStart + compressed;
    if (flags & 8) {
      const descriptor = dataEnd + (v.getUint32(dataEnd, true) === 0x08074b50 ? 4 : 0);
      requireThat(
        descriptor + 12 <= directoryOffset &&
          v.getUint32(descriptor, true) === crc &&
          v.getUint32(descriptor + 4, true) === compressed &&
          v.getUint32(descriptor + 8, true) === size,
        'ZIP descriptor mismatch',
      );
      dataEnd = descriptor + 12;
    }
    ranges.push({ start: local, end: dataEnd });
    const compressedBytes = input.subarray(dataStart, dataStart + compressed);
    const bytes =
      method === 0 ? new Uint8Array(compressedBytes) : inflateBounded(compressedBytes, size);
    requireThat(bytes.length === size && crc32(bytes) === crc, 'Package checksum mismatch');
    files.set(name, bytes);
    at += 46 + nameLength + extraLength + commentLength;
  }
  requireThat(at === end, 'Unexpected ZIP directory data');
  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const range of ranges) {
    requireThat(range.start === cursor, 'Overlapping or hidden ZIP entries');
    cursor = range.end;
  }
  requireThat(cursor === directoryOffset, 'Hidden ZIP payload');
  return files;
}
export async function previewProjectFile(
  bytes: Uint8Array,
  filename: string,
): Promise<ReportSnapshot> {
  let manifest: Record<string, unknown>;
  let files: Map<string, Uint8Array> | undefined;
  if (filename.toLowerCase().endsWith('.tracefold')) {
    files = readPackageZip(bytes);
    const raw = files.get('manifest.json');
    requireThat(raw, 'Missing package manifest');
    manifest = object(JSON.parse(decodeUtf8(raw)));
    requireThat(manifest.kind === 'tracefold-package', 'Unsupported package format');
    manifest.kind = 'tracefold-report';
  } else {
    requireThat(bytes.length <= REPORT_LIMITS.jsonBytes, 'JSON import exceeds 24 MiB');
    manifest = object(JSON.parse(decodeUtf8(bytes)));
    requireThat(
      manifest.kind === 'tracefold-report',
      'This JSON is not a Tracefold project export',
    );
  }
  const assets = object(manifest.assets);
  requireThat(Object.keys(assets).length <= REPORT_LIMITS.assets, 'Too many evidence files');
  let total = 0;
  const rebuilt = Object.fromEntries(
    Object.entries(assets).map(([hash, value]) => {
      const a = object(value);
      const data = files
        ? files.get(String(a.filename))
        : fromBase64(String(a.bytes), REPORT_LIMITS.assetBytes);
      requireThat(data, 'Missing package evidence');
      total += data.length;
      requireThat(total <= REPORT_LIMITS.totalAssetBytes, 'Evidence resource limit exceeded');
      return [hash, { ...a, bytes: data }];
    }),
  );
  if (files)
    requireThat(files.size === Object.keys(assets).length + 1, 'Unreferenced package files');
  return validateReportSnapshot({ ...manifest, assets: rebuilt });
}
export function prepareProjectImport(
  snapshot: ReportSnapshot,
  mode: WorkspaceRepository['mode'],
): ProjectImport {
  const id = newId(),
    at = new Date().toISOString();
  const project: Project = {
    ...snapshot.project,
    id,
    name: `${snapshot.project.name} · imported`,
    createdAt: at,
    updatedAt: at,
    revision: 0,
  };
  const map = new Map(snapshot.records.map((r) => [r.id, newId()]));
  const assets = Object.values(snapshot.assets).map((a) => ({
    asset: {
      id: a.hash,
      hash: a.hash,
      filename: a.filename.split('/').at(-1)!,
      mimeType: a.mimeType,
      size: a.size,
      width: a.width,
      height: a.height,
    },
    bytes: new Uint8Array(a.bytes),
  }));
  const records = snapshot.records.map((record) => {
    const r = remapReferences(record, map);
    r.id = map.get(record.id)!;
    r.projectId = id;
    r.revision = 0;
    if (r.kind === 'evidence') {
      const assetId = mode === 'browser' ? id + ':' + r.data.hash : r.data.hash;
      r.data.assetId = assetId;
      r.data.sanitizedAssetId = assetId;
      r.data.filename = r.data.filename.split('/').at(-1)!;
    }
    if (r.kind === 'run')
      r.data.executions.forEach((execution, i) => {
        const original = record.kind === 'run' ? record.data.executions[i] : undefined;
        const sourceCase = snapshot.records.find((c) => c.id === original?.caseId);
        execution.caseRevision = sourceCase?.revision === original?.caseRevision ? 1 : 0;
      });
    return r;
  }) as AnyEntity[];
  return { project, records, assets, sourceProjectId: snapshot.project.id };
}
