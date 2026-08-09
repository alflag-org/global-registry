import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkDomainBoundary } from './check-domain-boundary.mjs';

const fixtureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/domain-boundary',
);
const execFileAsync = promisify(execFile);
const cases = [
  {
    fixture: 'r2-forbidden-domain.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  { fixture: 'r2-forbidden-api.txt', expected: 'r2 adapters may import only application/ports' },
  {
    fixture: 'r2-forbidden-adapter.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-comment.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-template.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-dynamic.txt',
    expected: 'Cannot classify dynamic import',
  },
  {
    fixture: 'r2-forbidden-reexport.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-require.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-import-equals.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-path-normalization.txt',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-external.txt',
    expected: 'r2 adapters are port-only',
  },
  {
    fixture: 'd1-forbidden-cross-layer.txt',
    directory: 'adapters/d1',
    expected: 'imports concrete adapter',
  },
  {
    fixture: 'r2-forbidden-tsx.tsx',
    extension: '.tsx',
    rewriteFrom: '../../../src/api/app',
    rewriteTo: '../../api/app',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-mts.mts',
    extension: '.mts',
    rewriteFrom: '../../../src/api/app',
    rewriteTo: '../../api/app',
    expected: 'r2 adapters may import only application/ports',
  },
  {
    fixture: 'r2-forbidden-cts.cts',
    extension: '.cts',
    rewriteFrom: '../../../src/api/app',
    rewriteTo: '../../api/app',
    expected: 'r2 adapters may import only application/ports',
  },
  { fixture: 'r2-valid-ports.txt', expected: undefined },
  { fixture: 'r2-valid-platform.txt', expected: undefined },
  { fixture: 'r2-valid-standard-library.txt', expected: undefined },
];
const temporarySourceRoot = await mkdtemp(path.join(os.tmpdir(), 'global-registry-boundary-'));

try {
  for (const directory of [
    'domain',
    'application',
    'api/routes',
    'adapters/access',
    'adapters/d1',
    'adapters/queue',
    'adapters/r2',
  ]) {
    await mkdir(path.join(temporarySourceRoot, directory), { recursive: true });
  }
  await mkdir(path.join(temporarySourceRoot, 'domain/models'), { recursive: true });
  await writeFile(path.join(temporarySourceRoot, 'api/app.ts'), 'export const app = true;\n');
  await writeFile(
    path.join(temporarySourceRoot, 'domain/models/global-registry.ts'),
    'export type Resource = unknown;\n',
  );
  await writeFile(
    path.join(temporarySourceRoot, 'application/ports.ts'),
    'export type ExportPersistencePort = unknown;\n',
  );
  await writeFile(
    path.join(temporarySourceRoot, 'adapters/d1/repository.ts'),
    'export const repository = true;\n',
  );
  await writeFile(
    path.join(temporarySourceRoot, 'adapters/r2/exporter.ts'),
    'export const exporter = true;\n',
  );

  for (const testCase of cases) {
    const directory = testCase.directory ?? 'adapters/r2';
    const extension = testCase.extension ?? '.ts';
    const target = path.join(temporarySourceRoot, directory, `fixture${extension}`);
    await copyFile(path.join(fixtureDirectory, testCase.fixture), target);
    if (testCase.rewriteFrom !== undefined && testCase.rewriteTo !== undefined) {
      const source = await readFile(target, 'utf8');
      await writeFile(target, source.replaceAll(testCase.rewriteFrom, testCase.rewriteTo));
    }
    try {
      const violations = await checkDomainBoundary(temporarySourceRoot);
      if (testCase.expected === undefined) {
        if (violations.length > 0) {
          throw new Error(
            `Valid R2 application-port fixture was rejected: ${violations.join('; ')}`,
          );
        }
      } else if (!violations.some((violation) => violation.includes(testCase.expected))) {
        throw new Error(
          `Forbidden fixture ${testCase.fixture} was not rejected: ${violations.join('; ')}`,
        );
      }
    } finally {
      await rm(target, { force: true });
    }
  }
  await assertRejectedUnsupportedSourceFiles(temporarySourceRoot);
  await assertRejectedSpecialSourceEntries(temporarySourceRoot);
  await assertRejectedTraversalImport(temporarySourceRoot);
  await assertRejectedModuleSpecifierForms(temporarySourceRoot);
} finally {
  await rm(temporarySourceRoot, { recursive: true, force: true });
}

globalThis.console.log(
  `Domain boundary regression fixtures passed: ${cases.length + 3} extension, syntax, import-boundary, cross-layer, positive, and unknown-source-form cases were classified fail-closed.`,
);

async function assertRejectedUnsupportedSourceFiles(sourceRoot) {
  const cases = [
    { filename: 'terra-unsupported.foo', expected: 'terra-unsupported.foo' },
    { filename: 'terra-no-extension', expected: 'terra-no-extension' },
  ];
  for (const testCase of cases) {
    const target = path.join(sourceRoot, 'adapters/r2', testCase.filename);
    await writeFile(target, "import '../../../src/api/app';\n");
    try {
      const violations = await checkDomainBoundary(sourceRoot);
      if (
        !violations.some(
          (violation) =>
            violation.includes('Unsupported source file suffix or name form') &&
            violation.includes(testCase.expected),
        )
      ) {
        throw new Error(
          `Unsupported source file ${testCase.filename} was accepted: ${violations.join('; ')}`,
        );
      }
    } finally {
      await rm(target, { force: true });
    }
  }
}

async function assertRejectedSpecialSourceEntries(sourceRoot) {
  const target = path.join(sourceRoot, 'adapters/r2/terra-symlink-target.ts');
  const link = path.join(sourceRoot, 'adapters/r2/terra-symlink.ts');
  await writeFile(target, 'export const target = true;\n');
  await symlink(target, link);
  try {
    const violations = await checkDomainBoundary(sourceRoot);
    assertContains(violations, 'unsupported symbolic link', 'TypeScript symlink');
  } finally {
    await rm(link, { force: true });
    await rm(target, { force: true });
  }

  const fifo = path.join(sourceRoot, 'adapters/r2/terra-fifo.ts');
  if (process.platform === 'win32') {
    globalThis.console.log(
      'Domain boundary FIFO regression skipped: mkfifo is unavailable on Windows.',
    );
  } else {
    try {
      await execFileAsync('mkfifo', [fifo]);
      try {
        const violations = await checkDomainBoundary(sourceRoot);
        assertContains(violations, 'unsupported non-regular filesystem entry', 'FIFO');
      } finally {
        await rm(fifo, { force: true });
      }
    } catch (error) {
      await rm(fifo, { force: true });
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
        globalThis.console.log(
          `Domain boundary FIFO regression skipped: mkfifo unavailable (${error.code}).`,
        );
      } else {
        throw error;
      }
    }
  }

  const unreadable = path.join(sourceRoot, 'adapters/r2/terra-unreadable.ts');
  await writeFile(unreadable, 'export const unreadable = true;\n');
  try {
    await chmod(unreadable, 0o000);
    try {
      await access(unreadable, constants.R_OK);
      globalThis.console.log(
        'Domain boundary unreadable-file regression skipped: current platform/user can read mode-000 files.',
      );
    } catch {
      const violations = await checkDomainBoundary(sourceRoot);
      assertContains(violations, 'file cannot be read', 'unreadable source file');
    }
  } finally {
    await chmod(unreadable, 0o600).catch(() => undefined);
    await rm(unreadable, { force: true });
  }
}

