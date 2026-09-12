import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseLocalEnvironment,
  startLocal,
  startupCommands,
} from './local-start.mjs';

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

function read(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

function expandRequirementReferences(source) {
  const identifiers = new Set();
  for (const match of source.matchAll(
    /\b([A-Z]+)-(\d{3})(?:–(?:([A-Z]+)-)?(\d{3}))?/gu,
  )) {
    const prefix = match[1];
    const first = Number(match[2]);
    const lastPrefix = match[3] ?? prefix;
    const last = Number(match[4] ?? match[2]);
    if (prefix !== lastPrefix || last < first) continue;
    for (let ordinal = first; ordinal <= last; ordinal += 1) {
      identifiers.add(`${prefix}-${String(ordinal).padStart(3, '0')}`);
    }
  }
  return identifiers;
}

test('local startup parses .env data without shell execution and expands prior keys', () => {
  const environment = parseLocalEnvironment(
    [
      'JOURNAL_DATABASE_PASSWORD=safe-password',
      'DATABASE_URL=postgresql://journal:${JOURNAL_DATABASE_PASSWORD}@127.0.0.1:5432/journal',
      'LITERAL=$(should-not-run)',
      'QUOTED="kept as data"',
    ].join('\n'),
    {},
  );
  assert.equal(environment.JOURNAL_DATABASE_PASSWORD, 'safe-password');
  assert.equal(
    environment.DATABASE_URL,
    'postgresql://journal:safe-password@127.0.0.1:5432/journal',
  );
  assert.equal(environment.LITERAL, '$(should-not-run)');
  assert.equal(environment.QUOTED, 'kept as data');
});

test('local startup fails closed on unresolved references and malformed assignments', () => {
  assert.throws(
    () => parseLocalEnvironment('DATABASE_URL=${MISSING}', {}),
    /Unresolved environment reference/u,
  );
  assert.throws(
    () => parseLocalEnvironment('not an assignment', {}),
    /Invalid .env assignment/u,
  );
});

test('prepare-only startup runs validated operations in the documented order', async () => {
  const executed = [];
  await startLocal({
    arguments_: ['--prepare-only'],
    execute: (command) => {
      executed.push([...command]);
      return Promise.resolve();
    },
    loadEnvironment: () => undefined,
  });
  assert.deepEqual(executed, [
    ...startupCommands.preflight,
    ...startupCommands.prepare,
  ]);
});

test('every normative product identifier has tracked automated evidence metadata', () => {
  const normative = new Set(
    [
      ...read('AI-Integrated-Journaling-Application-Specification.md').matchAll(
        /^\*\*([A-Z]+-\d{3})\*\*/gmu,
      ),
    ].map((match) => match[1]),
  );
  const evidenceFiles = trackedFiles().filter(
    (file) =>
      /\.(?:ts|mjs)$/u.test(file) &&
      (file.includes('/test/') ||
        file.startsWith('playwright/') ||
        file.startsWith('spikes/')),
  );
  const referenced = new Set();
  for (const file of evidenceFiles) {
    for (const identifier of expandRequirementReferences(read(file))) {
      referenced.add(identifier);
    }
  }
  const missing = [...normative].filter(
    (identifier) => !referenced.has(identifier),
  );
  assert.equal(normative.size, 182);
  assert.deepEqual(missing, []);
});

test('release documentation links and concrete evidence paths resolve', () => {
  const documents = [
    'README.md',
    'infrastructure/README.md',
    'docs/operations-and-release.md',
    'docs/configuration.md',
    'docs/backup-and-restore.md',
    'docs/export-format.md',
    'docs/retention-and-permanent-deletion.md',
    'docs/security-and-privacy-review.md',
    'docs/reliability-and-fault-testing.md',
    'docs/accessibility-firefox-mobile-validation.md',
    'docs/requirement-to-test-matrix.md',
  ];
  for (const document of documents) {
    const source = read(document);
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1];
      if (/^(?:https?:|#)/u.test(target)) continue;
      const withoutAnchor = target.split('#')[0];
      assert.ok(
        existsSync(
          path.resolve(repositoryRoot, path.dirname(document), withoutAnchor),
        ),
        `${document} links to missing ${target}`,
      );
    }
  }

  const matrix = read('docs/requirement-to-test-matrix.md');
  for (const match of matrix.matchAll(
    /`((?:apps|packages|playwright|scripts|docs|infrastructure)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|md|yaml))`/gu,
  )) {
    assert.ok(existsSync(path.join(repositoryRoot, match[1])), match[1]);
  }
});

test('release state and operational command wiring cannot drift silently', () => {
  const packageJson = JSON.parse(read('package.json'));
  for (const script of [
    'config:check',
    'local:start',
    'infra:up',
    'infra:down',
    'data:bootstrap',
    'db:migrate',
    'db:seed',
    'backup:init',
    'backup:create',
    'backup:restore',
    'test:operations',
    'validate',
  ]) {
    assert.equal(typeof packageJson.scripts[script], 'string', script);
  }
  for (const script of [
    'data:bootstrap',
    'db:migrate',
    'db:seed',
    'backup:init',
    'backup:create',
    'backup:restore',
  ]) {
    assert.match(packageJson.scripts[script], /scripts\/with-local-env\.mjs/u);
  }
  assert.match(
    read('docs/implementation-plan.md'),
    /### 55\. Operations and release documentation - FINISHED/u,
  );
  assert.doesNotMatch(
    read('docs/requirement-to-test-matrix.md'),
    /\| (?:Planned|Partial|Complete) \|/u,
  );
});
