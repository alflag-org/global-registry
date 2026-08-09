import {
  access,
  chmod,
  cp,
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
import { checkTestClassification } from './check-test-classification.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitIncludes = [
  'test/unit/**/*.test.ts',
  'test/unit/**/*.test.tsx',
  'test/unit/**/*.test.mts',
  'test/unit/**/*.test.cts',
];
const workerIncludes = [
  'test/contract/**/*.test.ts',
  'test/contract/**/*.test.tsx',
  'test/contract/**/*.test.mts',
  'test/contract/**/*.test.cts',
  'test/integration/**/*.test.ts',
  'test/integration/**/*.test.tsx',
  'test/integration/**/*.test.mts',
  'test/integration/**/*.test.cts',
];

const cases = [
  {
    name: 'Terra alternate unit glob',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludes(source, ["'test/*/access-principal.test.ts'"]),
  },
  {
    name: 'broad Node glob',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludes(source, ["'test/**/*.test.ts'"]),
  },
  {
    name: 'Node and Worker overlap',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludes(source, [unitIncludes[0], workerIncludes[4]]),
  },
  {
    name: 'Node omission',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludes(source, unitIncludes.slice(0, 2)),
  },
  {
    name: 'broad Worker glob',
    file: 'vitest.config.ts',
    mutate: (source) => replaceIncludes(source, ["'test/**/*.test.ts'"]),
  },
  {
    name: 'Terra alternate Worker glob',
    file: 'vitest.config.ts',
    mutate: (source) =>
      replaceIncludes(source, [workerIncludes[0], "'test/*/access-principal.test.ts'"]),
  },
  {
    name: 'Worker selects unit tests too',
    file: 'vitest.config.ts',
    mutate: (source) => replaceIncludes(source, [...workerIncludes, unitIncludes[0]]),
  },
  {
    name: 'reordered Worker include patterns',
    file: 'vitest.config.ts',
    mutate: (source) => replaceIncludes(source, [...workerIncludes].reverse()),
  },
  {
    name: 'literal array with spread',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludes(source, ['...unitIncludes']),
  },
  {
    name: 'computed array element',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludes(source, ['`test/unit/**/*.test.ts`']),
  },
  {
    name: 'undefined include entry',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludeExpression(source, "['test/unit/**/*.test.ts', undefined]"),
  },
  {
    name: 'computed property name',
    file: 'vitest.unit.config.ts',
    mutate: (source) => source.replace('include: [', '["include"]: ['),
  },
  {
    name: 'aliased include value',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludeExpression(source, 'unitIncludes'),
  },
  {
    name: 'parse error',
    file: 'vitest.unit.config.ts',
    mutate: (source) => source.replace(/include:\s*\[[\s\S]*?\],/, 'include: ['),
  },
  {
    name: 'wrong include type',
    file: 'vitest.unit.config.ts',
    mutate: (source) => replaceIncludeExpression(source, "'test/unit/**/*.test.ts'"),
  },
  {
    name: 'unexpected test property',
    file: 'vitest.unit.config.ts',
    mutate: (source) =>
      source.replace('    hookTimeout: 30_000,', '    hookTimeout: 30_000,\n    unexpected: true,'),
  },
];

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'global-registry-test-classification-'));
try {
  await cp(path.join(repositoryRoot, 'test'), path.join(temporaryRoot, 'test'), {
    recursive: true,
  });
  await cp(
    path.join(repositoryRoot, 'vitest.unit.config.ts'),
    path.join(temporaryRoot, 'vitest.unit.config.ts'),
  );
  await cp(
    path.join(repositoryRoot, 'vitest.config.ts'),
    path.join(temporaryRoot, 'vitest.config.ts'),
  );
  await cp(path.join(repositoryRoot, 'src'), path.join(temporaryRoot, 'src'), {
    recursive: true,
  });
  await mkdir(path.join(temporaryRoot, 'scripts'));
  await cp(
    path.join(repositoryRoot, 'scripts/bootstrap-admin-core.ts'),
    path.join(temporaryRoot, 'scripts/bootstrap-admin-core.ts'),
  );
  await cp(path.join(repositoryRoot, 'migrations'), path.join(temporaryRoot, 'migrations'), {
    recursive: true,
  });
  await cp(path.join(repositoryRoot, 'wrangler.jsonc'), path.join(temporaryRoot, 'wrangler.jsonc'));
  await cp(path.join(repositoryRoot, 'package.json'), path.join(temporaryRoot, 'package.json'));
  await symlink(
    path.join(repositoryRoot, 'node_modules'),
    path.join(temporaryRoot, 'node_modules'),
  );

  await addSupportedExtensionFixtures(temporaryRoot);
  const positive = await checkTestClassification(temporaryRoot);
  if (positive.violations.length > 0) {
    throw new Error(`Exact test configuration was rejected: ${positive.violations.join('; ')}`);
  }
  if (
    positive.effectiveUnitFiles.length !== 16 ||
    positive.effectiveWorkerFiles.length !== 11 ||
    !positive.nodeConfigIsWorkerFree
  ) {
    throw new Error(
      `Positive classification fixture did not produce the exact 16/11 Worker-free partition with all supported extensions: violations=${positive.violations.join('; ')}, unit=${positive.effectiveUnitFiles.length}, worker=${positive.effectiveWorkerFiles.length}, workerFree=${positive.nodeConfigIsWorkerFree}.`,
    );
  }

  for (const testCase of cases) {
    await assertRejectedCase(temporaryRoot, testCase);
  }

  await assertWorkerOnlyGraphRejection(temporaryRoot);
  await assertRejectedFixtureBeforeExecution(temporaryRoot);
  await assertRejectedSpecialTestEntries(temporaryRoot);
  await assertRejectedTraversalImport(temporaryRoot);
  await assertRejectedImportForms(temporaryRoot);
  await assertRuntimeSelection(temporaryRoot);
  await assertWorkerRuntimeSelection(temporaryRoot);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

globalThis.console.log(
  `Test classification regression fixtures passed: exact 16/11 extension-aware partition accepted; 4 Node and 4 Worker extension-selection files were intentionally executed and failed; ${cases.length} configuration and import-graph cases rejected before execution.`,
);

function replaceIncludes(source, entries) {
  return source.replace(
    /include:\s*\[[\s\S]*?\],/,
    `include: [${entries.map(formatIncludeEntry).join(', ')}],`,
  );
}

function formatIncludeEntry(entry) {
  if (entry.startsWith("'") || entry.startsWith('`') || entry.startsWith('...')) return entry;
  return JSON.stringify(entry);
}

function replaceIncludeExpression(source, expression) {
  return source.replace(/include:\s*\[[\s\S]*?\],/, `include: ${expression},`);
}

async function addSupportedExtensionFixtures(root) {
  for (const extension of ['tsx', 'mts', 'cts']) {
    await writeFile(
      path.join(root, 'test', 'unit', `supported-${extension}.test.${extension}`),
      extension === 'tsx'
        ? "import { it } from 'vitest';\nit('supported tsx', () => undefined);\n"
        : `export const supported${extension} = true;\n`,
    );
    await writeFile(
      path.join(root, 'test', 'integration', `supported-${extension}.test.${extension}`),
      extension === 'tsx'
        ? "import { it } from 'vitest';\nit('supported worker tsx', () => undefined);\n"
        : `export const supportedWorker${extension} = true;\n`,
    );
  }
}

async function assertRejectedCase(root, testCase) {
  const target = path.join(root, testCase.file);
  const original = await readFile(target, 'utf8');
  await writeFile(target, testCase.mutate(original));
  try {
    const result = await checkTestClassification(root);
    if (result.violations.length === 0) {
      throw new Error(`Regression case ${testCase.name} was accepted.`);
    }
  } finally {
    await writeFile(target, original);
  }
}

async function assertRejectedFixtureBeforeExecution(root) {
  const cases = [
    {
      relativePath: 'test/unclassified/should-not-run.test.ts',
      source: "throw new Error('unclassified test executed');\n",
      expected: 'test/unclassified/should-not-run.test.ts',
      description: 'unclassified test directory',
    },
    {
      relativePath: 'test/unit/unexpected.test.js',
      source: "throw new Error('unexpected');\n",
      expected: 'unexpected.test.js',
      description: 'unexpected test extension',
    },
    {
      relativePath: 'test/unit/terra-unsupported.foo',
      source: "import 'cloudflare:workers';\n",
      expected: 'terra-unsupported.foo',
      description: 'unsupported test extension',
    },
    {
      relativePath: 'test/unit/terra-unsupported.test.d.ts',
      source: "import 'cloudflare:workers';\n",
      expected: 'terra-unsupported.test.d.ts',
      description: 'unsupported test name form',
    },
  ];
  for (const testCase of cases) {
    const target = path.join(root, testCase.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, testCase.source);
    try {
      const result = await checkTestClassification(root);
      if (!result.violations.some((violation) => violation.includes(testCase.expected))) {
        throw new Error(`An ${testCase.description} was not rejected before execution.`);
      }
    } finally {
      await rm(target, { force: true });
    }
  }
}

async function assertWorkerOnlyGraphRejection(root) {
  const direct = path.join(root, 'test', 'unit', 'worker-direct.test.tsx');
  await writeFile(direct, "import 'cloudflare:workers';\n");
  try {
    const result = await checkTestClassification(root);
    if (!result.violations.some((violation) => violation.includes('Workers-only module'))) {
      throw new Error('A direct Workers-only Node test dependency was accepted.');
    }
  } finally {
    await rm(direct, { force: true });
  }

  const transitive = path.join(root, 'test', 'unit', 'worker-transitive.test.ts');
  const helper = path.join(root, 'test', 'unit', 'worker-transitive-helper.test.ts');
  await writeFile(transitive, "import './worker-transitive-helper';\n");
  await writeFile(helper, "import 'cloudflare:workers';\n");
  try {
    const result = await checkTestClassification(root);
    if (!result.violations.some((violation) => violation.includes('Workers-only module'))) {
      throw new Error('A transitive Workers-only Node test dependency was accepted.');
    }
  } finally {
    await rm(transitive, { force: true });
    await rm(helper, { force: true });
  }
}

async function assertRejectedSpecialTestEntries(root) {
  const target = path.join(root, 'test/unit/terra-symlink-target.test.ts');
  const link = path.join(root, 'test/unit/terra-symlink.test.ts');
  await writeFile(target, 'export const target = true;\n');
  await symlink(target, link);
  try {
    const result = await checkTestClassification(root);
    assertContains(result.violations, 'unsupported symbolic link', 'TypeScript test symlink');
  } finally {
    await rm(link, { force: true });
    await rm(target, { force: true });
  }

  const fifo = path.join(root, 'test/unit/terra-fifo.test.ts');
  if (process.platform === 'win32') {
    globalThis.console.log(
      'Test classification FIFO regression skipped: mkfifo is unavailable on Windows.',
    );
  } else {
    try {
      await execFileAsync('mkfifo', [fifo]);
      try {
        const result = await checkTestClassification(root);
        assertContains(
          result.violations,
          'unsupported non-regular filesystem entry',
          'FIFO test entry',
        );
      } finally {
        await rm(fifo, { force: true });
      }
    } catch (error) {
      await rm(fifo, { force: true });
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
        globalThis.console.log(
          `Test classification FIFO regression skipped: mkfifo unavailable (${error.code}).`,
        );
      } else {
        throw error;
      }
    }
  }

  const unreadable = path.join(root, 'test/unit/terra-unreadable.test.ts');
  await writeFile(unreadable, 'export const unreadable = true;\n');
  try {
    await chmod(unreadable, 0o000);
    try {
      await access(unreadable, constants.R_OK);
      globalThis.console.log(
        'Test classification unreadable-file regression skipped: current platform/user can read mode-000 files.',
      );
    } catch {
      const result = await checkTestClassification(root);
      assertContains(result.violations, 'file cannot be read', 'unreadable test file');
    }
  } finally {
    await chmod(unreadable, 0o600).catch(() => undefined);
    await rm(unreadable, { force: true });
  }
}

