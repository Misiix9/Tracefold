import type { AnyEntity, EntityKind } from '../domain/types';
import type { WorkspaceRepository } from './repository';
import { errorText } from '../i18n/errors';

/** Stale asynchronous answers cannot leak across queries or project changes. */
export class WorkspaceSearch {
  items = $state<AnyEntity[]>([]);
  total = $state(0);
  busy = $state(false);
  error = $state('');
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private repo: WorkspaceRepository,
    private flush: () => Promise<void>,
  ) {}
  clear() {
    this.generation++;
    clearTimeout(this.timer);
    this.items = [];
    this.total = 0;
    this.busy = false;
    this.error = '';
  }
  search(projectId: string, text: string, kind?: EntityKind) {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.items = [];
    this.total = 0;
    this.error = '';
    this.busy = true;
    this.timer = setTimeout(
      () => {
        void this.load(generation, projectId, text.trim(), kind);
      },
      text.trim() ? 180 : 0,
    );
  }
  private async load(generation: number, projectId: string, search: string, kind?: EntityKind) {
    try {
      await this.flush();
      if (generation !== this.generation) return;
      const result = await this.repo.listRecords({
        projectId,
        search: search || undefined,
        kind,
        limit: 60,
      });
      if (generation !== this.generation) return;
      this.items = result.items;
      this.total = result.total;
    } catch (error) {
      if (generation === this.generation) this.error = errorText(error);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
}
