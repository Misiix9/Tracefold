#!/usr/bin/env node
/**
 * Regenerate `catalog/catalog.json` from the metadata that `package-plugin.mjs` emits.
 *
 * Every version already published keeps its recorded checksum and URL untouched: a
 * published entry is a promise that a specific artifact will verify, and rewriting it
 * would break installs for anyone whose catalog fetch lands mid-change. New versions are
 * added; existing ones are only ever left alone.
 *
 *   node scripts/build-catalog.mjs dist-plugins
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const CATALOG_PATH = resolve('catalog/catalog.json');
const SCHEMA = 'tracefold.catalog.v1';

/** Where a published plugin artifact lives. Kept in one place so it is easy to move. */
function artifactUrl(id, version, file) {
  const tag = `plugin-${id.replace(/[^A-Za-z0-9._-]/g, '-')}-v${version}`;
  return `https://github.com/Misiix9/Tracefold/releases/download/${tag}/${encodeURIComponent(file)}`;
}

async function readCatalog() {
  try {
    const existing = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
    if (existing.schema !== SCHEMA) throw new Error(`Unsupported catalog schema: ${existing.schema}`);
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schema: SCHEMA, updated: '', plugins: [] };
  }
}

/**
 * Verify that every catalog entry whose package was rebuilt still matches its recorded
 * checksum. A drift here means the catalog promises an artifact the source no longer
 * produces, which only shows up as a failed install for users.
 */
async function check(input, catalog, metadataFiles) {
  const problems = [];
  for (const name of metadataFiles.sort()) {
    const meta = JSON.parse(await readFile(join(input, name), 'utf8'));
    const plugin = catalog.plugins.find((candidate) => candidate.id === meta.id);
    const entry = plugin?.versions.find((version) => version.version === meta.version);
    if (!entry) {
      problems.push(`${meta.id} ${meta.version} is built but missing from the catalog`);
      continue;
    }
    if (entry.sha256 !== meta.sha256) {
      problems.push(
        `${meta.id} ${meta.version} checksum drifted\n    catalog ${entry.sha256}\n    built   ${meta.sha256}`,
      );
      continue;
    }
    if (entry.size !== meta.size) {
      problems.push(`${meta.id} ${meta.version} size drifted: catalog ${entry.size}, built ${meta.size}`);
      continue;
    }
    if (entry.minTracefoldVersion !== meta.minTracefoldVersion || entry.apiVersion !== meta.apiVersion) {
      problems.push(`${meta.id} ${meta.version} compatibility fields disagree with its manifest`);
      continue;
    }
    console.log(`ok  ${meta.id} ${meta.version}  ${meta.sha256}`);
  }
  if (problems.length) {
    throw new Error(`Catalog does not match the built packages:\n  - ${problems.join('\n  - ')}`);
  }
  console.log(`\n${metadataFiles.length} package(s) match catalog/catalog.json.`);
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--check');
  const input = resolve(args.find((value) => !value.startsWith('--')) ?? 'dist-plugins');
  const catalog = await readCatalog();

  const metadataFiles = (await readdir(input)).filter((name) => name.endsWith('.tracefold-plugin.json'));
  if (!metadataFiles.length) {
    throw new Error(`No packaged plugins found in ${input}. Run scripts/package-plugin.mjs first.`);
  }

  if (verifyOnly) {
    await check(input, catalog, metadataFiles);
    return;
  }

  let added = 0;
  for (const name of metadataFiles.sort()) {
    const meta = JSON.parse(await readFile(join(input, name), 'utf8'));
    let plugin = catalog.plugins.find((candidate) => candidate.id === meta.id);
    if (!plugin) {
      plugin = {
        id: meta.id,
        name: meta.name,
        publisher: meta.publisher,
        description: meta.description,
        category: meta.category ?? '',
        homepage: '',
        versions: [],
      };
      catalog.plugins.push(plugin);
    }
    // Descriptive fields track the newest package; identity and history do not.
    plugin.name = meta.name;
    plugin.publisher = meta.publisher;
    plugin.description = meta.description;

    if (plugin.versions.some((version) => version.version === meta.version)) {
      console.log(`unchanged  ${meta.id} ${meta.version}`);
      continue;
    }
    plugin.versions.push({
      version: meta.version,
      apiVersion: meta.apiVersion,
      minTracefoldVersion: meta.minTracefoldVersion,
      url: artifactUrl(meta.id, meta.version, meta.file),
      sha256: meta.sha256,
      size: meta.size,
      capabilities: meta.capabilities ?? [],
      published: new Date().toISOString(),
      notes: '',
    });
    added += 1;
    console.log(`added      ${meta.id} ${meta.version}  ${meta.sha256}`);
  }

  const order = (value) => value.split('.').map(Number);
  for (const plugin of catalog.plugins) {
    plugin.versions.sort((a, b) => {
      const [aMajor, aMinor, aPatch] = order(a.version);
      const [bMajor, bMinor, bPatch] = order(b.version);
      return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
    });
  }
  catalog.plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (added) catalog.updated = new Date().toISOString();

  await writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`\n${catalog.plugins.length} plugin(s), ${added} new version(s) -> catalog/catalog.json`);
}

await main();
