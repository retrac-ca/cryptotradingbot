import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const webDir = join(repoRoot, 'web');
const builtDir = join(repoRoot, 'dist', 'dashboard');

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const full = join(dir, String(entry));
    if (existsSync(full) && statSync(full).isFile()) out.push(full);
  }
  return out;
}

function readAll(dir: string): { path: string; text: string }[] {
  return listFiles(dir).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

describe('dashboard source policy', () => {
  const sources = readAll(webDir);

  it('contains no hard-coded origins or loopback addresses', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toContain('127.0.0.1');
      expect(text, path).not.toContain('localhost');
      expect(text, path).not.toMatch(/https?:\/\/[^\s'"]+/);
    }
  });

  it('contains no credentials, environment access, or browser storage', () => {
    const forbidden = [
      'ndaxApiKey',
      'ndaxApiSecret',
      'NDAX_API_KEY',
      'NDAX_API_SECRET',
      'process.env',
      'localStorage',
      'sessionStorage',
    ];
    for (const { path, text } of sources) {
      for (const token of forbidden) {
        expect(text, `${path} -> ${token}`).not.toContain(token);
      }
    }
  });

  it('does not import application-domain modules', () => {
    const tsFiles = sources.filter((s) => s.path.endsWith('.ts'));
    for (const { path, text } of tsFiles) {
      expect(text, path).not.toMatch(/from\s+['"][^'"]*\/src\//);
      expect(text, path).not.toMatch(/from\s+['"]\.\.\/\.\.\/src/);
      expect(text, path).not.toMatch(/from\s+['"][^'"]*cryptotradingbot/);
    }
  });

  it('never parses monetary values with floating point in views/format/client', () => {
    const moneySensitive = sources.filter(
      (s) =>
        s.path.endsWith('.ts') &&
        (s.path.includes(`${join('web', 'src', 'views')}`) ||
          s.path.endsWith(`${join('web', 'src', 'format.ts')}`) ||
          s.path.endsWith(`${join('web', 'src', 'client.ts')}`)),
    );
    expect(moneySensitive.length).toBeGreaterThan(0);
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const { path, text } of moneySensitive) {
      const code = stripComments(text);
      expect(code, path).not.toMatch(/parseFloat/);
      expect(code, path).not.toMatch(/Number\s*\(/);
    }
  });

  it('built output (when present) contains no origins, credentials, or secrets', () => {
    if (!existsSync(builtDir)) return;
    const built = readAll(builtDir);
    expect(built.length).toBeGreaterThan(0);
    for (const { path, text } of built) {
      expect(text, path).not.toContain('127.0.0.1');
      expect(text, path).not.toContain('localhost');
      expect(text, path).not.toContain('ndaxApiKey');
      expect(text, path).not.toContain('ndaxApiSecret');
      expect(text, path).not.toContain('process.env');
    }
  });
});
