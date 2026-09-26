// Read-only heuristic audit. Never prints matched secret values or file contents.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function git(...args) {
  return execFileSync('git', ['-c', `core.excludesFile=${path.join(root, '.gitignore')}`, ...args],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const forbidden = /(^|\/)(artifacts|node_modules|browser-profiles)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:pem|key|har|crx|zip)$/i;
const signatures = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\b(?:sk|ts|jev)[-_][A-Za-z0-9_-]{24,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9_.-]{32,}/
];
const findings = new Set();
function inspect(file, content, version) {
  const label = `${version}:${file}`;
  if (forbidden.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') findings.add(`${label} (sensitive/generated path)`);
  if (signatures.some(pattern => pattern.test(content))) findings.add(`${label} (possible credential)`);
}
const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
for (const file of new Set(files)) {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Unexpected repository path');
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) inspect(file, fs.readFileSync(absolute, 'utf8'), 'worktree');
}
const revisions = git('rev-list', '--all').trim().split('\n').filter(Boolean);
for (const revision of revisions) {
  const paths = git('ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean);
  for (const file of paths) inspect(file, git('show', `${revision}:${file}`), revision.slice(0, 8));
}
if (findings.size) {
  console.error('Review required (values withheld):\n' + [...findings].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Heuristic audit passed: ${files.length} working/index paths, ${revisions.length} reachable commits. No network or files changed.`);
  console.log('Not a guarantee: manually review real posts, media, identifiers, unfamiliar key formats, licenses, and terms before publication.');
}