async function assertRejectedTraversalImport(root) {
  const target = path.join(root, 'test/unit/terra-traversal.test.ts');
  await writeFile(target, "import '../../../../outside';\n");
  try {
    const result = await checkTestClassification(root);
    assertContains(result.violations, 'outside checked root', 'traversal-adjacent test import');
  } finally {
    await rm(target, { force: true });
  }
}

async function assertRejectedImportForms(root) {
  const cases = [
    ['unit', './missing-unit-dependency', 'cannot be resolved'],
    ['contract', './missing-contract-dependency', 'cannot be resolved'],
    ['integration', './missing-integration-dependency', 'cannot be resolved'],
    ['unit', '/tmp/outside-global-registry', 'external-path'],
    ['contract', 'file:///tmp/outside-global-registry', 'external-url'],
    ['integration', 'C:\\\\outside-global-registry.ts', 'external-path'],
    ['unit', '\\\\\\\\server\\share\\outside.ts', 'external-path'],
    ['integration', 'unknown-global-registry-package', 'unknown-bare'],
  ];
  for (const [area, specifier, expected] of cases) {
    const target = path.join(root, 'test', area, `adversarial-${area}.test.ts`);
    await writeFile(
      target,
      `import ${JSON.stringify(specifier)};\nexport const adversarial = true;\n`,
    );
    try {
      const result = await checkTestClassification(root);
      assertContains(result.violations, expected, `${area} ${specifier} import`);
    } finally {
      await rm(target, { force: true });
    }
  }

  const malformed = path.join(root, 'test/integration/adversarial-malformed.test.ts');
  await writeFile(malformed, "import { from 'vitest';\n");
  try {
    const result = await checkTestClassification(root);
    assertContains(
      result.violations,
      'Test dependency parsing failed closed',
      'malformed Worker test',
    );
  } finally {
    await rm(malformed, { force: true });
  }

  const helper = path.join(root, 'src/adversarial-import-helper.ts');
  const index = path.join(root, 'src/adversarial-import-index/index.ts');
  const allowlisted = path.join(root, 'test/integration/adversarial-allowlisted.test.ts');
  await mkdir(path.dirname(index), { recursive: true });
  await writeFile(helper, 'export const helper = true;\n');
  await writeFile(index, 'export const indexed = true;\n');
  await writeFile(
    allowlisted,
    "import { it } from 'vitest';\nimport { env } from 'cloudflare:workers';\nimport '../../src/adversarial-import-helper';\nimport '../../src/adversarial-import-index';\nit('fixture', () => void env && it);\n",
  );
  try {
    const result = await checkTestClassification(root);
    if (result.violations.length > 0) {
      throw new Error(
        `Allowlisted package/platform or extension/index imports were rejected: ${result.violations.join('; ')}`,
      );
    }
  } finally {
    await Promise.all([
      rm(allowlisted, { force: true }),
      rm(helper, { force: true }),
      rm(index, { force: true }),
    ]);
    await rm(path.dirname(index), { recursive: true, force: true });
  }
}

