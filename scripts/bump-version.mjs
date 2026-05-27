import { readFileSync, writeFileSync } from 'node:fs';

const infoPath = new URL('../src/lib/appInfo.ts', import.meta.url);
const versionPath = new URL('../version.json', import.meta.url);

let source = readFileSync(infoPath, 'utf8');
const match = source.match(/version:\s*'(\d+)\.(\d{4})'/);
if (!match) throw new Error('APP_INFO version not found');

const major = match[1];
const nextPatch = String(Number(match[2]) + 1).padStart(4, '0');
const nextVersion = `${major}.${nextPatch}`;

source = source.replace(/version:\s*'\d+\.\d{4}'/, `version: '${nextVersion}'`);
writeFileSync(infoPath, source);

const now = new Date();
writeFileSync(versionPath, JSON.stringify({
  version: nextVersion,
  buildDate: now.toLocaleString('de-DE'),
}, null, 2) + '\n');

console.log(`Vecstructi Version ${nextVersion}`);
