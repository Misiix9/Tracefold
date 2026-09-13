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
  /**
   * Cheap "did the feed move?" probe. A full check fetches, parses and prepares a
   * verified download; this is a conditional request that an unchanged feed answers with
   * 304 and no body. Optional: without it every poll runs a full check.
   */
  probe?(): Promise<boolean>;
}

export type UpdateOptions = {
  /** Stage a found release in the background instead of waiting for a click. */
  autoDownload?: boolean;
  /** Install and restart without asking. Honoured at startup; mid-session prompts. */
  autoInstall?: boolean;
  /** Seconds between polls. Each poll is a conditional request, so this can be short. */
  intervalSeconds?: number;
};
export type UpdatePhase =
  'idle' | 'downloading' | 'ready' | 'preparing' | 'installing' | 'restarting';

/** First check shortly after launch, so a release is found without being asked. */
const FIRST_CHECK_DELAY = 5_000;
const DEFAULT_INTERVAL_SECONDS = 60;
/** Returning to the app is always a good moment to look again. */
const FOCUS_THROTTLE = 30 * 1000;
/** A failed check backs off instead of hammering an unreachable feed. */
const RETRY_DELAYS = [2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
/** How long after launch an update may install without asking. */
const STARTUP_WINDOW = 60 * 1000;

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
  /**
   * A staged update is waiting for a decision. Set only when automatic installation is on
   * and the session is already under way, because restarting out from under someone who
   * is typing is not an acceptable thing to do unprompted.
   */
  restartPrompt = $state(false);

  private disposed = false;
  private installed = false;
  private armed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastFocusCheck = 0;
  private failures = 0;
  /**
   * Startup is the one moment nothing is in progress, so it may install unattended.
   * A timestamp rather than a timer: the scheduler clears its timers on every reschedule,
   * and a cleared window would leave the session looking like a launch forever.
   */
  private startedAt = Date.now();
  private get startupWindow() {
    return Date.now() - this.startedAt < STARTUP_WINDOW;
  }

  private autoDownload: boolean;
  private autoInstall: boolean;
  private intervalMs: number;

  constructor(
    private provider: UpdateProvider,
    options: UpdateOptions | boolean = {},
  ) {
    // A bare boolean keeps the older call shape working in tests and callers that only
    // ever cared about background downloading.
    const resolved: UpdateOptions =
      typeof options === 'boolean' ? { autoDownload: options } : options;
    this.autoDownload = resolved.autoDownload ?? true;
    this.autoInstall = resolved.autoInstall ?? false;
    this.intervalMs = Math.max(30, resolved.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
  }

  /** Settings changes take effect without restarting the application. */
  configure(options: UpdateOptions) {
    if (options.autoDownload !== undefined) this.autoDownload = options.autoDownload;
    if (options.autoInstall !== undefined) this.autoInstall = options.autoInstall;
    if (options.intervalSeconds !== undefined) {
      this.intervalMs = Math.max(30, options.intervalSeconds) * 1000;
    }
  }

  get busy() {
    return this.phase !== 'idle' && this.phase !== 'ready';
  }

  /** True once the user only has to restart; the bytes are already on disk. */
  get readyToRestart() {
    return this.downloaded && this.phase === 'ready';
  }

  private schedule(run: () => void, delay: number) {
    if (this.disposed || !this.armed) return;
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
    this.armed = true;
    const tick = () => {
      void this.poll().finally(() => {
        if (this.disposed || !this.armed || this.readyToRestart) return;
        // Only ever one pending check, so a focus-triggered run replaces the timer
        // rather than racing it.
        this.stopTimers();
        const delay =
          this.failures > 0
            ? RETRY_DELAYS[Math.min(this.failures, RETRY_DELAYS.length) - 1]
            : this.intervalMs;
        this.schedule(tick, delay);
      });
    };
    this.startedAt = Date.now();
    this.schedule(tick, FIRST_CHECK_DELAY);

    // Focus goes through the same path, so a failure there also backs off instead of
    // waiting out the full hourly interval.
    const onFocus = () => {
      const now = Date.now();
      if (now - this.lastFocusCheck < FOCUS_THROTTLE) return;
      this.lastFocusCheck = now;
      tick();
    };
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    return () => {
      this.armed = false;
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      this.stopTimers();
    };
  }

  private stopTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * One scheduled poll. Asks the cheap probe first and only runs a full check when the
   * feed actually moved, so a short interval costs a 304 rather than a fetch-and-parse.
   */
  private async poll() {
    if (this.checking || this.busy || this.prefetching) return;
    if (this.disposed || this.installed || this.downloaded) return;
    if (this.provider.probe) {
      try {
        if (!(await this.provider.probe())) {
          // Unchanged feed. Record that the check happened; there is nothing to report.
          this.lastCheckedAt = new Date().toISOString();
          if (this.checkStatus === 'never') this.checkStatus = 'current';
          this.failures = 0;
          return;
        }
      } catch {
        // A probe that cannot run must never stop the real check from running.
      }
    }
    await this.check();
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
      if (this.autoInstall) {
        if (this.startupWindow) {
          // Nothing is in progress yet, so applying it now is the least disruptive
          // moment there will be.
          this.prefetching = false;
          await this.install();
        } else {
          this.restartPrompt = true;
        }
      }
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
    if (!update || this.busy || this.prefetching || this.disposed) return;
    this.error = '';
    this.restartPrompt = false;
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
      this.phase = this.downloaded ? 'ready' : 'idle';
    }
  }

  /** Dismiss the prompt and keep the staged update for the next restart. */
  postpone() {
    this.restartPrompt = false;
  }

  async dispose() {
    this.disposed = true;
    this.armed = false;
    this.prefetching = false;
    this.restartPrompt = false;
    this.stopTimers();
    if (!this.busy) await this.available?.close();
  }
}
