import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dependencyRoot = path.join(repositoryRoot, 'node_modules');
const localAuthScript = path.join(repositoryRoot, 'scripts/local-auth-regression.mjs');
const vitestExecutable = path.join(dependencyRoot, '.bin/vitest');
const before = await snapshotDependencyLinks(dependencyRoot);
let localAuthError;

try {
  await executeFile(process.execPath, [localAuthScript], {
    cwd: repositoryRoot,
    env: { ...process.env, CI: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (error) {
  localAuthError = error;
}

const after = await snapshotDependencyLinks(dependencyRoot);
const changes = describeChanges(before, after);
if (localAuthError !== undefined) {
  const output = `${localAuthError.stdout ?? ''}\n${localAuthError.stderr ?? ''}`.trim();
  const dependencyDetails =
    changes.length === 0
      ? 'Caller dependency links were unchanged.'
      : `Caller dependency links changed:\n${changes.join('\n')}`;
  throw new Error(
    `Local auth regression failed.\n${dependencyDetails}${output.length > 0 ? `\n${output}` : ''}`,
    { cause: localAuthError },
  );
}

if (changes.length > 0) {
  throw new Error(`Local auth regression changed caller dependency links:\n${changes.join('\n')}`);
}

try {
  await access(vitestExecutable, constants.X_OK);
  const result = await executeFile(vitestExecutable, ['--version'], {
    cwd: repositoryRoot,
    env: { ...process.env, CI: '1' },
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.stdout.trim().length === 0) {
    throw new Error('Vitest executable returned no version output.');
  }
} catch (error) {
  const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim();
  throw new Error(
    `The subsequent Vitest executable could not be resolved after local auth.${output.length > 0 ? `\n${output}` : ''}`,
    { cause: error },
  );
}

globalThis.console.log(
  `Local auth dependency-tree regression passed: ${before.size} caller dependency links remained unchanged and the subsequent Vitest executable remained resolvable.`,
);

async function snapshotDependencyLinks(root) {
  const links = new Map();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    await recordSymlink(root, entryPath, entry.name, links);
    if (entry.isDirectory() && (entry.name === '.bin' || entry.name.startsWith('@'))) {
      const children = await readdir(entryPath, { withFileTypes: true });
      for (const child of children) {
        await recordSymlink(root, path.join(entryPath, child.name), child.name, links);
      }
    }
  }
  return links;
}

async function recordSymlink(root, entryPath, entryName, links) {
  const information = await lstat(entryPath);
  if (!information.isSymbolicLink()) return;
  links.set(path.relative(root, entryPath), `${entryName} -> ${await readlink(entryPath)}`);
}

function describeChanges(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].sort().flatMap((name) => {
    const previous = before.get(name);
    const current = after.get(name);
    if (previous === current) return [];
    if (previous === undefined) return [`+ ${name}: ${current}`];
    if (current === undefined) return [`- ${name}: ${previous}`];
    return [`~ ${name}: ${previous} => ${current}`];
  });
}
