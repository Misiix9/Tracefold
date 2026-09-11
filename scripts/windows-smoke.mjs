// Runs only in an isolated GitHub Windows runner against the installed NSIS app.
// The driver comes directly from Microsoft and is never bundled with Tracefold.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('This installer smoke test is restricted to Windows CI.');
const directory = 'test-results/windows-smoke';
await mkdir(directory, { recursive: true });
const driver = spawn(resolve('driver/msedgedriver.exe'), ['--port=9515', '--verbose'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let driverLog = '';
driver.stdout.on('data', (value) => {
  driverLog += value;
});
driver.stderr.on('data', (value) => {
  driverLog += value;
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path, body, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:9515${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}
async function until(task, description, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(200);
  }
  throw new Error(`${description}: ${last ?? 'timed out'}`);
}
let session;
let application;
let appLog = '';
const execute = (script, args = []) =>
  request(`/session/${session}/execute/sync`, { script, args });
const button = async (text) => {
  const element = await until(
    () =>
      request(`/session/${session}/element`, {
        using: 'xpath',
        value: `//button[normalize-space(.)='${text}']`,
      }),
    `button ${text}`,
  );
  await request(
    `/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`,
    {},
  );
};
const type = async (selector, text) => {
  const element = await request(`/session/${session}/element`, {
    using: 'css selector',
    value: selector,
  });
  const path = `/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}`;
  await request(`${path}/clear`, {});
  await request(`${path}/value`, { text });
};
async function open() {
  application = spawn(process.env.TRACEFOLD_SMOKE_BINARY, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  application.stdout.on('data', (value) => {
    appLog += value;
  });
  application.stderr.on('data', (value) => {
    appLog += value;
  });
  application.on('exit', (code) => {
    appLog += `\nApplication exit: ${code}\n`;
  });
  application.on('error', (error) => {
    appLog += `\n${error}\n`;
  });
  await until(async () => {
    if (application.exitCode !== null) throw new Error(`App exited: ${application.exitCode}`);
    const response = await fetch('http://127.0.0.1:9222/json/version', {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  }, 'installed WebView2 startup');
  const created = await request('/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'webview2',
        'ms:edgeOptions': { debuggerAddress: '127.0.0.1:9222' },
      },
    },
  });
  session = created.sessionId;
  await until(
    () =>
      execute(
        "return document.querySelector('.sidebar') && !document.body.textContent.includes('Helyi jegyzetek és projektek betöltése.');",
      ),
    'workspace startup',
  );
}
async function screenshot(name) {
  const png = await request(`/session/${session}/screenshot`, undefined, 'GET');
  await writeFile(`${directory}/${name}.png`, Buffer.from(png, 'base64'));
}
try {
  await until(() => request('/status', undefined, 'GET'), 'Microsoft driver startup');
  await open();
  assert.equal(await execute('return document.documentElement.lang'), 'hu');
  await button('Gyorsjegyzet');
  await until(
    () => execute('return !!document.querySelector("[aria-label=\"Cím\"]")'),
    'note editor',
  );
  await type('[aria-label="Cím"]', 'Windows beta smoke');
  await type('[contenteditable="true"]', 'Árvíztűrő tükörfúrógép — native Windows persistence.');
  await until(
    () => execute("return document.body.textContent.includes('Helyben mentve')"),
    'note saved',
  );
  await screenshot('hungarian-note');
  await button('Beállítások és helyreállítás');
  await execute(
    "const label=[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Nyelv')); const select=label.querySelector('select'); select.value='en'; select.dispatchEvent(new Event('change',{bubbles:true}));",
  );
  await until(
    () => execute("return document.documentElement.lang==='en'"),
    'English language switch',
  );
  await button('Back up now');
  await until(
    () =>
      execute(
        "return !document.body.textContent.includes('Working…') && document.body.textContent.includes('Restore copy')",
      ),
    'native recovery backup',
  );
  await screenshot('english-settings');
  await request(`/session/${session}`, undefined, 'DELETE');
  session = undefined;
  // Saves were confirmed before terminating this isolated CI app process.
  application.kill();
  await until(() => application.exitCode !== null, 'app process exit');
  await delay(1000);
  await open();
  assert.equal(await execute('return document.documentElement.lang'), 'en');
  await execute(
    "[...document.querySelectorAll('nav button')].find(e=>e.textContent.includes('Notebook')).click()",
  );
  await until(
    () => execute("return document.body.textContent.includes('Windows beta smoke')"),
    'saved note survives restart',
  );
  await screenshot('reopened-notebook');
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify(
      {
        passed: true,
        checks: [
          'NSIS install',
          'native startup',
          'Hungarian default',
          'rich text save',
          'English switch',
          'recovery backup',
          'restart persistence',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/windows-smoke-diagnostics.ps1'], {
    stdio: 'inherit',
    timeout: 15000,
  });
  if (session) {
    await screenshot('failure').catch(() => {});
    await writeFile(
      `${directory}/failure.txt`,
      await execute('return document.body.innerText').catch(() => 'UI unavailable'),
    );
  }
  throw error;
} finally {
  if (session) await request(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  application?.kill();
  driver.kill();
  await writeFile(`${directory}/app.log`, appLog);
  await writeFile(`${directory}/driver.log`, driverLog);
}
