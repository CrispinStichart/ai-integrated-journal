#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

export const startupCommands = Object.freeze({
  preflight: Object.freeze([
    Object.freeze(['corepack', 'pnpm', 'config:check']),
    Object.freeze(['docker', 'info', '--format', '{{.ServerVersion}}']),
  ]),
  prepare: Object.freeze([
    Object.freeze(['corepack', 'pnpm', 'infra:up']),
    Object.freeze(['corepack', 'pnpm', 'data:bootstrap']),
    Object.freeze(['corepack', 'pnpm', 'db:migrate']),
    Object.freeze(['corepack', 'pnpm', 'db:seed']),
  ]),
  serve: Object.freeze(['corepack', 'pnpm', 'dev']),
});

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Parse the deliberately simple KEY=value local file without executing it. */
export function parseLocalEnvironment(source, inherited = process.env) {
  const parsed = {};
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    if (separator < 1 || !/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid .env assignment on line ${String(index + 1)}.`);
    }
    const rawValue = unquote(line.slice(separator + 1).trim());
    parsed[key] = rawValue.replaceAll(
      /\$\{([A-Z][A-Z0-9_]*)\}/gu,
      (_, name) => {
        const replacement = parsed[name] ?? inherited[name];
        if (replacement === undefined) {
          throw new Error(
            `Unresolved environment reference on line ${String(index + 1)}.`,
          );
        }
        return replacement;
      },
    );
  }
  return parsed;
}

export function loadLocalEnvironment(
  filePath = path.join(repositoryRoot, '.env'),
) {
  let source;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Missing .env. Copy .env.example and replace its placeholders.',
        { cause: error },
      );
    }
    throw error;
  }
  const parsed = parseLocalEnvironment(source);
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] ??= value;
  }
}

function displayCommand(command) {
  return command.join(' ');
}

export async function runCommand(command) {
  const [executable, ...arguments_] = command;
  if (executable === undefined) throw new Error('Cannot run an empty command.');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${displayCommand(command)} failed${signal === null ? ` with exit code ${String(code)}` : ` after ${signal}`}.`,
          ),
        );
    });
  });
}

export async function startLocal({
  arguments_: arguments_ = process.argv.slice(2),
  execute = runCommand,
  loadEnvironment = loadLocalEnvironment,
} = {}) {
  arguments_ = arguments_.filter((argument) => argument !== '--');
  const supported = new Set(['--check', '--dry-run', '--prepare-only']);
  const unknown = arguments_.filter((argument) => !supported.has(argument));
  if (unknown.length > 0) {
    throw new Error(
      'Usage: local-start.mjs [--check | --dry-run | --prepare-only]',
    );
  }
  if (arguments_.length > 1) {
    throw new Error('Choose only one local-start option.');
  }

  loadEnvironment();
  const plan = [
    ...startupCommands.preflight,
    ...startupCommands.prepare,
    startupCommands.serve,
  ];
  if (arguments_.includes('--dry-run')) {
    for (const command of plan)
      process.stdout.write(`${displayCommand(command)}\n`);
    return;
  }

  for (const command of startupCommands.preflight) await execute(command);
  if (arguments_.includes('--check')) return;
  for (const command of startupCommands.prepare) await execute(command);
  if (!arguments_.includes('--prepare-only'))
    await execute(startupCommands.serve);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocal().catch((error) => {
    process.stderr.write(
      `Local startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
