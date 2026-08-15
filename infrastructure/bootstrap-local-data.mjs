import { mkdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repositoryRoot = await realpath(path.resolve(import.meta.dirname, '..'));
const configuredDirectory =
  process.env.BLOB_DATA_DIR ??
  path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'ai-integrated-journal',
    'blobs',
  );
const blobDataDirectory = path.resolve(configuredDirectory);

if (
  blobDataDirectory === repositoryRoot ||
  blobDataDirectory.startsWith(`${repositoryRoot}${path.sep}`)
) {
  throw new Error('BLOB_DATA_DIR must be outside the repository source tree');
}

await mkdir(blobDataDirectory, { recursive: true, mode: 0o700 });
await Promise.all(
  ['final', 'staging', 'temporary'].map((directory) =>
    mkdir(path.join(blobDataDirectory, directory), {
      recursive: true,
      mode: 0o700,
    }),
  ),
);

const metadata = await stat(blobDataDirectory);
if (!metadata.isDirectory()) {
  throw new Error('BLOB_DATA_DIR is not a directory');
}

console.log(blobDataDirectory);
