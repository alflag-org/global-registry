import path from 'node:path';
import process from 'node:process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { findDomainBoundaryViolations } from './check-domain-boundary.mjs';
import { findTestClassificationViolations } from './check-test-classification.mjs';
import { parseJsonc } from './deployment-preflight.mjs';
import {
  allRegularFiles,
  checkedRoot,
  classifyModuleSpecifier,
  formatFilesystemBoundaryError,
  isPathContained,
  isSupportedTypeScriptFile,
  parseTypeScriptImports,
  readCheckedFile,
  resolveRelativeModule,
} from './typescript-imports.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredTopLevelTypeScriptFiles = Object.freeze([
  'vitest.config.ts',
  'vitest.unit.config.ts',
]);
const requiredTopLevelConfigurationFiles = Object.freeze(['tsconfig.json']);
const checkedTreeDirectories = Object.freeze(['src', 'test', 'scripts']);
const allowedTypeScriptExternalImports = new Set([
  '@cloudflare/vitest-pool-workers',
  '@hono/zod-openapi',
  'cloudflare:test',
  'cloudflare:workers',
  'hono',
  'hono/http-exception',
  'node:child_process',
  'node:buffer',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:os',
  'node:path',
  'node:process',
  'node:sqlite',
  'node:timers',
  'node:url',
  'node:util',
  'vitest',
  'vitest/config',
  'zod',
]);

export async function findTypeScriptContainmentViolations(repositoryRoot = defaultRepositoryRoot) {
  const violations = [];
  let checkedRepositoryRoot;
  let files;
  try {
    checkedRepositoryRoot = await checkedRoot(repositoryRoot);
    files = await collectCheckedFiles(checkedRepositoryRoot);
  } catch (error) {
    return [formatFilesystemBoundaryError(error)];
  }

  await validateTopLevelConfigurationFiles(checkedRepositoryRoot, files, violations);
  await validateTypeScriptModuleGraph(checkedRepositoryRoot, files, violations);

  const sourceViolations = await findDomainBoundaryViolations(
    path.join(checkedRepositoryRoot, 'src'),
  );
  const testResult = await findTestClassificationViolations(checkedRepositoryRoot);
  for (const violation of [...sourceViolations, ...testResult.violations]) {
    appendUnique(violations, violation);
  }
  return violations;
}

export async function checkTypeScriptContainment(repositoryRoot = defaultRepositoryRoot) {
  const violations = await findTypeScriptContainmentViolations(repositoryRoot);
  if (violations.length > 0) {
    throw new Error(
      `TypeScript containment check failed before compiler execution:\n- ${violations.join('\n- ')}`,
    );
  }
  return violations;
}

async function collectCheckedFiles(repositoryRoot) {
  const files = new Set();
  for (const directory of checkedTreeDirectories) {
    const directoryFiles = await allRegularFiles(path.join(repositoryRoot, directory));
    for (const file of directoryFiles) files.add(file);
  }

  const entries = await readdir(repositoryRoot, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(repositoryRoot, entry.name);
    if (!isSupportedTypeScriptFile(target)) continue;
    if (!entry.isFile()) {
      throw new Error(`top-level TypeScript entry is not a regular file: ${target}`);
    }
    files.add(await realpath(target));
  }

  for (const fileName of requiredTopLevelTypeScriptFiles) {
    const expected = path.join(repositoryRoot, fileName);
    if (![...files].includes(expected)) {
      throw new Error(`required top-level TypeScript config is missing: ${fileName}`);
    }
  }
  return [...files].sort();
}

