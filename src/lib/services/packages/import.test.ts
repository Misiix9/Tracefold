import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { createEntity, defaultData } from '../../domain/defaults';
import type { Project } from '../../domain/types';
import { assembleReportSnapshot } from '../reports/snapshot';
import { packageBytes, portableJson } from '../reports/export';
import { utf8 } from '../reports/binary';
import { prepareProjectImport, previewProjectFile, readPackageZip } from './import';
const at = '2026-09-09T12:00:00.000Z';
const project: Project = {
  id: crypto.randomUUID(),
  name: 'Import fixture',
  description: '',
  prefix: 'QA',
  color: '#783D49',
  createdAt: at,
  updatedAt: at,
  revision: 1,
  archived: false,
};
async function fixture() {
  const record = createEntity(project.id, 'document', 'Public note', defaultData('document'));
  record.revision = 3;
  return assembleReportSnapshot({
    project,
    records: [record],
    options: {
      format: 'json',
      title: 'Transfer',
      author: '',
      pageSize: 'A4',
      includeEvidence: false,
      includePrivate: false,
      includeHistory: false,
      scope: 'project',
      entityIds: [],
    },
    generatedAt: at,
    readAsset: async () => {
      throw new Error('Unexpected asset');
    },
  });
}
describe('portable project boundary', () => {
  it('round trips the actual package exporter with fresh identities', async () => {
    const snapshot = await fixture();
    const bytes = packageBytes(snapshot);
    const preview = await previewProjectFile(bytes, 'fixture.tracefold');
    const first = prepareProjectImport(preview, 'desktop'),
      second = prepareProjectImport(preview, 'desktop');
    expect(first.project.id).not.toBe(second.project.id);
    expect(first.records[0].id).not.toBe(second.records[0].id);
    expect(first.records[0].title).toBe('Public note');
    expect(first.records[0].projectId).toBe(first.project.id);
    expect(first.records[0].revision).toBe(0);
  });
  it('accepts versioned JSON from the same sanitized exporter', async () => {
    const snapshot = await fixture();
    const imported = await previewProjectFile(
      utf8(JSON.stringify(portableJson(snapshot))),
      'fixture.json',
    );
    expect(imported.records).toEqual(snapshot.records);
  });
  it('rejects path traversal and unexpected files before interpreting a manifest', () => {
    for (const path of ['../manifest.json', '/manifest.json', 'assets/../../secret', 'extra.txt']) {
      expect(() => readPackageZip(zipSync({ [path]: utf8('{}') }))).toThrow(
        'Unexpected package path',
      );
    }
  });
  it('rejects corruption in a stored archive payload', () => {
    const bytes = zipSync({ 'manifest.json': utf8('{"sample":true}') }, { level: 0 });
    const view = new DataView(bytes.buffer);
    const payload = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    bytes[payload] ^= 1;
    expect(() => readPackageZip(bytes)).toThrow('checksum');
  });
  it('rejects truncated archives and undeclared trailing bytes', async () => {
    const bytes = packageBytes(await fixture());
    expect(() => readPackageZip(bytes.subarray(0, bytes.length - 1))).toThrow();
    expect(() => readPackageZip(new Uint8Array([...bytes, 0]))).toThrow();
  });
  it('rejects a package that claims an unsafe sharing state', async () => {
    const snapshot = structuredClone(await fixture());
    snapshot.options.includePrivate = true;
    await expect(previewProjectFile(packageBytes(snapshot), 'bad.tracefold')).rejects.toThrow();
  });
  it('rejects evidence files unreferenced by the manifest', async () => {
    const snapshot = await fixture();
    const files = Object.fromEntries(readPackageZip(packageBytes(snapshot)));
    files[`assets/${'a'.repeat(64)}.txt`] = utf8('hidden data');
    await expect(previewProjectFile(zipSync(files), 'bad.tracefold')).rejects.toThrow(
      'Unreferenced',
    );
  });
  it('rejects non-project JSON without mutating a repository', async () => {
    await expect(previewProjectFile(utf8('{"hello":"world"}'), 'notes.json')).rejects.toThrow(
      'not a Tracefold',
    );
  });
});
