import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  allRegularFiles,
  checkedRoot,
  classifyModuleSpecifier,
  formatFilesystemBoundaryError,
  isSupportedTypeScriptFile,
  parseTypeScriptImports,
  readCheckedFile,
  resolveRelativeModule,
} from './typescript-imports.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitConfigName = 'vitest.unit.config.ts';
const workerConfigName = 'vitest.config.ts';
const supportedTestExtensions = Object.freeze(['ts', 'tsx', 'mts', 'cts']);
const unitIncludes = supportedTestExtensions.map((extension) => `test/unit/**/*.test.${extension}`);
const workerIncludes = ['contract', 'integration'].flatMap((area) =>
  supportedTestExtensions.map((extension) => `test/${area}/**/*.test.${extension}`),
);
const unitConfigImports = new Map([['vitest/config', new Set(['defineConfig'])]]);
const workerConfigImports = new Map([
  ['@cloudflare/vitest-pool-workers', new Set(['cloudflareTest', 'readD1Migrations'])],
  ['node:path', new Set(['default:path'])],
  ['node:url', new Set(['fileURLToPath'])],
  ['vitest/config', new Set(['defineConfig'])],
]);
const workerOnlyModule =
  /^(?:cloudflare:|@cloudflare\/vitest-pool-workers$|miniflare(?:\/|$)|workerd(?:\/|$))/;
const allowedTestExternalImports = new Set([
  '@cloudflare/vitest-pool-workers',
  '@hono/zod-openapi',
  'cloudflare:test',
  'cloudflare:workers',
  'hono',
  'hono/http-exception',
  'node:fs/promises',
  'node:path',
  'node:url',
  'vitest',
  'zod',
]);
const supportedTestFilePattern =
  'test/unit/**/*.test.<ts|tsx|mts|cts> or test/contract|integration/**/*.test.<ts|tsx|mts|cts>';
const allowedTestSupportFiles = new Set(['apply-migrations.ts', 'worker-env.d.ts']);
const allowedNonCodeFixtureFiles = new Set([
  'fixtures/domain-boundary/d1-forbidden-cross-layer.txt',
  'fixtures/domain-boundary/r2-forbidden-adapter.txt',
  'fixtures/domain-boundary/r2-forbidden-api.txt',
  'fixtures/domain-boundary/r2-forbidden-comment.txt',
  'fixtures/domain-boundary/r2-forbidden-cts.cts',
  'fixtures/domain-boundary/r2-forbidden-domain.txt',
  'fixtures/domain-boundary/r2-forbidden-dynamic.txt',
  'fixtures/domain-boundary/r2-forbidden-external.txt',
  'fixtures/domain-boundary/r2-forbidden-import-equals.txt',
  'fixtures/domain-boundary/r2-forbidden-mts.mts',
  'fixtures/domain-boundary/r2-forbidden-path-normalization.txt',
  'fixtures/domain-boundary/r2-forbidden-reexport.txt',
  'fixtures/domain-boundary/r2-forbidden-require.txt',
  'fixtures/domain-boundary/r2-forbidden-template.txt',
  'fixtures/domain-boundary/r2-forbidden-tsx.tsx',
  'fixtures/domain-boundary/r2-valid-platform.txt',
  'fixtures/domain-boundary/r2-valid-ports.txt',
  'fixtures/domain-boundary/r2-valid-standard-library.txt',
]);

