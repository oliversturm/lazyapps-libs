import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const license = readFileSync(join(root, 'LICENSE'), 'utf8');
const packagesDir = join(root, 'packages');

readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .forEach((d) => {
    writeFileSync(join(packagesDir, d.name, 'LICENSE'), license);
  });

console.log('Copied LICENSE to all packages.');