function assertContains(violations, expected, description) {
  if (!violations.some((violation) => violation.includes(expected))) {
    throw new Error(`${description} was accepted: ${violations.join('; ')}`);
  }
}

async function assertRuntimeSelection(root) {
  for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
    const filename = `intentional-selection.test.${extension}`;
    const testPath = path.join(root, 'test', 'unit', filename);
    await writeFile(
      testPath,
      "import { expect, it } from 'vitest';\nit('supported test is selected by Node', () => expect(false).toBe(true));\n",
    );
    try {
      const result = await execFileAsync(
        path.join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
        ['run', '--config', path.join(root, 'vitest.unit.config.ts'), `test/unit/${filename}`],
        { cwd: root, env: { ...process.env, NO_COLOR: '1' } },
      ).catch((error) => error);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.code === 0 || !output.includes(filename)) {
        throw new Error(`The intentionally failing supported test was not selected: ${output}`);
      }
    } finally {
      await rm(testPath, { force: true });
    }
  }
}

async function assertWorkerRuntimeSelection(root) {
  for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
    const filename = `intentional-worker-selection.test.${extension}`;
    const testPath = path.join(root, 'test', 'integration', filename);
    await writeFile(
      testPath,
      "import { expect, it } from 'vitest';\nit('supported test is selected by Workers', () => expect(false).toBe(true));\n",
    );
    try {
      const result = await execFileAsync(
        path.join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
        ['run', '--config', path.join(root, 'vitest.config.ts'), `test/integration/${filename}`],
        { cwd: root, env: { ...process.env, NO_COLOR: '1' } },
      ).catch((error) => error);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.code === 0 || !output.includes(filename)) {
        throw new Error(`The intentionally failing Worker test was not selected: ${output}`);
      }
    } finally {
      await rm(testPath, { force: true });
    }
  }
}
