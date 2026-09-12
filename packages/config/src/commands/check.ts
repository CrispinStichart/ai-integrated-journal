import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseEnvironment } from '../index.js';

process.on('uncaughtException', (error) => {
  process.stderr.write(`Local configuration is invalid: ${error.message}\n`);
  process.exitCode = 1;
});

const config = parseEnvironment(process.env);

const databasePassword = process.env.JOURNAL_DATABASE_PASSWORD;
if (
  databasePassword === undefined ||
  databasePassword === '' ||
  databasePassword.startsWith('replace-with-')
) {
  throw new Error(
    'JOURNAL_DATABASE_PASSWORD must be set to a non-placeholder local password.',
  );
}
if (!/^[A-Za-z0-9._~-]+$/u.test(databasePassword)) {
  throw new Error(
    'JOURNAL_DATABASE_PASSWORD must contain only URL-safe unreserved characters.',
  );
}

const configuredUrl = new URL(process.env.DATABASE_URL as string);
if (decodeURIComponent(configuredUrl.password) !== databasePassword) {
  throw new Error(
    'DATABASE_URL password must match JOURNAL_DATABASE_PASSWORD after .env expansion.',
  );
}

const repositoryRoot = await realpath(
  path.resolve(import.meta.dirname, '../../../..'),
);
const blobDirectory = path.resolve(config.blobDataDirectory);
if (
  blobDirectory === repositoryRoot ||
  blobDirectory.startsWith(`${repositoryRoot}${path.sep}`)
) {
  throw new Error('BLOB_DATA_DIR must be outside the repository source tree.');
}

let writableAncestor = blobDirectory;
while (true) {
  try {
    const metadata = await stat(writableAncestor);
    if (writableAncestor === blobDirectory && !metadata.isDirectory()) {
      throw new Error('BLOB_DATA_DIR must be a directory.');
    }
    await access(writableAncestor, constants.W_OK);
    break;
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      if (
        error instanceof Error &&
        error.message === 'BLOB_DATA_DIR must be a directory.'
      ) {
        throw error;
      }
      throw new Error(
        'BLOB_DATA_DIR is not writable by the current OS account.',
        { cause: error },
      );
    }
    const parent = path.dirname(writableAncestor);
    if (parent === writableAncestor) {
      throw new Error('BLOB_DATA_DIR has no writable existing ancestor.', {
        cause: error,
      });
    }
    writableAncestor = parent;
  }
}

process.stdout.write(
  'Local configuration is valid; no secret values were printed.\n',
);
