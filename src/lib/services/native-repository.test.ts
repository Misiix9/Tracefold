import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { NativeRepository } from './native-repository';
beforeEach(() => vi.mocked(invoke).mockReset());
describe('native binary transport', () => {
  it('transfers evidence as bytes with encoded file metadata', async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 'asset' });
    const bytes = new Uint8Array([0, 127, 128, 255]);
    await new NativeRepository().importAsset('project', 'árvíz.png', 'image/png', bytes);
    expect(invoke).toHaveBeenCalledWith('import_asset', bytes, {
      headers: {
        'x-project-id': 'project',
        'x-filename': '%C3%A1rv%C3%ADz.png',
        'x-mime-type': 'image%2Fpng',
      },
    });
  });
  it('reads a raw native response without JSON array expansion', async () => {
    vi.mocked(invoke).mockResolvedValue(new Uint8Array([0, 127, 128, 255]).buffer);
    expect(await new NativeRepository().readAsset('project', 'asset')).toEqual(
      new Uint8Array([0, 127, 128, 255]),
    );
  });
  it('saves report bytes without converting them to a number array', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    const bytes = new Uint8Array([37, 80, 68, 70]);
    await new NativeRepository().saveFile('Report.pdf', 'application/pdf', bytes);
    expect(invoke).toHaveBeenCalledWith('save_file', bytes, {
      headers: { 'x-filename': 'Report.pdf', 'x-mime-type': 'application%2Fpdf' },
    });
  });
});
