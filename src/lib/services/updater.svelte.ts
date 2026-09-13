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
export type UpdatePhase =
  'idle' | 'downloading' | 'ready' | 'preparing' | 'installing' | 'restarting';

/** First check shortly after launch, then hourly, so a release is found without being asked. */
const FIRST_CHECK_DELAY = 8_000;
const CHECK_INTERVAL = 60 * 60 * 1000;
/** Returning to the app is a good moment to look again, but not on every alt-tab. */
const FOCUS_THROTTLE = 15 * 60 * 1000;
/** A failed check backs off instead of hammering an unreachable feed. */
const RETRY_DELAYS = [2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

/**
 * UI state is independent of transport and never fabricates an available release.
 *
 * A found update downloads in the background and then waits: nothing is installed, and no
 * work is interrupted, until the user chooses to restart. Saving and backing up happen
 * immediately before installation, so the recovery snapshot reflects the work that exists
 * at that moment rather than whenever the download happened to start.
 */
export class AppUpdater {
  available = $state<AvailableUpdate | null>(null);
  phase = $state<UpdatePhase>('idle');
  received = $state(0);
  total = $state<number | undefined>();
  error = $state('');
  checking = $state(false);
  checkStatus = $state<'never' | 'current' | 'available' | 'unavailable'>('never');
  checkError = $state('');
  lastCheckedAt = $state<string>('');
  /** The downloaded update is staged and will be applied on the next restart. */
  downloaded = $state(false);
  /** A quiet background fetch. Deliberately not part of `busy`: it interrupts nothing. */
  prefetching = $state(false);

  private disposed = false;
  private installed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastFocusCheck = 0;
  private failures = 0;

  constructor(
    private provider: UpdateProvider,
    private autoDownload = true,
  ) {}

  get busy() {
    return this.phase !== 'idle' && this.phase !== 'ready';
  }

  /** True once the user only has to restart; the bytes are already on disk. */
  get readyToRestart() {
    return this.downloaded && this.phase === 'ready';
  }

  private schedule(run: () => void, delay: number) {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) run();
    }, delay);
    this.timers.add(timer);
  }

  /**
   * Start unattended checking. Returns a disposer so the caller owns the lifetime.
   * Checks repeat on a timer and when the window regains focus, and back off on failure.
   */
  startAutomaticChecks(): () => void {
    const tick = () => {
      void this.check().finally(() => {
        if (this.disposed || this.readyToRestart) return;
        const delay =
          this.failures > 0
            ? RETRY_DELAYS[Math.min(this.failures, RETRY_DELAYS.length) - 1]
            : CHECK_INTERVAL;
        this.schedule(tick, delay);
      });
    };
    this.schedule(tick, FIRST_CHECK_DELAY);

    const onFocus = () => {
      const now = Date.now();
      if (now - this.lastFocusCheck < FOCUS_THROTTLE) return;
      this.lastFocusCheck = now;
      void this.check();
    };
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      this.stopTimers();
    };
  }

  private stopTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async check() {
    if (this.checking || this.busy || this.prefetching) return;
    if (this.disposed || this.installed || this.downloaded) return;
    this.checking = true;
    this.checkError = '';
    try {
      const update = await this.provider.check();
      if (this.disposed || this.busy || this.installed) {
        await update?.close();
        return;
      }
      const old = this.available;
      this.available = update;
      this.checkStatus = update ? 'available' : 'current';
      this.lastCheckedAt = new Date().toISOString();
      this.failures = 0;
      if (old && old !== update) await old.close();
      if (update && this.autoDownload) await this.prefetch(update);
    } catch (error) {
      this.checkStatus = 'unavailable';
      this.checkError = String(error).slice(0, 600);
      this.failures += 1;
      /* Offline and unavailable feeds must never block local work. */
    } finally {
      this.checking = false;
    }
  }

  /**
   * Fetch the artifact ahead of time so restarting is instant. Never installs, and never
   * raises the blocking overlay: the user keeps working and only sees the result.
   */
  private async prefetch(update: AvailableUpdate) {
    if (this.disposed || this.busy || this.downloaded) return;
    this.prefetching = true;
    this.received = 0;
    this.total = undefined;
    try {
      await this.runDownload(update);
      if (this.disposed || this.busy) return;
      this.downloaded = true;
      this.phase = 'ready';
    } catch {
      // A failed prefetch is silent: the update is still offered, and clicking it
      // downloads again. Nothing about the installed application has changed.
      this.downloaded = false;
    } finally {
      this.prefetching = false;
    }
  }

  private async runDownload(update: AvailableUpdate) {
    await update.download(
      (event) => {
        if (event.event === 'Started') this.total = event.data.contentLength;
        if (event.event === 'Progress') this.received += event.data.chunkLength;
      },
      { timeout: 120000 },
    );
  }

  async install() {
    const update = this.available;
    if (!update || this.busy || this.disposed) return;
    this.error = '';
    try {
      if (this.installed) {
        // Retrying a failed restart must still flush anything written since the last
        // attempt; the bytes are already installed, so nothing is downloaded again.
        this.phase = 'preparing';
        await this.provider.prepare();
        this.phase = 'restarting';
        await this.provider.relaunch();
        return;
      }
      if (!this.downloaded) {
        this.phase = 'downloading';
        this.received = 0;
        this.total = undefined;
        await this.runDownload(update);
        this.downloaded = true;
      }
      // Saving and backing up happen last, so the recovery snapshot covers everything
      // written while the download was running. A failure here prevents installation.
      this.phase = 'preparing';
      await this.provider.prepare();
      this.phase = 'installing';
      await update.install();
      this.installed = true;
      this.phase = 'restarting';
      await this.provider.relaunch();
    } catch {
      this.error = this.installed
        ? 'The update was installed. Close and reopen Tracefold to finish.'
        : 'The update could not finish. Check that your work is saved, then try again.';
      this.phase = this.downloaded && !this.installed ? 'ready' : 'idle';
    }
  }

  async dispose() {
    this.disposed = true;
    this.prefetching = false;
    this.stopTimers();
    if (!this.busy) await this.available?.close();
  }
}
