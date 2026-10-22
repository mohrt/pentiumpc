// Downloads the freely distributable games listed in games-catalog.json into
// public/games/ and writes the index.json the page reads. The files themselves
// are kept out of git; the deploy workflow runs this too. A game whose download
// fails or no longer matches its checksum is left out with a warning.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'public', 'games');
const catalog = JSON.parse(await readFile(join(scriptDir, 'games-catalog.json'), 'utf8'));

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** One file from a .zip (stored or deflated), found through the central directory. */
function unzipEntry(zip, wanted) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip file');
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const skip = nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    offset += 46 + skip;
  }
  throw new Error(`${wanted} is not in the zip`);
}

await mkdir(outDir, { recursive: true });
const games = [];
for (const game of catalog.games) {
  try {
    let bytes = await download(game.url);
    if (sha256(bytes) !== game.sha256) throw new Error('the download has changed (checksum mismatch)');
    if (game.gzip) bytes = gunzipSync(bytes);
    if (game.zipEntry) bytes = unzipEntry(bytes, game.zipEntry);
    await writeFile(join(outDir, game.file), bytes);

    let licenseUrl = game.licenseUrl;
    if (game.licenseFile) {
      // Licences such as MIT and GPL must be shipped with the copies.
      const licenseName = `${game.file}.license.txt`;
      await writeFile(join(outDir, licenseName), await download(game.licenseFile));
      licenseUrl = `games/${licenseName}`;
    }
    games.push({
      title: game.title,
      file: game.file,
      credit: game.credit,
      license: game.license,
      licenseUrl,
      sourceUrl: game.sourceUrl,
      hint: game.hint,
    });
    console.log(`Saved public/games/${game.file}`);
  } catch (error) {
    console.warn(`Skipping ${game.title}: ${error.message}`);
  }
}

games.sort((a, b) => a.title.localeCompare(b.title));
await writeFile(join(outDir, 'index.json'), `${JSON.stringify({ games }, null, 2)}\n`);
console.log(`Listed ${games.length} of ${catalog.games.length} games in public/games/index.json`);
