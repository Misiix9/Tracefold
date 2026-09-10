import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkspaceSearch } from './search.svelte';
import type { WorkspaceRepository } from './repository';
import { createEntity, defaultData } from '../domain/defaults';
afterEach(() => vi.useRealTimers());
describe('repository-backed search', () => {
  it('flushes drafts before querying and ignores stale results from a previous project', async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    const old = createEntity('old', 'document', 'Old', defaultData('document'));
    const current = createEntity('current', 'document', 'Current', defaultData('document'));
    const flush = vi.fn(async () => {});
    const listRecords = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce({ items: [current], total: 81 });
    const search = new WorkspaceSearch({ listRecords } as unknown as WorkspaceRepository, flush);
    search.search('old', 'slow');
    await vi.advanceTimersByTimeAsync(180);
    search.search('current', 'latest', 'document');
    await vi.advanceTimersByTimeAsync(180);
    expect(search.items[0].id).toBe(current.id);
    expect(search.total).toBe(81);
    release({ items: [old], total: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(search.items[0].id).toBe(current.id);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(listRecords.mock.invocationCallOrder[0]);
    expect(listRecords).toHaveBeenLastCalledWith({
      projectId: 'current',
      search: 'latest',
      kind: 'document',
      limit: 60,
    });
    search.clear();
  });
  it('debounces typing and discards work after closing search', async () => {
    vi.useFakeTimers();
    const listRecords = vi.fn(async () => ({ items: [], total: 0 }));
    const search = new WorkspaceSearch(
      { listRecords } as unknown as WorkspaceRepository,
      async () => {},
    );
    search.search('project', 'o');
    search.search('project', 'ob');
    search.search('project', 'obs');
    await vi.advanceTimersByTimeAsync(180);
    expect(listRecords).toHaveBeenCalledTimes(1);
    search.search('project', 'observation');
    search.clear();
    await vi.advanceTimersByTimeAsync(180);
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(search.busy).toBe(false);
  });
});
