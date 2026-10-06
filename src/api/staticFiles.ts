/**
 * StaticAssets — a strictly confined static-file reader for the dashboard UI.
 *
 * SAFETY / SECURITY
 *   - Only files under an explicitly configured root directory are readable.
 *   - Path traversal (`..`, encoded `..`, backslashes, NUL bytes) is rejected.
 *   - Dotfiles/dot-directories are rejected, so `.env`, `.git`, etc. can never
 *     be served even if present under the root.
 *   - Only a small allowlist of web-asset extensions is served; source files
 *     (`.ts`, `.map`), state files, and arbitrary repository files are not.
 *   - Symlinks are rejected (lstat), so a link cannot escape the root.
 *   - `index.html` is served for `/`.
 *
 * This module performs filesystem READS ONLY. It is unaware of the monitoring
 * domain and is used by the HTTP server solely to serve UI assets.
 */

import { readFile, lstat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export interface StaticAsset {
  body: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export class StaticAssets {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  get rootDir(): string {
    return this.root;
  }

  /**
   * Resolve a URL pathname to a readable asset, or `null` when it is not an
   * allowed file under the root. Never throws.
   */
  async read(requestPath: string): Promise<StaticAsset | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(requestPath);
    } catch {
      return null;
    }

    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    if (decoded.includes('?') || decoded.includes('#')) return null;

    let relative = decoded;
    if (relative === '' || relative === '/') relative = '/index.html';
    if (!relative.startsWith('/')) return null;

    const segments = relative.split('/').filter((segment) => segment.length > 0);
    for (const segment of segments) {
      if (segment === '.' || segment === '..') return null;
      if (segment.startsWith('.')) return null;
    }

    const contentType = CONTENT_TYPES[extname(relative).toLowerCase()];
    if (!contentType) return null;

    const candidate = resolve(this.root, `.${relative}`);
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) return null;

    try {
      const info = await lstat(candidate);
      if (!info.isFile()) return null;
      const body = await readFile(candidate);
      return { body, contentType };
    } catch {
      return null;
    }
  }
}
