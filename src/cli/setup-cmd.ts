/**
 * `bot setup` — create a `.env` file from the `.env.example` template.
 *
 * Never overwrites an existing `.env`. Never writes secrets unless the user
 * provides them; the template ships with empty credential placeholders.
 */

import { existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandHandler } from './context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function projectRoot(): string {
  // src/cli/setup-cmd.js -> project root is two levels up.
  return resolve(__dirname, '..', '..');
}

export const setupCommand: CommandHandler = (args): number => {
  if (args.includes('--help') || args.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log('Usage: bot setup\n\nCreates a .env file from .env.example (never overwrites).');
    return 0;
  }

  const root = projectRoot();
  const envPath = resolve(root, '.env');
  const examplePath = resolve(root, '.env.example');

  if (existsSync(envPath)) {
    // eslint-disable-next-line no-console
    console.error(
      '.env already exists at ' +
        envPath +
        '.\n' +
        'Refusing to overwrite. Edit it directly, or delete it and re-run setup.',
    );
    return 1;
  }

  if (!existsSync(examplePath)) {
    // eslint-disable-next-line no-console
    console.error('.env.example template not found at ' + examplePath);
    return 1;
  }

  copyFileSync(examplePath, envPath);
  // eslint-disable-next-line no-console
  console.log('Created ' + envPath);
  // eslint-disable-next-line no-console
  console.log('Edit it to add your exchange credentials and trading parameters, then run:');
  // eslint-disable-next-line no-console
  console.log('  bot paper   # to start safe simulated trading');
  return 0;
};
