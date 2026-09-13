#!/usr/bin/env node
/**
 * Build a `.tracefold-plugin` package from a plugin source directory.
 *
 * The archive is deterministic: entries are sorted, timestamps are fixed and permissions
 * are normalised, so the same source always produces the same SHA-256. That matters
 * because the catalog pins each release by checksum, and a rebuild that changes the hash
 * would make an already-published entry fail verification.
 *
 *   node scripts/package-plugin.mjs plugins/tracefold-discovery [outputDirectory]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 512;

/** Build outputs, caches and local plugin data never belong in a published package. */
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'node_modules',
  '.tracefold',
  'data',
  'runtime',
  'exports',
]);
const EXCLUDED_SUFFIXES = ['.pyc', '.pyo', '.log', '.tracefold-plugin'];
const EXCLUDED_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.gitignore']);

function excluded(name) {
  return (
    EXCLUDED_DIRECTORIES.has(name) ||
    EXCLUDED_NAMES.has(name) ||
    EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

async function collect(root, directory = root, found = []) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (excluded(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(root, path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer. Deflate-compressed, fixed 1980-01-01 timestamps, forward-slash
 * paths — the shape the host's extractor expects, with nothing machine-specific in it.
 */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const useStored = compressed.byteLength >= data.byteLength;
    const payload = useStored ? data : compressed;
    const method = useStored ? 0 : 8;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // fixed time
    local.writeUInt16LE(33, 12); // fixed date: 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(33, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.byteLength, 20);
    header.writeUInt32LE(data.byteLength, 24);
    header.writeUInt16LE(nameBytes.byteLength, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    // Regular file, mode 0644. Multiplied rather than shifted: `<< 16` is a signed
    // 32-bit operation in JavaScript and would wrap this value negative.
    header.writeUInt32LE(0o100644 * 0x10000, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.byteLength + nameBytes.byteLength + payload.byteLength;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

async function main() {
  const [sourceArgument, outputArgument] = process.argv.slice(2);
  if (!sourceArgument) {
    throw new Error('Usage: node scripts/package-plugin.mjs PLUGIN_DIRECTORY [OUTPUT_DIRECTORY]');
  }
  const source = resolve(sourceArgument);
  const output = resolve(outputArgument ?? 'dist-plugins');

  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  for (const field of ['schema', 'id', 'name', 'version', 'publisher', 'apiVersion', 'runtime']) {
    if (manifest[field] === undefined) throw new Error(`manifest.json is missing "${field}".`);
  }
  if (manifest.schema !== 'tracefold.plugin.v1') {
    throw new Error(`Unsupported manifest schema: ${manifest.schema}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`Plugin version must be major.minor.patch, got "${manifest.version}".`);
  }

  const files = await collect(source);
  if (!files.length) throw new Error('The plugin directory contains no files.');
  if (files.length > MAX_FILES) {
    throw new Error(`A package may contain at most ${MAX_FILES} files; found ${files.length}.`);
  }

  const entries = [];
  let unpacked = 0;
  for (const path of files) {
    const name = relative(source, path).split(sep).join('/');
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${name} exceeds the 64 MiB per-file limit.`);
    unpacked += info.size;
    if (unpacked > MAX_TOTAL_UNPACKED_BYTES) {
      throw new Error('The unpacked package exceeds the 128 MiB limit.');
    }
    entries.push({ name, data: await readFile(path) });
  }
  if (!entries.some((entry) => entry.name === 'manifest.json')) {
    throw new Error('The package must contain a root manifest.json.');
  }
  const entrypoint = manifest.runtime?.entry;
  if (!entries.some((entry) => entry.name === entrypoint)) {
    throw new Error(`The runtime entrypoint "${entrypoint}" is not in the package.`);
  }

  const archive = buildZip(entries);
  if (archive.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error('The package exceeds the 256 MiB limit.');
  }

  await mkdir(output, { recursive: true });
  const filename = `${basename(source)}-v${manifest.version}.tracefold-plugin`;
  const destination = join(output, filename);
  await writeFile(destination, archive);

  const sha256 = createHash('sha256').update(archive).digest('hex');
  await writeFile(
    join(output, `${filename}.json`),
    `${JSON.stringify(
      {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        publisher: manifest.publisher,
        description: manifest.description ?? '',
        apiVersion: manifest.apiVersion,
        minTracefoldVersion: manifest.minTracefoldVersion,
        capabilities: manifest.capabilities ?? [],
        file: filename,
        size: archive.byteLength,
        sha256,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`${filename}`);
  console.log(`  files    ${entries.length}`);
  console.log(`  size     ${(archive.byteLength / 1024).toFixed(1)} KiB`);
  console.log(`  sha256   ${sha256}`);
}

await main();
