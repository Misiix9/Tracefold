import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// All inputs are local CI artifacts. Publication is a separate workflow step.
const [input, output, tag] = process.argv.slice(2);
if (!input || !output || !/^v\d+\.\d+\.\d+$/.test(tag ?? ''))
  throw new Error(
    'Usage: node scripts/prepare-release.mjs ARTIFACT_DIRECTORY OUTPUT_DIRECTORY vX.Y.Z',
  );
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (tag !== `v${config.version}` || pkg.version !== config.version)
  throw new Error('Release tag, package.json and Tauri versions must match.');
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
if (cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] !== config.version)
  throw new Error('Cargo version must match the release.');
if (resolve(input) === resolve(output)) throw new Error('Output must be separate from input.');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const artifacts = await files(input);
const targets = [
  ['windows-x86_64', 'windows-x64', /\.exe$/],
  ['darwin-aarch64', 'macos-universal', /\.app\.tar\.gz$/],
  ['darwin-x86_64', 'macos-universal', /\.app\.tar\.gz$/],
  ['linux-x86_64', 'linux-x64', /\.AppImage$/],
];
const manifest = {
  version: config.version,
  notes: `Tracefold ${config.version}`,
  pub_date: new Date().toISOString(),
  platforms: {},
};
const copies = new Map();
for (const [target, folder, pattern] of targets) {
  const matches = artifacts.filter(
    (path) => path.split(/[\\/]/).includes(`tracefold-${folder}`) && pattern.test(path),
  );
  if (matches.length !== 1)
    throw new Error(`Expected exactly one ${target} updater artifact, got ${matches.length}.`);
  const artifact = matches[0];
  const signatureFile = `${artifact}.sig`;
  const checked = spawnSync(
    'cargo',
    [
      'run',
      '--quiet',
      '--locked',
      '--manifest-path',
      'scripts/release-check/Cargo.toml',
      '--',
      config.plugins.updater.pubkey,
      artifact,
      signatureFile,
    ],
    { stdio: 'inherit' },
  );
  if (checked.status !== 0) throw new Error(`Signature verification failed for ${target}.`);
  const signature = (await readFile(signatureFile, 'utf8')).trim();
  manifest.platforms[target] = {
    signature,
    url: `https://github.com/Misiix9/Tracefold/releases/download/${tag}/${encodeURIComponent(basename(artifact))}`,
  };
}
// Copy only distribution files, rejecting name collisions across architectures.
for (const artifact of artifacts.filter((path) =>
  /(?:\.exe|\.exe\.sig|\.app\.tar\.gz|\.app\.tar\.gz\.sig|\.dmg|\.deb|\.AppImage|\.AppImage\.sig)$/.test(
    path,
  ),
)) {
  const name = basename(artifact);
  if (copies.has(name)) throw new Error(`Duplicate release filename: ${name}`);
  copies.set(name, artifact);
}
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Release output must be empty.');
const checksums = [];
for (const [name, path] of copies) {
  await copyFile(path, join(output, name));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(join(output, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
console.log(`Prepared verified ${tag} release for ${Object.keys(manifest.platforms).join(', ')}.`);
