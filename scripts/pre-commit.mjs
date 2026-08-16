import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const isMarkdown = (filePath) => /\.(?:md|markdown)$/iu.test(filePath);
const isInDirectory = (directory) => (filePath) =>
  filePath === directory || filePath.startsWith(`${directory}/`);

export function shouldSkipValidation(filePaths) {
  if (filePaths.length === 0) return false;

  return [
    isMarkdown,
    isInDirectory('.devcontainer'),
    isInDirectory('.git'),
  ].some((matchesExemptCategory) => filePaths.every(matchesExemptCategory));
}

function stagedFilePaths() {
  const result = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'],
    { encoding: 'buffer' },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((filePath) => filePath.length > 0);
}

function runValidation() {
  const result = spawnSync('corepack', ['pnpm', 'validate'], {
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

export function main() {
  const filePaths = stagedFilePaths();

  if (shouldSkipValidation(filePaths)) {
    console.log(
      '[INFO] Only Markdown, .devcontainer, or .git changes are staged; skipping validation.',
    );
    return;
  }

  runValidation();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
