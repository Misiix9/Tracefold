import { invoke } from '@tauri-apps/api/core';
import { unzipSync } from 'fflate';

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

type PluginFile = { path: string; data: number[] };

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (value && typeof value === 'object') {
    const values = Object.values(value as Record<string, number>);
    if (values.every((item) => typeof item === 'number')) return new Uint8Array(values as number[]);
  }
  throw new Error('The plugin package returned invalid binary data.');
}

function readManifest(files: Record<string, Uint8Array>): { id: string } {
  const manifest = files['manifest.json'];
  if (!manifest) throw new Error('The plugin package has no root manifest.json.');
  const text = new TextDecoder().decode(manifest);
  const parsed = JSON.parse(text) as { schema?: string; id?: string };
  if (parsed.schema !== 'tracefold.plugin.v1' || !parsed.id) {
    throw new Error('The plugin manifest is not a supported Tracefold plugin.');
  }
  return { id: parsed.id };
}

function unpack(input: Uint8Array): PluginFile[] {
  const files = unzipSync(input);
  const entries = Object.entries(files).filter(([path]) => !path.endsWith('/'));
  const total = entries.reduce((sum, [, data]) => sum + data.byteLength, 0);
  if (entries.length > 2000 || total > 256 * 1024 * 1024) {
    throw new Error('Plugin package is too large.');
  }
  readManifest(Object.fromEntries(entries));
  return entries.map(([path, data]) => ({ path, data: Array.from(data) }));
}

export class PluginManager {
  plugins = $state<PluginInfo[]>([]);
  loading = $state(false);
  error = $state('');
  notification = $state('');

  async refresh() {
    this.loading = true;
    try {
      this.plugins = await invoke<PluginInfo[]>('list_plugins');
      this.error = '';
    } catch (error) {
      this.error = String(error);
    } finally {
      this.loading = false;
    }
  }

  async installFromFilePicker() {
    this.loading = true;
    try {
      const archive = bytes(await invoke<unknown>('pick_plugin_archive'));
      const files = unpack(archive);
      const installed = await invoke<PluginInfo>('install_plugin_files', { files });
      await this.refresh();
      this.notification = `${installed.name} ${installed.version} installed.`;
      window.setTimeout(() => (this.notification = ''), 3000);
    } catch (error) {
      if (String(error).includes('CANCELLED')) return;
      this.error = String(error);
    } finally {
      this.loading = false;
    }
  }

  async installBundledDiscovery() {
    this.loading = true;
    try {
      const archive = bytes(await invoke<unknown>('bundled_discovery_plugin'));
      const files = unpack(archive);
      await invoke<PluginInfo>('install_plugin_files', { files });
      await this.refresh();
      this.notification = 'Tracefold Discovery is installed.';
      window.setTimeout(() => (this.notification = ''), 3000);
    } catch (error) {
      this.error = String(error);
    } finally {
      this.loading = false;
    }
  }

  async setEnabled(plugin: PluginInfo, enabled: boolean) {
    try {
      await invoke('set_plugin_enabled', { id: plugin.id, enabled });
      await this.refresh();
    } catch (error) {
      this.error = String(error);
    }
  }

  async open(plugin: PluginInfo) {
    try {
      await invoke('launch_plugin', { id: plugin.id });
      await this.refresh();
    } catch (error) {
      this.error = String(error);
    }
  }

  async stop(plugin: PluginInfo) {
    try {
      await invoke('stop_plugin', { id: plugin.id });
      await this.refresh();
    } catch (error) {
      this.error = String(error);
    }
  }

  async remove(plugin: PluginInfo) {
    if (!window.confirm(`Remove ${plugin.name}? Plugin data is kept separately and is not removed.`)) return;
    try {
      await invoke('remove_plugin', { id: plugin.id });
      await this.refresh();
    } catch (error) {
      this.error = String(error);
    }
  }
}
