import { invoke } from '@tauri-apps/api/core';
import { AsyncUnzipInflate, Unzip } from 'fflate';
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

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 512;

function concatChunks(chunks: Uint8Array[], size: number) {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isDirectoryEntry(path: string) {
  return path.endsWith('/');
}

async function installArchive(archive: Uint8Array) {
  if (archive.byteLength === 0) return null;
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error(t('The plugin package exceeds the 256 MiB limit.'));

  const installId = await invoke<string>('begin_plugin_install');
  let fileCount = 0;
  let unpackedBytes = 0;
  let aborted = false;
  let uploadChain = Promise.resolve();

  try {
    const unzip = new Unzip((file) => {
      if (isDirectoryEntry(file.name)) {
        file.start();
        return;
      }

      fileCount += 1;
      if (fileCount > MAX_FILES) {
        aborted = true;
        return;
      }

      const chunks: Uint8Array[] = [];
      let fileBytes = 0;
      let fileError: Error | null = null;
      let resolveFile!: () => void;
      let rejectFile!: (reason?: unknown) => void;
      const fileReady = new Promise<void>((resolve, reject) => {
        resolveFile = resolve;
        rejectFile = reject;
      });

      file.ondata = (error, chunk, final) => {
        if (aborted) return;
        if (error) {
          fileError = error;
          aborted = true;
          rejectFile(error);
          return;
        }
        fileBytes += chunk.byteLength;
        unpackedBytes += chunk.byteLength;
        if (fileBytes > MAX_FILE_BYTES) {
          const limitError = new Error(t('A plugin file exceeds the 64 MiB limit.'));
          fileError = limitError;
          aborted = true;
          rejectFile(limitError);
          return;
        }
        if (unpackedBytes > MAX_TOTAL_UNPACKED_BYTES) {
          const limitError = new Error(t('The unpacked plugin package exceeds the 128 MiB limit.'));
          fileError = limitError;
          aborted = true;
          rejectFile(limitError);
          return;
        }
        chunks.push(chunk.slice());
        if (final) {
          const data = concatChunks(chunks, fileBytes);
          uploadChain = uploadChain.then(() => {
            if (aborted || fileError) return;
            return invoke<void>('append_plugin_file', data, {
              headers: {
                'x-plugin-install-id': installId,
                'x-plugin-path': encodeURIComponent(file.name),
              },
            });
          });
          uploadChain.then(resolveFile, rejectFile);
        }
      };
      file.start();
      void fileReady;
    });
    unzip.register(AsyncUnzipInflate);
    unzip.push(archive, true);
    await uploadChain;
    if (aborted || fileCount === 0) {
      throw new Error(fileCount === 0 ? t('The plugin package is empty.') : t('The plugin package exceeds the supported file or size limits.'));
    }
    return await invoke<PluginInfo>('finalize_plugin_install', { installId });
  } catch (error) {
    aborted = true;
    await invoke<void>('abort_plugin_install', { installId }).catch(() => undefined);
    throw error;
  }
}

export class PluginManager {
  plugins = $state<PluginInfo[]>([]);
  loading = $state(false);
  error = $state('');
  notification = $state('');
  private busy = $state<Record<string, boolean>>({});

  isBusy(id: string) {
    return Boolean(this.busy[id]);
  }

  private setBusy(id: string, value: boolean) {
    if (value) this.busy[id] = true;
    else delete this.busy[id];
  }

  async refresh() {
    this.loading = true;
    try {
      this.plugins = await invoke<PluginInfo[]>('list_plugins');
      this.error = '';
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.loading = false;
    }
  }

  async installFromFilePicker() {
    this.loading = true;
    this.error = '';
    try {
      const archive = new Uint8Array(await invoke<ArrayBuffer>('pick_plugin_archive'));
      if (archive.byteLength === 0) return;
      const installed = await installArchive(archive);
      if (installed) {
        this.notification = t('{name} {version} installed.', { name: installed.name, version: installed.version });
        window.setTimeout(() => (this.notification = ''), 3000);
      }
      await this.refresh();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.loading = false;
    }
  }

  async setEnabled(plugin: PluginInfo, enabled: boolean) {
    if (this.isBusy(plugin.id) || this.loading) return;
    this.setBusy(plugin.id, true);
    this.error = '';
    try {
      await invoke<void>('set_plugin_enabled', { id: plugin.id, enabled });
      await this.refresh();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.setBusy(plugin.id, false);
    }
  }

  async open(plugin: PluginInfo) {
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

  async stop(plugin: PluginInfo) {
    if (this.isBusy(plugin.id) || this.loading) return;
    this.setBusy(plugin.id, true);
    this.error = '';
    try {
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
    const confirmed = window.confirm(t('Remove {name}? This stops the plugin and deletes its installed code. Persistent plugin data is kept.', { name: plugin.name }));
    if (!confirmed) return;
    this.setBusy(plugin.id, true);
    this.error = '';
    try {
      await invoke<void>('remove_plugin', { id: plugin.id });
      await this.refresh();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.setBusy(plugin.id, false);
    }
  }
}

export const pluginManager = new PluginManager();
