import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = (await walk(root)).filter((file) => /\.(?:css|html|js|json|md|mjs|ya?ml)$/i.test(file));
let changed = 0;

for (const file of files) {
  const original = await readFile(file, 'utf8');
  let formatted = original.replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '');
  if (formatted && !formatted.endsWith('\n')) formatted += '\n';
  if (formatted === original) continue;
  await writeFile(file, formatted);
  changed += 1;
}

console.log(`Formatted ${changed} file${changed === 1 ? '' : 's'}; checked ${files.length}.`);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
