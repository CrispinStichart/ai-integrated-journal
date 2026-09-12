#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { loadLocalEnvironment, runCommand } from './local-start.mjs';

export async function runWithLocalEnvironment(command = process.argv.slice(2)) {
  if (command.length === 0) {
    throw new Error('Usage: with-local-env.mjs <command> [arguments...]');
  }
  loadLocalEnvironment();
  await runCommand(command);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWithLocalEnvironment().catch((error) => {
    process.stderr.write(
      `Local command failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