export async function findTestClassificationViolations(repositoryRoot = defaultRepositoryRoot) {
  let checkedRepositoryRoot;
  let allTestFiles;
  try {
    checkedRepositoryRoot = await checkedRoot(repositoryRoot);
    allTestFiles = await allRegularFiles(path.join(checkedRepositoryRoot, 'test'));
  } catch (error) {
    return emptyClassificationResult([formatFilesystemBoundaryError(error)]);
  }
  const testRoot = path.join(checkedRepositoryRoot, 'test');
  const unitConfigPath = path.join(checkedRepositoryRoot, unitConfigName);
  const workerConfigPath = path.join(checkedRepositoryRoot, workerConfigName);
  const unsupportedTestSuffixes = [];
  const unsupportedTestNames = [];
  for (const file of allTestFiles) {
    const relative = path.relative(testRoot, file).split(path.sep).join('/');
    if (isAllowedTestSupportFile(relative) || allowedNonCodeFixtureFiles.has(relative)) continue;
    if (!isSupportedTypeScriptFile(file)) {
      unsupportedTestSuffixes.push(file);
    } else if (!isSupportedTestFile(file)) {
      unsupportedTestNames.push(file);
    }
  }
  const testFiles = allTestFiles.filter((file) => isSupportedTestFile(file));
  const unitFiles = testFiles.filter((file) => inTestArea(file, testRoot, 'unit'));
  const workerFiles = testFiles.filter(
    (file) => inTestArea(file, testRoot, 'contract') || inTestArea(file, testRoot, 'integration'),
  );
  const unclassifiedFiles = testFiles.filter(
    (file) => !unitFiles.includes(file) && !workerFiles.includes(file),
  );
  const violations = [];

  if (unsupportedTestSuffixes.length > 0) {
    violations.push(
      `Unsupported test file suffixes are not compiled by this repository: ${unsupportedTestSuffixes.map((file) => path.relative(repositoryRoot, file)).join(', ')}`,
    );
  }
  if (unsupportedTestNames.length > 0) {
    violations.push(
      `Unsupported test file name forms are not classified by this repository (expected ${supportedTestFilePattern}): ${unsupportedTestNames.map((file) => path.relative(repositoryRoot, file)).join(', ')}`,
    );
  }

  const unitConfig = await readConfig(
    unitConfigPath,
    unitConfigImports,
    checkedRepositoryRoot,
    violations,
  );
  const workerConfig = await readConfig(
    workerConfigPath,
    workerConfigImports,
    checkedRepositoryRoot,
    violations,
  );

  const unitTestObject =
    unitConfig === undefined ? undefined : configTestObject(unitConfig, violations);
  const workerTestObject =
    workerConfig === undefined ? undefined : configTestObject(workerConfig, violations);

  if (unitTestObject !== undefined) {
    requireExactPropertyNames(
      unitTestObject,
      ['environment', 'include', 'testTimeout', 'hookTimeout'],
      'Node unit test config',
      violations,
    );
    requireStringProperty(
      unitTestObject,
      'environment',
      'node',
      'Node unit test config',
      violations,
    );
    requireStringArrayProperty(
      unitTestObject,
      'include',
      unitIncludes,
      'Node unit config',
      violations,
    );
  }

  if (workerTestObject !== undefined) {
    requireExactPropertyNames(
      workerTestObject,
      ['include', 'setupFiles', 'fileParallelism', 'testTimeout', 'hookTimeout'],
      'Worker test config',
      violations,
    );
    requireStringArrayProperty(
      workerTestObject,
      'include',
      workerIncludes,
      'Worker test config',
      violations,
    );
    requireStringArrayProperty(
      workerTestObject,
      'setupFiles',
      ['./test/apply-migrations.ts'],
      'Worker test config',
      violations,
    );
    requireBooleanProperty(
      workerTestObject,
      'fileParallelism',
      false,
      'Worker test config',
      violations,
    );
  }

  if (unitConfig !== undefined) validateUnitRoot(unitConfig, violations);
  if (workerConfig !== undefined) validateWorkerRoot(workerConfig, violations);

  if (unclassifiedFiles.length > 0) {
    violations.push(
      `Test files must be classified under test/unit, test/contract, or test/integration: ${unclassifiedFiles.map((file) => path.relative(repositoryRoot, file)).join(', ')}`,
    );
  }

  const configuredUnitIncludes =
    unitTestObject === undefined ? [] : stringArrayValue(unitTestObject, 'include');
  const configuredWorkerIncludes =
    workerTestObject === undefined ? [] : stringArrayValue(workerTestObject, 'include');
  const effectiveUnitFiles = effectiveSelection(configuredUnitIncludes, testFiles, testRoot);
  const effectiveWorkerFiles = effectiveSelection(configuredWorkerIncludes, testFiles, testRoot);
  validateEffectivePartition(
    testFiles,
    unitFiles,
    workerFiles,
    effectiveUnitFiles,
    effectiveWorkerFiles,
    checkedRepositoryRoot,
    violations,
  );

  const dependencyFiles = [...testFiles, ...allTestSupportFiles(allTestFiles, testRoot)];
  for (const violation of await findRelativeImportBoundaryViolations(
    dependencyFiles,
    checkedRepositoryRoot,
  )) {
    if (!violations.includes(violation)) violations.push(violation);
  }

  const unitRuntimeModules = await findUnitWorkerRuntimeModules(unitFiles, checkedRepositoryRoot);
  for (const violation of unitRuntimeModules) violations.push(violation);

  return {
    violations,
    unitFiles,
    workerFiles,
    effectiveUnitFiles,
    effectiveWorkerFiles,
    nodeConfigIsWorkerFree: unitConfig !== undefined && unitRuntimeModules.length === 0,
  };
}