async function validateTypeScriptModuleGraph(repositoryRoot, files, violations) {
  for (const file of files.filter(isSupportedTypeScriptFile)) {
    let analysis;
    try {
      analysis = parseTypeScriptImports(await readCheckedFile(file, repositoryRoot), file);
    } catch (error) {
      appendUnique(violations, formatFilesystemBoundaryError(error));
      continue;
    }
    for (const diagnostic of analysis.diagnostics) {
      appendUnique(
        violations,
        `TypeScript parsing failed closed for ${displayPath(repositoryRoot, file)}: ${diagnostic}`,
      );
    }
    for (const unsupported of analysis.unsupported) {
      appendUnique(
        violations,
        `Cannot classify ${unsupported.kind} at ${displayPath(repositoryRoot, file)}:${unsupported.line}; containment fails closed for unsupported module syntax.`,
      );
    }
    for (const imported of analysis.specifiers) {
      const classification = classifyModuleSpecifier(
        imported.specifier,
        allowedTypeScriptExternalImports,
      );
      if (classification === 'relative') {
        try {
          await resolveRelativeModule(file, imported.specifier, repositoryRoot);
        } catch (error) {
          appendUnique(violations, formatFilesystemBoundaryError(error));
        }
      } else if (classification !== 'allowlisted') {
        appendUnique(
          violations,
          `${displayPath(repositoryRoot, file)}:${imported.line} ${imported.kind} uses ${classification} module specifier ${JSON.stringify(imported.specifier)}; only contained relative modules and exact allowlisted packages/platform modules are accepted`,
        );
      }
    }
  }
}

