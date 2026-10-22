// Downloads the real mode 80386 SingleStepTests (MIT licensed, about 500 MB, not committed):
// Daniel Balsom's tests captured from an Intel 386EX, 100 to 2,500 for each instruction form.
// Pass names to fetch only some, e.g. `npm run fetch:386 -- 00 6601 0FAF`.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '459d49fbe6280e9ed46fee887b58dacd9cb880ab';
const api = `https://api.github.com/repos/SingleStepTests/80386/contents/v1_ex_real_mode?ref=${COMMIT}`;
const base = `https://raw.githubusercontent.com/SingleStepTests/80386/${COMMIT}`;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', '80386');

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt === 3) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
}

const listing = JSON.parse((await download(api)).toString('utf8'));
const all = listing.map((entry) => entry.name).filter((name) => name.endsWith('.MOO.gz'));
const wanted = process.argv.length > 2 ? process.argv.slice(2).map((name) => `${name}.MOO.gz`) : all;
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'revocation_list.txt'), await download(`${base}/revocation_list.txt`));
await writeFile(join(outDir, '80386.csv'), await download(`${base}/80386.csv`));
let saved = 0;
// A few at a time: there are over 900 files.
const queue = wanted.filter((name) => !existsSync(join(outDir, name)));
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      await writeFile(join(outDir, name), await download(`${base}/v1_ex_real_mode/${name}`));
      saved++;
    }
  }),
);
console.log(`Saved ${saved} test files in ${outDir} (${wanted.length - saved} were already there)`);
