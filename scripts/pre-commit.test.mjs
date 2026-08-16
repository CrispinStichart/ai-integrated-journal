import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldSkipValidation } from './pre-commit.mjs';

test('skips validation when every staged file is Markdown', () => {
  assert.equal(
    shouldSkipValidation(['README.md', 'docs/architecture.MARKDOWN']),
    true,
  );
});

test('skips validation when every staged file is in .devcontainer', () => {
  assert.equal(
    shouldSkipValidation([
      '.devcontainer/Dockerfile',
      '.devcontainer/scripts/setup.sh',
    ]),
    true,
  );
});

test('skips validation when every staged file is in .git', () => {
  assert.equal(
    shouldSkipValidation(['.git/config', '.git/hooks/pre-commit']),
    true,
  );
});

test('runs validation for mixed exempt categories', () => {
  assert.equal(
    shouldSkipValidation(['README.md', '.devcontainer/Dockerfile']),
    false,
  );
});

test('runs validation when a staged project file is present', () => {
  assert.equal(
    shouldSkipValidation(['README.md', 'apps/web/src/main.ts']),
    false,
  );
});

test('runs validation when no staged paths are reported', () => {
  assert.equal(shouldSkipValidation([]), false);
});