function emptyClassificationResult(violations) {
  return {
    violations,
    unitFiles: [],
    workerFiles: [],
    effectiveUnitFiles: [],
    effectiveWorkerFiles: [],
    nodeConfigIsWorkerFree: false,
  };
}

export async function checkTestClassification(repositoryRoot = defaultRepositoryRoot) {
  return findTestClassificationViolations(repositoryRoot);
}

async function readConfig(file, allowedImports, repositoryRoot, violations) {
  let source;
  try {
    source = await readCheckedFile(file, repositoryRoot);
  } catch (error) {
    violations.push(formatFilesystemBoundaryError(error));
    return undefined;
  }

  const analysis = parseTypeScriptImports(source, file);
  for (const diagnostic of analysis.diagnostics) {
    violations.push(`Vitest config parser failed closed for ${file}: ${diagnostic}`);
  }
  for (const unsupported of analysis.unsupported) {
    violations.push(
      `Vitest config contains unsupported ${unsupported.kind} syntax at ${file}:${unsupported.line}; classification is rejected.`,
    );
  }

  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  validateConfigImports(sourceFile, allowedImports, file, violations);

  const statements = [...sourceFile.statements];
  const exportAssignments = statements.filter(
    (statement) => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (exportAssignments.length !== 1) {
    violations.push(`${file} must contain exactly one default export assignment.`);
    return undefined;
  }
  if (
    statements.some(
      (statement) =>
        !ts.isImportDeclaration(statement) &&
        !ts.isExportAssignment(statement) &&
        !(allowedImports === workerConfigImports && isWorkerRootDirectoryStatement(statement)),
    )
  ) {
    violations.push(`${file} may contain only static imports and one default config export.`);
    return undefined;
  }

  const exportExpression = exportAssignments[0].expression;
  if (
    !ts.isCallExpression(exportExpression) ||
    !ts.isIdentifier(exportExpression.expression) ||
    exportExpression.expression.text !== 'defineConfig' ||
    exportExpression.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(exportExpression.arguments[0])
  ) {
    violations.push(`${file} must export the exact defineConfig({ ... }) structure.`);
    return undefined;
  }
  return exportExpression.arguments[0];
}

function isWorkerRootDirectoryStatement(statement) {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
    return false;
  }
  const declaration = statement.declarationList.declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== 'rootDirectory' ||
    declaration.initializer === undefined ||
    !ts.isCallExpression(declaration.initializer) ||
    !ts.isPropertyAccessExpression(declaration.initializer.expression) ||
    !ts.isIdentifier(declaration.initializer.expression.expression) ||
    declaration.initializer.expression.expression.text !== 'path' ||
    declaration.initializer.expression.name.text !== 'dirname' ||
    declaration.initializer.arguments.length !== 1
  ) {
    return false;
  }
  const fileUrlCall = declaration.initializer.arguments[0];
  if (
    !ts.isCallExpression(fileUrlCall) ||
    !ts.isIdentifier(fileUrlCall.expression) ||
    fileUrlCall.expression.text !== 'fileURLToPath' ||
    fileUrlCall.arguments.length !== 1
  ) {
    return false;
  }
  const importMetaUrl = fileUrlCall.arguments[0];
  return (
    ts.isPropertyAccessExpression(importMetaUrl) &&
    importMetaUrl.name.text === 'url' &&
    ts.isMetaProperty(importMetaUrl.expression) &&
    importMetaUrl.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    importMetaUrl.expression.name.text === 'meta'
  );
}

