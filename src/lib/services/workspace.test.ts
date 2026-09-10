import { describe, it, expect, vi } from 'vitest';
import { Workspace } from './workspace.svelte';
import type { WorkspaceRepository } from './repository';
import type { AnyEntity } from '../domain/types';
import { createEntity, defaultData } from '../domain/defaults';
function setup() {
  const saved: AnyEntity[] = [];
  let revision = 1;
  const write = vi.fn(async (record: AnyEntity, expected: number) => {
    if (record.revision !== expected || expected !== revision) throw new Error('CONFLICT');
    const next = { ...record, revision: ++revision };
    saved.push(next);
    return next;
  });
  const repo = { mode: 'desktop', saveRecord: write } as unknown as WorkspaceRepository;
  const workspace = new Workspace(repo);
  workspace.projectId = 'test-project';
  const record = createEntity('test-project', 'document', 'Initial', defaultData('document'));
  record.revision = 1;
  workspace.records = [record];
  return { workspace, record, write, saved };
}
describe('durable autosave acknowledgements', () => {
  it('serializes preference writes so an older write cannot finish last', async () => {
    let release!: () => void;
    const saved: string[] = [];
    const saveSettings = vi.fn(async (settings: { author: string }) => {
      if (settings.author === 'First') await new Promise<void>((resolve) => (release = resolve));
      saved.push(settings.author);
    });
    const workspace = new Workspace({
      mode: 'desktop',
      saveSettings,
    } as unknown as WorkspaceRepository);
    const first = workspace.setSettings({ author: 'First' });
    await Promise.resolve();
    await Promise.resolve();
    const second = workspace.setSettings({ author: 'Latest' });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(saved).toEqual(['First', 'Latest']);
    workspace.dispose();
  });
  it('opens every page within the native repository limit', async () => {
    const first = createEntity('test-project', 'document', 'First', defaultData('document'));
    const second = createEntity('test-project', 'document', 'Second', defaultData('document'));
    const listRecords = vi.fn(async (query: { limit: number; cursor?: string }) => {
      if (query.limit > 500) throw new Error('Page size must be between 1 and 500.');
      return query.cursor ? { items: [second] } : { items: [first], nextCursor: 'next' };
    });
    const repo = {
      mode: 'desktop',
      listRecords,
      saveSettings: vi.fn(async () => {}),
    } as unknown as WorkspaceRepository;
    const workspace = new Workspace(repo);
    await workspace.openProject('test-project');
    expect(workspace.records.map((r) => r.title)).toEqual(['First', 'Second']);
    expect(listRecords).toHaveBeenCalledTimes(2);
    expect(workspace.loading).toBe(false);
    workspace.dispose();
  });
  it('saves the latest edit made during a pending save with the acknowledged revision', async () => {
    const { workspace, record, write, saved } = setup();
    let release!: () => void;
    const original = write.getMockImplementation()!;
    write.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return original(...args);
    });
    workspace.edit({ ...record, title: 'First' });
    const flush = workspace.flush();
    workspace.edit({ ...record, title: 'Intermediate' });
    workspace.edit({ ...record, title: 'Latest' });
    release();
    await flush;
    expect(saved.map((r) => [r.title, r.revision])).toEqual([
      ['First', 2],
      ['Latest', 3],
    ]);
    expect(workspace.records[0].title).toBe('Latest');
    expect(workspace.saveStatus).toBe('saved');
    workspace.dispose();
  });
  it('keeps newer buffered content after an in-flight failure and retries it', async () => {
    const { workspace, record, write, saved } = setup();
    let reject!: (error: Error) => void;
    write.mockImplementationOnce(() => new Promise((_, failure) => (reject = failure)));
    workspace.edit({ ...record, title: 'First' });
    const flush = workspace.flush();
    workspace.edit({ ...record, title: 'Latest' });
    reject(new Error('STORAGE_FULL'));
    await expect(flush).rejects.toThrow('STORAGE_FULL');
    expect(workspace.saveStatus).toBe('error');
    expect(workspace.records[0].title).toBe('Latest');
    await workspace.flush();
    expect(saved.map((r) => r.title)).toEqual(['Latest']);
    expect(workspace.saveStatus).toBe('saved');
    workspace.dispose();
  });
  it('does not acknowledge failed data as saved', async () => {
    const { workspace, record, write } = setup();
    write.mockRejectedValueOnce(new Error('Permission denied'));
    workspace.edit({ ...record, title: 'Unsaved text' });
    await expect(workspace.flush()).rejects.toThrow();
    expect(workspace.saveStatus).toBe('error');
    expect(workspace.records[0].revision).toBe(1);
    await workspace.flush();
    expect(workspace.records[0].revision).toBe(2);
    workspace.dispose();
  });
});
