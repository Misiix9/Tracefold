// Real version-to-version installation in a disposable Windows Actions runner.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
export async function startUpdateFixture() {
  const artifact = process.env.TRACEFOLD_UPDATE_ARTIFACT;
  if (!artifact) return;
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('CI only');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const signature = (await readFile(`${artifact}.sig`, 'utf8')).trim();
  const size = (await stat(artifact)).size;
  const server = createServer((request, response) => {
    if (request.url === '/latest.json') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          version,
          platforms: {
            'windows-x86_64': {
              url: 'http://127.0.0.1:18421/update.exe',
              signature,
            },
          },
        }),
      );
    } else if (request.url === '/update.exe') {
      response.setHeader('content-length', size);
      createReadStream(artifact).pipe(response);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(18421, '127.0.0.1', resolve);
  });
  return server;
}
async function snapshot(root) {
  const projects = {};
  for (const id of (await readdir(join(root, 'projects'))).sort()) {
    if (id.startsWith('.')) continue;
    const db = new DatabaseSync(join(root, 'projects', id, 'workspace.sqlite'), { readOnly: true });
    const data = {};
    try {
      for (const table of [
        'project',
        'project_revisions',
        'records',
        'revisions',
        'assets',
        'asset_refs',
      ])
        data[table] = db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
    } finally {
      db.close();
    }
    const hashes = {};
    async function walk(path, relative = '') {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const next = join(path, entry.name),
          name = join(relative, entry.name);
        if (entry.isDirectory()) await walk(next, name);
        else if (!entry.name.startsWith('workspace.sqlite'))
          hashes[name] = createHash('sha256')
            .update(await readFile(next))
            .digest('hex');
      }
    }
    await walk(join(root, 'projects', id));
    projects[id] = { data, hashes };
  }
  const catalog = new DatabaseSync(join(root, 'settings.sqlite'), { readOnly: true });
  let settings;
  try {
    settings = JSON.parse(catalog.prepare('SELECT payload FROM settings WHERE id=1').get().payload);
  } finally {
    catalog.close();
  }
  delete settings.lastView;
  return { projects, settings };
}
export async function verifyUpdate({ execute, button, until, screenshot, detach, attach }) {
  if (!process.env.TRACEFOLD_UPDATE_ARTIFACT) return false;
  await button('Settings & recovery');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  assert.equal(
    await execute("return window.__TAURI_INTERNALS__.invoke('plugin:app|version')"),
    '0.0.9',
  );
  const location = await execute(
    "return window.__TAURI_INTERNALS__.invoke('storage_info').then(info=>info.location)",
  );
  const before = await snapshot(location);
  await button('Check for updates');
  await until(
    () => execute("return !!document.querySelector('.update-button')"),
    'available update',
  );
  assert.equal(
    await execute(
      "const b=document.querySelector('.update-button').getBoundingClientRect();const d=document.querySelector('.sidebar-divider').getBoundingClientRect();return b.bottom<=d.top;",
    ),
    true,
  );
  await screenshot('update-ready');
  await button('Update to newest version');
  await until(
    async () => {
      try {
        await execute('return document.title');
        return false;
      } catch {
        return true;
      }
    },
    'old app exits for installation',
    180000,
  );
  await detach();
  await until(
    async () => {
      const response = await fetch('http://127.0.0.1:9222/json/version', {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    },
    'installer restarts app',
    180000,
  );
  await attach();
  assert.equal(
    await execute("return window.__TAURI_INTERNALS__.invoke('plugin:app|version')"),
    version,
  );
  await button('Settings & recovery');
  await until(
    () =>
      execute(
        "return document.querySelector('.version-badge strong')?.textContent === arguments[0]",
        [version],
      ),
    'installed version badge',
  );
  assert.equal(await execute('return document.documentElement.lang'), 'en');
  assert.equal(await execute("return !!document.querySelector('.update-button')"), false);
  assert.deepEqual(await snapshot(location), before);
  await screenshot('update-complete');
  await writeFile(
    'test-results/windows-smoke/update-result.json',
    JSON.stringify(
      {
        from: '0.0.9',
        to: version,
        passed: true,
        checks: [
          'signed download',
          'in-app install',
          'automatic restart',
          'installed version',
          'project and record payloads',
          'revision history',
          'evidence hashes',
          'settings',
        ],
      },
      null,
      2,
    ),
  );
  return true;
}