function validateConfigImports(sourceFile, allowedImports, file, violations) {
  const imports = sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement));
  if (imports.length !== allowedImports.size) {
    violations.push(
      `${file} must use exactly the allowlisted static imports: ${[...allowedImports.keys()].join(', ')}.`,
    );
  }

  const seen = new Set();
  for (const declaration of imports) {
    if (!ts.isStringLiteral(declaration.moduleSpecifier)) {
      violations.push(`${file} contains a non-literal import module specifier.`);
      continue;
    }
    const moduleSpecifier = declaration.moduleSpecifier.text;
    const expectedNames = allowedImports.get(moduleSpecifier);
    if (expectedNames === undefined) {
      violations.push(
        `${file} imports non-allowlisted config module ${JSON.stringify(moduleSpecifier)}.`,
      );
      continue;
    }
    if (seen.has(moduleSpecifier)) {
      violations.push(
        `${file} imports config module ${JSON.stringify(moduleSpecifier)} more than once.`,
      );
    }
    seen.add(moduleSpecifier);
    const names = importedNames(declaration);
    if (declaration.importClause?.isTypeOnly === true || !sameSet(names, expectedNames)) {
      violations.push(
        `${file} must import exactly ${[...expectedNames].join(', ')} from ${JSON.stringify(moduleSpecifier)}.`,
      );
    }
  }
}

function importedNames(declaration) {
  const clause = declaration.importClause;
  if (clause === undefined) return new Set();
  const names = new Set();
  if (clause.name !== undefined) names.add(`default:${clause.name.text}`);
  if (clause.namedBindings === undefined) return names;
  if (ts.isNamespaceImport(clause.namedBindings)) {
    names.add(`namespace:${clause.namedBindings.name.text}`);
    return names;
  }
  for (const element of clause.namedBindings.elements) {
    const imported = element.propertyName?.text ?? element.name.text;
    names.add(element.isTypeOnly ? `type:${imported}:${element.name.text}` : `${imported}`);
  }
  return names;
}

function sameSet(actual, expected) {
  return actual.size === expected.size && [...expected].every((value) => actual.has(value));
}

function configTestObject(configObject, violations) {
  const properties = namedProperties(configObject, violations, 'Vitest config');
  const testProperty = properties.get('test');
  if (testProperty === undefined || !ts.isObjectLiteralExpression(testProperty.initializer)) {
    violations.push('Vitest config must contain a literal test: { ... } object.');
    return undefined;
  }
  return namedProperties(testProperty.initializer, violations, 'Vitest test config');
}

function validateUnitRoot(configObject, violations) {
  const properties = namedProperties(configObject, violations, 'Node unit config');
  requireExactPropertyNames(properties, ['test'], 'Node unit root config', violations);
}

function validateWorkerRoot(configObject, violations) {
  const properties = namedProperties(configObject, violations, 'Worker config');
  requireExactPropertyNames(properties, ['plugins', 'test'], 'Worker root config', violations);
  const plugins = properties.get('plugins');
  if (plugins === undefined || !ts.isArrayLiteralExpression(plugins.initializer)) {
    violations.push('Worker root config must contain a literal plugins array.');
    return;
  }
  if (
    plugins.initializer.elements.length !== 1 ||
    !ts.isCallExpression(plugins.initializer.elements[0]) ||
    !ts.isIdentifier(plugins.initializer.elements[0].expression) ||
    plugins.initializer.elements[0].expression.text !== 'cloudflareTest'
  ) {
    violations.push('Worker root config must initialize exactly one cloudflareTest plugin.');
  }
}

function namedProperties(objectLiteral, violations, label) {
  const properties = new Map();
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || property.name === undefined) {
      violations.push(`${label} may contain only literal property assignments.`);
      continue;
    }
    const name = propertyName(property.name);
    if (name === undefined) {
      violations.push(`${label} contains a computed or unsupported property name.`);
      continue;
    }
    if (properties.has(name)) violations.push(`${label} defines ${name} more than once.`);
    properties.set(name, property);
  }
  return properties;
}

