import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { setLanguage } from '../../lib/i18n/i18n.svelte';
import EditorHarness from './EditorHarness.svelte';
let app: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  document.body.replaceChildren();
  setLanguage('hu');
});
describe('real rich editor lifecycle', () => {
  it('mounts and switches language without reactive loops, content replacement or fake saves', async () => {
    const changed = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    app = mount(EditorHarness, {
      target,
      props: {
        initial: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Árvíztűrő tükörfúrógép' }] },
          ],
        },
        changed,
      },
    });
    flushSync();
    await tick();
    expect(target.querySelector('[role="textbox"]')?.getAttribute('aria-label')).toBe(
      'Dokumentum tartalma',
    );
    flushSync(() => setLanguage('en'));
    await tick();
    expect(target.querySelector('[role="textbox"]')?.getAttribute('aria-label')).toBe(
      'Document content',
    );
    expect(target.querySelector('[role="textbox"]')?.textContent).toBe('Árvíztűrő tükörfúrógép');
    expect(changed).not.toHaveBeenCalled();
    flushSync(() => (target.querySelector('button') as HTMLButtonElement).click());
    expect(target.textContent).toContain('Navigation completed');
    expect(target.querySelector('[role="textbox"]')).toBeNull();
  });
  it('loads a recovered revision and stays interactive after toolbar transactions', async () => {
    const changed = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    app = mount(EditorHarness, {
      target,
      props: { initial: { type: 'doc', content: [{ type: 'paragraph' }] }, changed },
    });
    flushSync();
    await tick();
    flushSync(() => (target.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(target.querySelector('[role="textbox"]')?.textContent).toBe('Restored revision');
    flushSync(() => (target.querySelector('[aria-label="Félkövér"]') as HTMLButtonElement).click());
    await tick();
    flushSync(() => (target.querySelector('button') as HTMLButtonElement).click());
    expect(target.textContent).toContain('Navigation completed');
    expect(changed).not.toHaveBeenCalled();
  });
});