async function assertRejectedTraversalImport(sourceRoot) {
  const target = path.join(sourceRoot, 'adapters/r2/terra-traversal.ts');
  await writeFile(target, "import '../../../../outside';\n");
  try {
    const violations = await checkDomainBoundary(sourceRoot);
    assertContains(violations, 'outside checked root', 'traversal-adjacent relative import');
  } finally {
    await rm(target, { force: true });
  }
}

async function assertRejectedModuleSpecifierForms(sourceRoot) {
  const rejected = [
    ['absolute POSIX path', "import '/tmp/outside-global-registry';\n", 'external-path'],
    ['file URL', "import 'file:///tmp/outside-global-registry';\n", 'external-url'],
    ['Windows drive path', "import 'C:\\\\outside-global-registry.ts';\n", 'external-path'],
    ['Windows UNC path', "import '\\\\\\\\server\\share\\outside.ts';\n", 'external-path'],
    ['unknown bare module', "import 'unknown-global-registry-package';\n", 'unknown-bare'],
    [
      'missing relative module',
      "import './missing-global-registry-module';\n",
      'cannot be resolved',
    ],
  ];
  for (const [description, source, expected] of rejected) {
    const target = path.join(sourceRoot, 'application', 'specifier-regression.ts');
    await writeFile(target, `${source}export const rejected = true;\n`);
    try {
      const violations = await checkDomainBoundary(sourceRoot);
      assertContains(violations, expected, description);
    } finally {
      await rm(target, { force: true });
    }
  }

  const allowed = path.join(sourceRoot, 'api', 'routes', 'specifier-allowlist.ts');
  await writeFile(
    allowed,
    "import { z } from 'zod';\nimport { WorkerEntrypoint } from 'cloudflare:workers';\nexport const allowed = [z, WorkerEntrypoint];\n",
  );
  const helper = path.join(sourceRoot, 'application', 'specifier-helper.ts');
  const index = path.join(sourceRoot, 'application', 'specifier-index', 'index.ts');
  const relative = path.join(sourceRoot, 'application', 'specifier-relative.ts');
  await mkdir(path.dirname(index), { recursive: true });
  await writeFile(helper, 'export const helper = true;\n');
  await writeFile(index, 'export const indexed = true;\n');
  await writeFile(
    relative,
    "import './specifier-helper';\nimport './specifier-index';\nexport const resolved = true;\n",
  );
  try {
    const violations = await checkDomainBoundary(sourceRoot);
    if (violations.length > 0) {
      throw new Error(
        `Allowlisted and extension/index imports were rejected: ${violations.join('; ')}`,
      );
    }
  } finally {
    await Promise.all([
      rm(allowed, { force: true }),
      rm(helper, { force: true }),
      rm(index, { force: true }),
      rm(relative, { force: true }),
    ]);
    await rm(path.dirname(index), { recursive: true, force: true });
  }
}

function assertContains(violations, expected, description) {
  if (!violations.some((violation) => violation.includes(expected))) {
    throw new Error(`${description} was accepted: ${violations.join('; ')}`);
  }
}