function requireExactPropertyNames(propertiesOrObject, expected, label, violations) {
  const properties =
    propertiesOrObject instanceof Map
      ? propertiesOrObject
      : namedProperties(propertiesOrObject, violations, label);
  const actual = [...properties.keys()].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    violations.push(`${label} must contain exactly these properties: ${wanted.join(', ')}.`);
  }
}

function requireStringProperty(properties, name, expected, label, violations) {
  const property = properties.get(name);
  if (property === undefined || !ts.isStringLiteral(property.initializer)) {
    violations.push(`${label} requires a literal string property ${name}.`);
    return;
  }
  if (property.initializer.text !== expected) {
    violations.push(`${label} ${name} must be ${JSON.stringify(expected)}.`);
  }
}

function requireStringArrayProperty(properties, name, expected, label, violations) {
  const property = properties.get(name);
  if (property === undefined || !ts.isArrayLiteralExpression(property.initializer)) {
    violations.push(`${label} requires a literal string array property ${name}.`);
    return;
  }
  const actual = stringArrayValue(properties, name);
  if (!sameArray(actual, expected)) {
    violations.push(
      `${label} ${name} must be exactly ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}.`,
    );
  }
}

function stringArrayValue(properties, name) {
  const property = properties.get(name);
  if (property === undefined || !ts.isArrayLiteralExpression(property.initializer)) return [];
  return property.initializer.elements.flatMap((element) =>
    ts.isStringLiteral(element) ? [element.text] : [],
  );
}