async function validateTopLevelConfigurationFiles(repositoryRoot, files, violations) {
  const fileSet = new Set(files);
  for (const fileName of requiredTopLevelConfigurationFiles) {
    const file = path.join(repositoryRoot, fileName);
    try {
      parseJsonc(await readCheckedFile(file, repositoryRoot), file);
    } catch (error) {
      appendUnique(violations, formatFilesystemBoundaryError(error));
    }
  }

  const topLevelEntries = await readdir(repositoryRoot, { withFileTypes: true });
  const topLevelConfigFiles = topLevelEntries
    .filter((entry) => /^wrangler(?:\.[^.]+)*\.jsonc$/.test(entry.name))
    .map((entry) => path.join(repositoryRoot, entry.name));
  for (const file of topLevelConfigFiles) {
    let config;
    try {
      config = parseJsonc(await readCheckedFile(file, repositoryRoot), file);
    } catch (error) {
      appendUnique(violations, error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const [field, value] of findConfigurationPaths(config)) {
      if (typeof value !== 'string') {
        appendUnique(
          violations,
          `${displayPath(repositoryRoot, file)} ${field} must be a relative string path.`,
        );
        continue;
      }
      if (
        value.length === 0 ||
        path.isAbsolute(value) ||
        value.includes('\\') ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
      ) {
        appendUnique(
          violations,
          `${displayPath(repositoryRoot, file)} ${field} escapes the repository through ${JSON.stringify(value)}.`,
        );
        continue;
      }
      const target = path.resolve(repositoryRoot, value);
      if (!isPathContained(repositoryRoot, target)) {
        appendUnique(
          violations,
          `${displayPath(repositoryRoot, file)} ${field} escapes the repository through ${JSON.stringify(value)}.`,
        );
        continue;
      }
      if (field.endsWith('.main') && !fileSet.has(target)) {
        appendUnique(
          violations,
          `${displayPath(repositoryRoot, file)} ${field} does not name an inventoried repository file: ${value}`,
        );
      }
    }
  }

  await validateWranglerRedirectState(repositoryRoot, violations);

  const tsConfigPath = path.join(repositoryRoot, 'tsconfig.json');
  try {
    const tsConfig = parseJsonc(await readCheckedFile(tsConfigPath, repositoryRoot), tsConfigPath);
    validateTsConfigPaths(repositoryRoot, tsConfig, violations);
  } catch (error) {
    appendUnique(violations, error instanceof Error ? error.message : String(error));
  }
}

async function validateWranglerRedirectState(repositoryRoot, violations) {
  const redirectPath = path.join(repositoryRoot, '.wrangler', 'deploy', 'config.json');
  try {
    await lstat(redirectPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    appendUnique(
      violations,
      `Wrangler deploy redirect cannot be inspected safely: ${displayPath(repositoryRoot, redirectPath)}.`,
    );
    return;
  }

  let redirect;
  try {
    redirect = parseJsonc(
      await readCheckedFile(redirectPath, repositoryRoot, { maxBytes: 64 * 1024 }),
      redirectPath,
    );
  } catch (error) {
    appendUnique(
      violations,
      `Wrangler deploy redirect rejected before execution: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return;
  }

  if (redirect === null || typeof redirect !== 'object' || Array.isArray(redirect)) {
    appendUnique(violations, 'Wrangler deploy redirect must be a JSON object.');
    return;
  }
  const redirectedConfig = redirect.configPath;
  if (
    typeof redirectedConfig !== 'string' ||
    redirectedConfig.length === 0 ||
    path.isAbsolute(redirectedConfig) ||
    redirectedConfig.includes('\\') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(redirectedConfig)
  ) {
    appendUnique(
      violations,
      'Wrangler deploy redirect rejected before execution: configPath must be a relative path.',
    );
    return;
  }

  const redirectedPath = path.resolve(path.dirname(redirectPath), redirectedConfig);
  const allowedNames = new Set([
    'wrangler.jsonc',
    'wrangler.operator.jsonc',
    'wrangler.operator.example.jsonc',
  ]);
  if (
    !isPathContained(repositoryRoot, redirectedPath) ||
    !allowedNames.has(path.basename(redirectedPath))
  ) {
    appendUnique(
      violations,
      `Wrangler deploy redirect rejected before execution: configPath escapes the checked Wrangler configurations (${JSON.stringify(redirectedConfig)}).`,
    );
    return;
  }
  try {
    await readCheckedFile(redirectedPath, repositoryRoot, { maxBytes: 1024 * 1024 });
  } catch (error) {
    appendUnique(
      violations,
      `Wrangler deploy redirect rejected before execution: target is not a checked regular configuration (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function findConfigurationPaths(config) {
  const paths = [];
  const visit = (value, location) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${location}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (key === 'main' || key === 'migrations_dir') paths.push([childLocation, child]);
      visit(child, childLocation);
    }
  };
  visit(config, '$');
  return paths;
}

function validateTsConfigPaths(repositoryRoot, config, violations) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return;
  const compilerOptions = config.compilerOptions;
  if (compilerOptions !== undefined && typeof compilerOptions !== 'object') {
    appendUnique(violations, 'tsconfig.json compilerOptions must be an object.');
  }
  const values = [];
  if (Array.isArray(config.include))
    values.push(...config.include.map((value) => ['include', value]));
  if (Array.isArray(config.files)) values.push(...config.files.map((value) => ['files', value]));
  if (typeof config.extends === 'string') values.push(['extends', config.extends]);
  for (const [field, value] of values) {
    if (typeof value !== 'string') {
      appendUnique(violations, `tsconfig.json ${field} entries must be relative strings.`);
      continue;
    }
    const prefix = value.split(/[*?{[]/, 1)[0] || '.';
    if (
      path.isAbsolute(prefix) ||
      prefix.includes('\\') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(prefix)
    ) {
      appendUnique(
        violations,
        `tsconfig.json ${field} escapes the repository through ${JSON.stringify(value)}.`,
      );
      continue;
    }
    const target = path.resolve(repositoryRoot, prefix);
    if (!isPathContained(repositoryRoot, target)) {
      appendUnique(
        violations,
        `tsconfig.json ${field} escapes the repository through ${JSON.stringify(value)}.`,
      );
    }
  }
}

function displayPath(repositoryRoot, file) {
  return path.relative(repositoryRoot, file).split(path.sep).join('/');
}

function appendUnique(violations, violation) {
  if (!violations.includes(violation)) violations.push(violation);
}

const invokedScript = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedScript === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root');
  const repositoryRoot = rootIndex < 0 ? defaultRepositoryRoot : process.argv[rootIndex + 1];
  if (repositoryRoot === undefined || repositoryRoot.startsWith('--')) {
    throw new Error('--root requires a repository path.');
  }
  await checkTypeScriptContainment(path.resolve(repositoryRoot));
  globalThis.console.log(
    'TypeScript source, script, config, and test containment checks passed before compiler execution.',
  );
}
