import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));

const { PluginManager } = await import('./plugins.svelte');
import type { CatalogEntry, PluginInfo } from './plugins.svelte';

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: 'tracefold.discovery',
    name: 'Tracefold Discovery',
    version: '2.1.0',
    publisher: 'Tracefold',
    description: 'Discovery',
    apiVersion: 1,
    minTracefoldVersion: '0.2.1',
    capabilities: ['network.targeted-http'],
    enabled: true,
    running: false,
    url: null,
    ...overrides,
  };
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'tracefold.discovery',
    name: 'Tracefold Discovery',
    publisher: 'Tracefold',
    description: 'Discovery',
    category: 'Discovery',
    homepage: '',
    latest: {
      version: '2.1.0',
      apiVersion: 1,
      minTracefoldVersion: '0.2.1',
      url: 'https://example.com/discovery.tracefold-plugin',
      sha256: 'a'.repeat(64),
      size: 1024,
      capabilities: [],
      published: '',
      notes: '',
    },
    installedVersion: null,
    updateAvailable: false,
    compatible: true,
    incompatibleReason: '',
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
  vi.useRealTimers();
});

describe('plugin manager', () => {
  it('loads installed plugins and surfaces failures without throwing', async () => {
    const manager = new PluginManager();
    invoke.mockResolvedValueOnce([plugin()]);
    await manager.refresh();
    expect(manager.plugins).toHaveLength(1);
    expect(manager.error).toBe('');

    invoke.mockRejectedValueOnce({ code: 'PLUGIN_STORAGE', message: 'disk gone' });
    await manager.refresh();
    expect(manager.error).not.toBe('');
    expect(manager.loading).toBe(false);
  });

  it('keeps a failed catalog fetch out of the installed list and stays usable offline', async () => {
    const manager = new PluginManager();
    invoke.mockRejectedValueOnce({ code: 'CATALOG_NETWORK', message: 'offline' });
    await manager.refreshCatalog();
    expect(manager.catalog).toEqual([]);
    expect(manager.catalogLoaded).toBe(false);
    expect(manager.catalogError).not.toBe('');
    expect(manager.catalogLoading).toBe(false);
  });

  it('asks the host for an id and version, never a URL', async () => {
    const manager = new PluginManager();
    invoke.mockResolvedValueOnce({ source: 's', updated: '', entries: [entry()] });
    await manager.refreshCatalog();

    invoke.mockResolvedValueOnce(plugin({ version: '2.1.0' }));
    invoke.mockResolvedValueOnce([plugin({ version: '2.1.0' })]);
    await manager.installFromCatalog(manager.catalog[0]);

    const call = invoke.mock.calls.find(([command]) => command === 'install_catalog_plugin');
    expect(call?.[1]).toEqual({ id: 'tracefold.discovery', version: '2.1.0' });
    expect(JSON.stringify(call?.[1])).not.toContain('http');
    expect(manager.catalog[0].installedVersion).toBe('2.1.0');
    expect(manager.catalog[0].updateAvailable).toBe(false);
  });

  it('refuses to install a catalog entry with no compatible version', async () => {
    const manager = new PluginManager();
    invoke.mockResolvedValueOnce({
      source: 's',
      updated: '',
      entries: [
        entry({ latest: null, compatible: false, incompatibleReason: 'Needs a newer Tracefold.' }),
      ],
    });
    await manager.refreshCatalog();
    await manager.installFromCatalog(manager.catalog[0]);
    expect(invoke).not.toHaveBeenCalledWith('install_catalog_plugin', expect.anything());
  });

  it('hosts a started plugin inline using the URL the host returned', async () => {
    const manager = new PluginManager();
    invoke.mockResolvedValueOnce('http://127.0.0.1:53312');
    invoke.mockResolvedValueOnce([plugin({ running: true, url: 'http://127.0.0.1:53312' })]);
    await manager.open(plugin());
    expect(manager.active?.url).toBe('http://127.0.0.1:53312');
    expect(manager.opening).toBe('');
  });

  it('drops the hosted frame when the plugin stops, is disabled, or is removed', async () => {
    const manager = new PluginManager();
    const running = plugin({ running: true, url: 'http://127.0.0.1:1' });

    invoke.mockResolvedValueOnce('http://127.0.0.1:1');
    invoke.mockResolvedValueOnce([running]);
    await manager.open(plugin());
    expect(manager.active).not.toBeNull();

    invoke.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValueOnce([plugin({ running: false })]);
    await manager.stop(running);
    expect(manager.active).toBeNull();
  });

  it('drops the hosted frame when a refresh shows the plugin is no longer running', async () => {
    const manager = new PluginManager();
    invoke.mockResolvedValueOnce('http://127.0.0.1:1');
    invoke.mockResolvedValueOnce([plugin({ running: true })]);
    await manager.open(plugin());
    expect(manager.active).not.toBeNull();

    // The runtime exited on its own; the next listing reports it as stopped.
    invoke.mockResolvedValueOnce([plugin({ running: false })]);
    await manager.refresh();
    expect(manager.active).toBeNull();
  });

  it('leaves the frame closed when starting a plugin fails', async () => {
    const manager = new PluginManager();
    invoke.mockRejectedValueOnce({ code: 'PLUGIN_RUNTIME', message: 'runtime died' });
    await manager.open(plugin());
    expect(manager.active).toBeNull();
    expect(manager.error).not.toBe('');
    expect(manager.opening).toBe('');
  });

  it('does nothing when the file picker is dismissed', async () => {
    const manager = new PluginManager();
    invoke.mockResolvedValueOnce(null);
    invoke.mockResolvedValueOnce([]);
    await manager.installFromFilePicker();
    expect(manager.notification).toBe('');
    expect(manager.error).toBe('');
  });

  it('keeps a disabled plugin from being opened', async () => {
    const manager = new PluginManager();
    await manager.open(plugin({ enabled: false }));
    expect(invoke).not.toHaveBeenCalled();
    expect(manager.active).toBeNull();
  });

  it('counts only entries with a newer available version as updatable', async () => {
    const manager = new PluginManager();
    invoke.mockResolvedValueOnce({
      source: 's',
      updated: '',
      entries: [
        entry({ id: 'a.one', installedVersion: '1.0.0', updateAvailable: true }),
        entry({ id: 'b.two', installedVersion: '2.1.0', updateAvailable: false }),
        entry({ id: 'c.three' }),
      ],
    });
    await manager.refreshCatalog();
    expect(manager.updatable.map((value) => value.id)).toEqual(['a.one']);
  });
});