function requireBooleanProperty(properties, name, expected, label, violations) {
  const property = properties.get(name);
  if (
    property === undefined ||
    property.initializer.kind !==
      (expected ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword)
  ) {
    violations.push(`${label} ${name} must be the literal ${String(expected)}.`);
  }
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function sameArray(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function validateEffectivePartition(
  testFiles,
  expectedUnitFiles,
  expectedWorkerFiles,
  effectiveUnitFiles,
  effectiveWorkerFiles,
  repositoryRoot,
  violations,
) {
  const selectedByFile = new Map();
  for (const file of effectiveUnitFiles) {
    selectedByFile.set(file, (selectedByFile.get(file) ?? 0) + 1);
  }
  for (const file of effectiveWorkerFiles) {
    selectedByFile.set(file, (selectedByFile.get(file) ?? 0) + 1);
  }
  const omitted = testFiles.filter((file) => !selectedByFile.has(file));
  const duplicated = testFiles.filter((file) => (selectedByFile.get(file) ?? 0) > 1);
  if (omitted.length > 0) {
    violations.push(
      `Effective test includes omit: ${omitted.map((file) => path.relative(repositoryRoot, file)).join(', ')}`,
    );
  }
  if (duplicated.length > 0) {
    violations.push(
      `Effective test includes overlap: ${duplicated.map((file) => path.relative(repositoryRoot, file)).join(', ')}`,
    );
  }
  if (!samePathSet(effectiveUnitFiles, expectedUnitFiles)) {
    violations.push('Node unit config does not select exactly the test/unit test files.');
  }
  if (!samePathSet(effectiveWorkerFiles, expectedWorkerFiles)) {
    violations.push(
      'Worker config does not select exactly the test/contract and test/integration files.',
    );
  }
}

function samePathSet(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return (
    actualSet.size === expectedSet.size && [...expectedSet].every((file) => actualSet.has(file))
  );
}

function effectiveSelection(patterns, testFiles, testRoot) {
  return testFiles.filter((file) =>
    patterns.some((pattern) =>
      matchesExactPattern(pattern, path.relative(path.dirname(testRoot), file)),
    ),
  );
}

function matchesExactPattern(pattern, relativeToTestRoot) {
  if (typeof pattern !== 'string') return false;
  const match = /^test\/(unit|contract|integration)\/\*\*\/\*\.test\.(ts|tsx|mts|cts)$/.exec(
    pattern,
  );
  if (match === null) return false;
  const prefix = `test/${match[1]}/`;
  const extension = `.${match[2]}`;
  return relativeToTestRoot.startsWith(prefix) && relativeToTestRoot.endsWith(`.test${extension}`);
}

async function findUnitWorkerRuntimeModules(unitFiles, repositoryRoot) {
  const violations = [];
  const visited = new Set();
  const pending = [...unitFiles];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    let source;
    try {
      source = await readCheckedFile(file, repositoryRoot);
    } catch (error) {
      violations.push(formatFilesystemBoundaryError(error));
      continue;
    }
    const analysis = parseTypeScriptImports(source, file);
    for (const diagnostic of analysis.diagnostics) {
      violations.push(`Node unit dependency parsing failed closed for ${file}: ${diagnostic}`);
    }
    for (const unsupported of analysis.unsupported) {
      violations.push(
        `Node unit dependency contains unsupported ${unsupported.kind} syntax at ${file}:${unsupported.line}; the Node phase cannot prove the module graph is Worker-free.`,
      );
    }
    for (const { specifier } of analysis.specifiers) {
      const classification = classifyModuleSpecifier(specifier, allowedTestExternalImports);
      if (workerOnlyModule.test(specifier)) {
        violations.push(
          `Node unit dependency loads Workers-only module ${JSON.stringify(specifier)} from ${file}.`,
        );
      }
      if (classification === 'relative') {
        try {
          const resolved = await resolveRelativeModule(file, specifier, repositoryRoot);
          pending.push(resolved);
        } catch (error) {
          violations.push(formatFilesystemBoundaryError(error));
        }
      } else if (classification !== 'allowlisted') {
        violations.push(
          `Node unit dependency uses ${classification} module ${JSON.stringify(specifier)} from ${file}; only exact allowlisted packages/platform modules are accepted.`,
        );
      }
    }
  }
  return [...new Set(violations)];
}

async function findRelativeImportBoundaryViolations(files, repositoryRoot) {
  const violations = [];
  for (const file of files) {
    let source;
    try {
      source = await readCheckedFile(file, repositoryRoot);
    } catch (error) {
      violations.push(formatFilesystemBoundaryError(error));
      continue;
    }
    const analysis = parseTypeScriptImports(source, file);
    for (const diagnostic of analysis.diagnostics) {
      violations.push(`Test dependency parsing failed closed for ${file}: ${diagnostic}`);
    }
    for (const unsupported of analysis.unsupported) {
      violations.push(
        `Test dependency contains unsupported ${unsupported.kind} syntax at ${file}:${unsupported.line}; the test graph cannot be trusted.`,
      );
    }
    for (const { specifier, kind, line } of analysis.specifiers) {
      const classification = classifyModuleSpecifier(specifier, allowedTestExternalImports);
      if (classification === 'relative') {
        try {
          await resolveRelativeModule(file, specifier, repositoryRoot);
        } catch (error) {
          violations.push(formatFilesystemBoundaryError(error));
        }
      } else if (classification !== 'allowlisted') {
        violations.push(
          `${file}:${line} ${kind} uses ${classification} module specifier ${JSON.stringify(specifier)}; only exact allowlisted packages/platform modules are accepted.`,
        );
      }
    }
  }
  return [...new Set(violations)];
}

function inTestArea(file, testRoot, area) {
  return path.relative(testRoot, file).startsWith(`${area}/`);
}

function isSupportedTestFile(file) {
  return supportedTestExtensions.some((extension) => file.endsWith(`.test.${extension}`));
}

function isAllowedTestSupportFile(relativePath) {
  return allowedTestSupportFiles.has(relativePath);
}

function allTestSupportFiles(allTestFiles, testRoot) {
  return allTestFiles.filter((file) =>
    isAllowedTestSupportFile(path.relative(testRoot, file).split(path.sep).join('/')),
  );
}

const invokedScript = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedScript === fileURLToPath(import.meta.url)) {
  const result = await findTestClassificationViolations();
  if (result.violations.length > 0) {
    throw new Error(
      `Test classification/configuration violations:\n- ${result.violations.join('\n- ')}`,
    );
  }
  globalThis.console.log(
    `Test classification passed: ${result.effectiveUnitFiles.length} Node unit files and ${result.effectiveWorkerFiles.length} Worker contract/integration files; Node config is Worker-free.`,
  );
}
