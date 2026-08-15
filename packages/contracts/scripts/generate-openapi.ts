import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeOpenApiDocument } from '../src/openapi.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputPath = path.join(packageRoot, 'openapi', 'openapi.json');
const generated = serializeOpenApiDocument();

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== generated) {
    console.error(
      'Generated OpenAPI is stale. Run `pnpm openapi:generate` and commit the result.',
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated);
  console.log(`Generated ${path.relative(packageRoot, outputPath)}.`);
}
