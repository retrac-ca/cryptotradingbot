#!/usr/bin/env node
/**
 * CLI entrypoint for the bot binary.
 */

import { run } from './cli/cli.js';

const exitCode = await run(process.argv.slice(2));
process.exit(exitCode);
