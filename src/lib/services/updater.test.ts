import { describe, expect, it, vi } from 'vitest';
import { AppUpdater, type AvailableUpdate } from './updater.svelte';
function fixture(autoDownload = false) {
  const update: AvailableUpdate = {
    version: '0.2.0',
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const provider = {
    check: vi.fn().mockResolvedValue(update),
    prepare: vi.fn().mockResolvedValue(undefined),
    relaunch: vi.fn().mockResolvedValue(undefined),
  };
  return { update, provider, app: new AppUpdater(provider, autoDownload) };
}
describe('in-app updater', () => {
  it('stays hidden without a newer release and tolerates offline checks', async () => {
    const { app, provider } = fixture();
    provider.check.mockResolvedValue(null);
    await app.check();
    expect(app.available).toBeNull();
    provider.check.mockRejectedValue(new Error('offline'));
    await app.check();
    expect(app.available).toBeNull();
    expect(app.busy).toBe(false);
    expect(app.error).toBe('');
  });
  it('downloads, then saves and backs up before installing and restarting', async () => {
    const { app, update, provider } = fixture();
    const order: string[] = [];
    provider.prepare.mockImplementation(async () => {
      order.push('backup');
    });
    vi.mocked(update.download).mockImplementation(async (cb) => {
      order.push('download');
      cb?.({ event: 'Started', data: { contentLength: 100 } });
      cb?.({ event: 'Progress', data: { chunkLength: 80 } });
    });
    vi.mocked(update.install).mockImplementation(async () => {
      order.push('install');
    });
    provider.relaunch.mockImplementation(async () => {
      order.push('restart');
    });
    await app.check();
    expect(app.available?.version).toBe('0.2.0');
    await app.install();
    expect(order).toEqual(['download', 'backup', 'install', 'restart']);
    expect(app.received).toBe(80);
    expect(app.total).toBe(100);
  });
  it('never installs if pending work cannot be backed up, and leaves the app usable', async () => {
    const { app, update, provider } = fixture();
    provider.prepare.mockRejectedValue(new Error('disk full'));
    await app.check();
    await app.install();
    // Downloading only writes a temporary file, so it is allowed to have happened.
    // Replacing the installed application is not.
    expect(update.install).not.toHaveBeenCalled();
    expect(provider.relaunch).not.toHaveBeenCalled();
    expect(app.busy).toBe(false);
    expect(app.error).toContain('could not finish');
  });
  it('keeps the current application on download/signature failure and permits retry', async () => {
    const { app, update, provider } = fixture();
    vi.mocked(update.download).mockRejectedValueOnce(new Error('invalid signature'));
    await app.check();
    await app.install();
    expect(update.install).not.toHaveBeenCalled();
    expect(provider.relaunch).not.toHaveBeenCalled();
    expect(app.busy).toBe(false);
    await app.install();
    expect(update.install).toHaveBeenCalledOnce();
  });
  it('prevents overlapping installs and releases stale handles on disposal', async () => {
    const { app, update, provider } = fixture();
    let ready!: () => void;
    provider.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    await app.check();
    const operation = app.install();
    await app.install();
    // The first install is parked inside prepare(); the second must not have started one.
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.prepare).toHaveBeenCalledOnce();
    ready();
    await operation;
    const second = fixture();
    await second.app.check();
    await second.app.dispose();
    expect(second.update.close).toHaveBeenCalledOnce();
  });
  it('retries a failed restart without downloading or reinstalling, saving any new edits first', async () => {
    const { app, update, provider } = fixture();
    provider.relaunch.mockRejectedValueOnce(new Error('restart failed'));
    await app.check();
    await app.install();
    expect(app.error).toContain('was installed');
    await app.check();
    expect(provider.check).toHaveBeenCalledOnce();
    await app.install();
    expect(provider.prepare).toHaveBeenCalledTimes(2);
    expect(provider.relaunch).toHaveBeenCalledTimes(2);
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
  });
  it('does not close the active installer when an overlapping check finishes', async () => {
    const { app, update, provider } = fixture();
    await app.check();
    const next = fixture().update;
    let finishCheck!: (value: AvailableUpdate) => void;
    provider.check.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    const checking = app.check();
    let finishPrepare!: () => void;
    provider.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPrepare = resolve;
        }),
    );
    const installing = app.install();
    finishCheck(next);
    await checking;
    expect(app.available).toBe(update);
    expect(update.close).not.toHaveBeenCalled();
    expect(next.close).toHaveBeenCalledOnce();
    finishPrepare();
    await installing;
  });
});

describe('automatic update checks and background download', () => {
  it('downloads a found update in the background without raising the blocking overlay', async () => {
    const { app, update, provider } = fixture(true);
    await app.check();
    expect(provider.check).toHaveBeenCalledOnce();
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(provider.prepare).not.toHaveBeenCalled();
    // Nothing was interrupted: no overlay, no restart, work continues.
    expect(app.busy).toBe(false);
    expect(app.readyToRestart).toBe(true);
    expect(app.phase).toBe('ready');
  });

  it('installs immediately on restart without downloading a second time', async () => {
    const { app, update, provider } = fixture(true);
    await app.check();
    await app.install();
    expect(update.download).toHaveBeenCalledOnce();
    expect(provider.prepare).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
    expect(provider.relaunch).toHaveBeenCalledOnce();
  });

  it('keeps offering the update when the background download fails, and retries on click', async () => {
    const { app, update, provider } = fixture(true);
    vi.mocked(update.download).mockRejectedValueOnce(new Error('connection reset'));
    await app.check();
    expect(app.available).toBe(update);
    expect(app.readyToRestart).toBe(false);
    expect(app.busy).toBe(false);
    // A silent prefetch failure must not surface as an error the user has to dismiss.
    expect(app.error).toBe('');

    await app.install();
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(update.install).toHaveBeenCalledOnce();
  });

  it('stops checking once an update is staged, and resumes nothing after disposal', async () => {
    const { app, provider } = fixture(true);
    await app.check();
    expect(app.readyToRestart).toBe(true);
    await app.check();
    expect(provider.check).toHaveBeenCalledOnce();
  });

  it('checks on a timer, backs off after a failure, and stops when disposed', async () => {
    vi.useFakeTimers();
    try {
      const { app, provider } = fixture(true);
      provider.check.mockRejectedValue(new Error('offline'));
      const stop = app.startAutomaticChecks();

      expect(provider.check).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(provider.check).toHaveBeenCalledTimes(1);
      expect(app.checkStatus).toBe('unavailable');

      // A failed check retries sooner than the hourly cadence instead of waiting an hour.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(provider.check).toHaveBeenCalledTimes(2);

      stop();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(provider.check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
