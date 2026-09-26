import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'extension');
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
const files = await fs.readdir(extension);
for (const file of files.filter(name => name.endsWith('.js'))) {
  const source = await fs.readFile(path.join(extension, file), 'utf8');
  new vm.Script(source, { filename: file });
  // Network is isolated to one auditable client, never a content script or demo.
  if (file !== 'jev-client.js' && /\bfetch(?:Impl)?\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|sendBeacon\s*\(/.test(source)) {
    throw new Error(`Unexpected network primitive in ${file}`);
  }
  if (manifest.content_scripts.some(entry => entry.js.includes(file)) && (/jevApiKey|storage\.session/.test(source) || (file !== 'adapter.js' && /https?:\/\//.test(source)))) {
    throw new Error(`Content script contains transport/secret access: ${file}`);
  }
  if (file === 'adapter.js' && [...source.matchAll(/https?:\/\/[^'"\s]+/g)].some(match => match[0] !== 'https://x.com')) throw new Error('Unexpected DOM link parsing origin');
}
for (const entry of manifest.content_scripts) {
  for (const file of [...entry.js, ...entry.css]) await fs.access(path.join(extension, file));
}
if (manifest.host_permissions || manifest.externally_connectable || manifest.web_accessible_resources) throw new Error('Unexpected privileged capability');
if (JSON.stringify(manifest.permissions) !== '["storage"]') throw new Error('Unexpected permission');
if (JSON.stringify(manifest.optional_host_permissions) !== '["https://api.typesafe.ai/*"]') throw new Error('Unexpected external host');
if (manifest.background?.service_worker !== 'background.js' || manifest.options_ui?.page !== 'options.html') throw new Error('Invalid background/options');
if (!manifest.content_security_policy.extension_pages.includes('connect-src https://api.typesafe.ai;')) throw new Error('Missing fixed connection policy');
for (const file of ['background.js', 'jev-core.js', 'jev-client.js', 'options.html']) await fs.access(path.join(extension, file));
if (manifest.content_scripts.flatMap(entry => entry.js).includes('jev-client.js')) throw new Error('Client must not run on X');
const demo = await fs.readFile(path.join(extension, 'demo.html'), 'utf8');
if (/jev-client|background\.js|content\.js|options\.js/.test(demo)) throw new Error('Demo must remain offline');
const client = await fs.readFile(path.join(extension, 'jev-client.js'), 'utf8');
const urls = [...client.matchAll(/https?:\/\/[^'"\s]+/g)].map(match => match[0]);
if (JSON.stringify(urls) !== '["https://api.typesafe.ai/v1/systemone"]') throw new Error('Unexpected client URL');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version || pkg.private !== true) throw new Error('Version/private package mismatch');
console.log('Extension syntax, minimal permissions, fixed Jev transport and offline content/demo checks passed.');
