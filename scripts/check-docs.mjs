import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const license = (await fs.readFile(path.join(root, 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n');
const bundled = (await fs.readFile(path.join(root, 'extension/LICENSE.txt'), 'utf8')).replace(/\r\n/g, '\n');
if (pkg.license !== 'MIT' || license !== bundled || !license.startsWith('MIT License\n') || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) throw new Error('MIT license metadata / bundled notice mismatch');
for (const file of ['README.md', 'PRIVACY.md', 'LIMITATIONS.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'docs/publishing.md', 'extension/about.html']) await fs.access(path.join(root, file));
const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
if (!readme.includes(`v${manifest.version}`)) throw new Error('README version mismatch');
if (!manifest.name.includes('β')) throw new Error('Manifest must identify the beta');
const skip = new Set(['.git', 'node_modules', 'artifacts']);
async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (/\.(md|html)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}
let links = 0;
for (const file of await walk(root)) {
  const text = await fs.readFile(file, 'utf8');
  const targets = file.endsWith('.md') ? [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]) : [...text.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]);
  for (let target of targets) {
    target = target.replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#|data:)/.test(target)) continue;
    target = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    const resolved = path.resolve(path.dirname(file), target);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`Link escapes repository: ${path.relative(root, file)}`);
    try { await fs.access(resolved); } catch { throw new Error(`Broken local link in ${path.relative(root, file)}: ${target}`); }
    links++;
  }
}
for (const file of ['options.html', 'popup.html']) {
  if (!(await fs.readFile(path.join(root, 'extension', file), 'utf8')).includes('href="about.html"')) throw new Error(`${file} lacks risk disclosure link`);
}
console.log(`Documentation, beta version, MIT notices and ${links} local links passed. External URLs are not fetched.`);
