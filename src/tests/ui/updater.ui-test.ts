import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { getVersion } from '@tauri-apps/api/app';
import UpdateSettings from '../../features/updates/UpdateSettings.svelte';
import UpdateButton from '../../features/updates/UpdateButton.svelte';
import { AppUpdater } from '../../lib/services/updater.svelte';
import { setLanguage } from '../../lib/i18n/i18n.svelte';
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn() }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
  setLanguage('hu');
});

describe('update availability UI', () => {
  it('reads the installed version from native metadata and keeps the available version separate', async () => {
    vi.mocked(getVersion).mockResolvedValue('0.1.7');
    const updater = new AppUpdater({ check: vi.fn(), prepare: vi.fn(), relaunch: vi.fn() });
    updater.available = { version: '0.2.0', download: vi.fn(), install: vi.fn(), close: vi.fn() };
    component = mount(UpdateSettings, { target: document.body, props: { updater } });
    flushSync();
    await tick();
    await tick();
    flushSync();
    expect(getVersion).toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Telepített verzió"]')?.textContent).toContain(
      '0.1.7',
    );
    expect(document.body.textContent).toContain('Elérhető verzió: 0.2.0');
    flushSync(() => setLanguage('en'));
    expect(document.querySelector('[aria-label="Installed version"]')?.textContent).toContain(
      '0.1.7',
    );
  });
  it('shows the update action only for an available release and changes UI language', async () => {
    const update = { version: '0.2.0', download: vi.fn(), install: vi.fn(), close: vi.fn() };
    // Background download off, so this asserts the found-but-not-yet-staged state.
    const updater = new AppUpdater(
      { check: async () => update, prepare: vi.fn(), relaunch: vi.fn() },
      false,
    );
    component = mount(UpdateButton, { target: document.body, props: { updater } });
    flushSync();
    expect(document.querySelector('button')).toBeNull();
    await updater.check();
    flushSync();
    expect(document.querySelector('button')?.textContent).toContain(
      'Frissítés a legújabb verzióra',
    );
    flushSync(() => setLanguage('en'));
    expect(document.querySelector('button')?.textContent).toContain('Update to newest version');
    expect(document.querySelector('button')?.title).toBe('Version 0.2.0');
    expect(document.querySelector('a')).toBeNull();
  });
  it('announces progress and retains the recovery message in the active locale', () => {
    const updater = new AppUpdater({ check: vi.fn(), prepare: vi.fn(), relaunch: vi.fn() });
    updater.phase = 'downloading';
    updater.total = 100;
    updater.received = 25;
    component = mount(UpdateButton, { target: document.body, props: { updater, overlay: true } });
    flushSync();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Frissítés letöltése');
    expect(document.querySelector('progress')?.value).toBe(25);
    expect(document.querySelector('progress')?.max).toBe(100);
    expect(document.body.textContent).toContain('Projektjeid, bizonyítékaid és beállításaid');
  });
  it('re-checks when the window regains focus, throttled so alt-tabbing is free', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn().mockResolvedValue(null);
      const updater = new AppUpdater({ check, prepare: vi.fn(), relaunch: vi.fn() });
      const stop = updater.startAutomaticChecks();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(check).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(check).toHaveBeenCalledTimes(2);

      // Returning to the window repeatedly must not produce a request each time.
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(check).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      const afterInterval = check.mock.calls.length;
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(check.mock.calls.length).toBe(afterInterval + 1);

      stop();
      const afterStop = check.mock.calls.length;
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(check.mock.calls.length).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a restart once the update is staged in the background', async () => {
    const update = {
      version: '0.2.1',
      download: vi.fn().mockResolvedValue(undefined),
      install: vi.fn(),
      close: vi.fn(),
    };
    const updater = new AppUpdater({
      check: async () => update,
      prepare: vi.fn(),
      relaunch: vi.fn(),
    });
    component = mount(UpdateButton, { target: document.body, props: { updater } });
    flushSync();
    await updater.check();
    flushSync();
    expect(updater.readyToRestart).toBe(true);
    expect(document.querySelector('button')?.textContent).toContain('Újraindítás a frissítéshez');
    expect(document.body.textContent).toContain('0.2.1');
    flushSync(() => setLanguage('en'));
    expect(document.querySelector('button')?.textContent).toContain('Restart to update');
  });
  it('applies the failure backoff to a focus-triggered check, not just the timer', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn().mockResolvedValueOnce(null);
      const updater = new AppUpdater({ check, prepare: vi.fn(), relaunch: vi.fn() });
      const stop = updater.startAutomaticChecks();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(check).toHaveBeenCalledTimes(1);

      // A focus check that fails must schedule the short retry rather than leave the next
      // attempt an hour away.
      check.mockRejectedValue(new Error('offline'));
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      const beforeFocus = check.mock.calls.length;
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(check.mock.calls.length).toBe(beforeFocus + 1);

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(check.mock.calls.length).toBe(beforeFocus + 2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
