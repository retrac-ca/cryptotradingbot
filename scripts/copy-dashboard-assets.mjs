// Copy the static dashboard shell (HTML/CSS) next to the compiled browser JS in
// dist/dashboard. The browser JS itself is emitted by `tsc -p web/tsconfig.json`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webDir = join(repoRoot, 'web');
const outDir = join(repoRoot, 'dist', 'dashboard');

mkdirSync(outDir, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  copyFileSync(join(webDir, file), join(outDir, file));
}

process.stdout.write(`Copied dashboard static assets to ${outDir}\n`);
