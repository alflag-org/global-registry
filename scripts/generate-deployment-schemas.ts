import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { deploymentManifestSchema, releaseManifestSchema } from './deployment-manifests';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const schemaDirectory = path.resolve(repositoryRoot, 'deployment/schemas');

const schemaDefinitions = [
  {
    fileName: 'release.schema.json',
    id: 'https://global-registry.example/schemas/release.schema.json',
    title: 'Global Registry release manifest',
    schema: releaseManifestSchema,
  },
  {
    fileName: 'deployment.schema.json',
    id: 'https://global-registry.example/schemas/deployment.schema.json',
    title: 'Global Registry deployment manifest',
    schema: deploymentManifestSchema,
  },
] as const;

const checkOnly = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some((argument) => argument !== '--check')) {
  throw new Error('Usage: generate-deployment-schemas.ts [--check]');
}

if (!checkOnly) await mkdir(schemaDirectory, { recursive: true });

for (const definition of schemaDefinitions) {
  const generated = {
    ...z.toJSONSchema(definition.schema, { unrepresentable: 'any' }),
    $id: definition.id,
    title: definition.title,
  };
  const expected = formatJson(generated);
  const outputPath = path.resolve(schemaDirectory, definition.fileName);
  if (checkOnly) {
    let actual: string;
    try {
      actual = await readFile(outputPath, 'utf8');
    } catch (error) {
      throw new Error(`Generated schema is missing: ${outputPath}`, { cause: error });
    }
    if (actual !== expected) {
      throw new Error(`Generated schema is stale: ${outputPath}`);
    }
  } else {
    await writeFile(outputPath, expected, { encoding: 'utf8', mode: 0o644 });
  }
}

function formatJson(value: unknown): string {
  const result = spawnSync('pnpm', ['exec', 'prettier', '--parser', 'json'], {
    cwd: repositoryRoot,
    input: `${JSON.stringify(value)}\n`,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Prettier failed while generating deployment schemas: ${result.stderr}`);
  }
  return result.stdout;
}
