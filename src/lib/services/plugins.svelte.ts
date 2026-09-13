import { invoke } from '@tauri-apps/api/core';
import { errorText } from '../i18n/errors';
import { t } from '../i18n/i18n.svelte';

export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  apiVersion: number;
  minTracefoldVersion: string;
  capabilities: string[];
  enabled: boolean;
  running: boolean;
  url: string | null;
};

export type CatalogVersion = {
  version: string;
  apiVersion: number;
  minTracefoldVersion: string;
  url: string;
  sha256: string;
  size: number;
  capabilities: string[];
  published: string;
  notes: string;
};

export type CatalogEntry = {
  id: string;
  name: string;
  publisher: string;
  description: string;
  category: string;
  homepage: string;
  latest: CatalogVersion | null;
  installedVersion: string | null;
  updateAvailable: boolean;
  compatible: boolean;
  incompatibleReason: string;
};

export type CatalogResult = { source: string; updated: string; entries: CatalogEntry[] };

/**
 * Extraction, checksum verification and installation all happen in Rust. This class only
 * drives the UI state, so a browser preview can never reach a native-only command.
 */
export class PluginManager {
  plugins = $state<PluginInfo[]>([]);
  loading = $state(false);
  error = $state('');
  notification = $state('');

  catalog = $state<CatalogEntry[]>([]);
  catalogLoaded = $state(false);
  catalogLoading = $state(false);
  catalogError = $state('');
  catalogUpdated = $state('');

  /** The plugin currently hosted inline in the main window, and where to load it from. */
  active = $state<{ plugin: PluginInfo; url: string } | null>(null);
  opening = $state('');

  private busy = $state<Record<string, boolean>>({});

  isBusy(id: string) {
    return Boolean(this.busy[id]);
  }

  private setBusy(id: string, value: boolean) {
    if (value) this.busy[id] = true;
    else delete this.busy[id];
  }

  /** A notification is cosmetic: it must never be able to fail an install that succeeded. */
  private notify(message: string) {
    this.notification = message;
    if (typeof window === 'undefined') return;
    window.setTimeout(() => {
      if (this.notification === message) this.notification = '';
    }, 4000);
  }

  get updatable() {
    return this.catalog.filter((entry) => entry.updateAvailable);
  }

  async refresh() {
    this.loading = true;
    try {
      this.plugins = await invoke<PluginInfo[]>('list_plugins');
      this.error = '';
      // A plugin removed or stopped elsewhere must not keep an inline frame alive.
      const active = this.active;
      if (active && !this.plugins.some((p) => p.id === active.plugin.id && p.running)) {
        this.active = null;
      }
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.loading = false;
    }
  }

  /**
   * The catalog address is host configuration, not a parameter. Whoever picks the catalog
   * picks what is trusted, so that choice never travels through this layer.
   */
  async refreshCatalog() {
    if (this.catalogLoading) return;
    this.catalogLoading = true;
    this.catalogError = '';
    try {
      const result = await invoke<CatalogResult>('fetch_plugin_catalog');
      this.catalog = result.entries;
      this.catalogUpdated = result.updated;
      this.catalogLoaded = true;
    } catch (error) {
      this.catalogError = errorText(error);
    } finally {
      this.catalogLoading = false;
    }
  }

  async installFromCatalog(entry: CatalogEntry) {
    const target = entry.latest;
    if (!target || this.isBusy(entry.id) || this.loading) return;
    this.setBusy(entry.id, true);
    this.error = '';
    try {
      const installed = await invoke<PluginInfo>('install_catalog_plugin', {
        id: entry.id,
        version: target.version,
      });
      if (this.active?.plugin.id === installed.id) this.active = null;
      this.notify(
        t('{name} {version} installed.', { name: installed.name, version: installed.version }),
      );
      await this.refresh();
      // Reconcile installed-versus-available state without a second network round trip
      // being required before the badge is correct.
      this.catalog = this.catalog.map((candidate) =>
        candidate.id === installed.id
          ? { ...candidate, installedVersion: installed.version, updateAvailable: false }
          : candidate,
      );
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.setBusy(entry.id, false);
    }
  }

  async installFromFilePicker() {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    try {
      const installed = await invoke<PluginInfo | null>('install_plugin_from_file');
      if (installed) {
        if (this.active?.plugin.id === installed.id) this.active = null;
        this.notify(
          t('{name} {version} installed.', { name: installed.name, version: installed.version }),
        );
      }
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.loading = false;
    }
    await this.refresh();
    if (this.catalogLoaded) await this.refreshCatalog();
  }

  async setEnabled(plugin: PluginInfo, enabled: boolean) {
    if (this.isBusy(plugin.id) || this.loading) return;
    this.setBusy(plugin.id, true);
    this.error = '';
    try {
      await invoke<void>('set_plugin_enabled', { id: plugin.id, enabled });
      if (!enabled && this.active?.plugin.id === plugin.id) this.active = null;
      await this.refresh();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.setBusy(plugin.id, false);
    }
  }

  /** Start the plugin and host it inline; the URL is host-owned runtime state. */
  async open(plugin: PluginInfo) {
    if (this.isBusy(plugin.id) || this.loading || !plugin.enabled) return;
    this.setBusy(plugin.id, true);
    this.opening = plugin.id;
    this.error = '';
    try {
      const url = await invoke<string>('start_plugin', { id: plugin.id });
      this.active = { plugin, url };
      await this.refresh();
    } catch (error) {
      this.active = null;
      this.error = errorText(error);
    } finally {
      this.opening = '';
      this.setBusy(plugin.id, false);
    }
  }

  /** Secondary action: the same running runtime in its own OS window. */
  async openWindow(plugin: PluginInfo) {
    if (this.isBusy(plugin.id) || this.loading || !plugin.enabled) return;
    this.setBusy(plugin.id, true);
    this.error = '';
    try {
      await invoke<void>('launch_plugin', { id: plugin.id });
      await this.refresh();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.setBusy(plugin.id, false);
    }
  }

  closeActive() {
    this.active = null;
  }

  async stop(plugin: PluginInfo) {
    if (this.isBusy(plugin.id) || this.loading) return;
    this.setBusy(plugin.id, true);
    this.error = '';
    try {
      if (this.active?.plugin.id === plugin.id) this.active = null;
      await invoke<void>('stop_plugin', { id: plugin.id });
      await this.refresh();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.setBusy(plugin.id, false);
    }
  }

  async remove(plugin: PluginInfo) {
    if (this.isBusy(plugin.id) || this.loading) return;
    const confirmed = window.confirm(
      t(
        'Remove {name}? This stops the plugin and deletes its installed code. Persistent plugin data is kept.',
        {
          name: plugin.name,
        },
      ),
    );
    if (!confirmed) return;
    this.setBusy(plugin.id, true);
    this.error = '';
    try {
      if (this.active?.plugin.id === plugin.id) this.active = null;
      await invoke<void>('remove_plugin', { id: plugin.id });
      await this.refresh();
      this.catalog = this.catalog.map((candidate) =>
        candidate.id === plugin.id
          ? { ...candidate, installedVersion: null, updateAvailable: false }
          : candidate,
      );
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.setBusy(plugin.id, false);
    }
  }
}

export const pluginManager = new PluginManager();
