import type { DownloadEvent } from '@tauri-apps/plugin-updater';
export interface AvailableUpdate {
  version: string;
  download(onEvent?: (event: DownloadEvent) => void, options?: { timeout: number }): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}
export interface UpdateProvider {
  check(): Promise<AvailableUpdate | null>;
  prepare(): Promise<void>;
  relaunch(): Promise<void>;
}
export type UpdatePhase = 'idle' | 'preparing' | 'downloading' | 'installing' | 'restarting';
/** UI state is independent of transport and never fabricates an available release. */
export class AppUpdater {
  available = $state<AvailableUpdate | null>(null);
  phase = $state<UpdatePhase>('idle');
  received = $state(0);
  total = $state<number | undefined>();
  error = $state('');
  checking = false;
  private disposed = false;
  private installed = false;
  constructor(private provider: UpdateProvider) {}
  get busy() {
    return this.phase !== 'idle';
  }
  async check() {
    if (this.checking || this.busy || this.disposed || this.installed) return;
    this.checking = true;
    try {
      const update = await this.provider.check();
      if (this.disposed || this.busy || this.installed) {
        await update?.close();
        return;
      }
      const old = this.available;
      this.available = update;
      await old?.close();
    } catch {
      /* Offline and unavailable feeds must never block local work. */
    } finally {
      this.checking = false;
    }
  }
  async install() {
    const update = this.available;
    if (!update || this.busy || this.disposed) return;
    this.phase = 'preparing';
    this.error = '';
    this.received = 0;
    this.total = undefined;
    try {
      await this.provider.prepare();
      if (this.installed) {
        this.phase = 'restarting';
        await this.provider.relaunch();
        return;
      }
      this.phase = 'downloading';
      await update.download(
        (event) => {
          if (event.event === 'Started') this.total = event.data.contentLength;
          if (event.event === 'Progress') this.received += event.data.chunkLength;
        },
        { timeout: 120000 },
      );
      this.phase = 'installing';
      await update.install();
      this.installed = true;
      this.phase = 'restarting';
      await this.provider.relaunch();
    } catch {
      this.error = this.installed
        ? 'The update was installed. Close and reopen Tracefold to finish.'
        : 'The update could not finish. Check that your work is saved, then try again.';
      this.phase = 'idle';
    }
  }
  async dispose() {
    this.disposed = true;
    if (!this.busy) await this.available?.close();
  }
}
