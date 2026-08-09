import path from 'node:path';
import { cwd } from 'node:process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  allRegularFiles,
  checkedRoot,
  formatFilesystemBoundaryError,
  classifyModuleSpecifier,
  isPathContained,
  isSupportedTypeScriptFile,
  parseTypeScriptImports,
  readCheckedFile,
  resolveRelativeModule,
} from './typescript-imports.mjs';

const defaultSourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const adapterNames = new Set(['access', 'd1', 'queue', 'r2']);
const portOnlyAdapters = new Map([
  ['queue', 'application/ports'],
  ['r2', 'application/ports'],
]);
const allowedSourceExternalImports = new Set([
  '@hono/zod-openapi',
  'cloudflare:workers',
  'hono',
  'hono/http-exception',
  'node:path',
  'zod',
]);
const allowedPortOnlyExternalImports = new Set(['cloudflare:workers', 'node:path']);
const forbiddenDomainPlatformImport = /^(?:cloudflare:|hono(?:\/|$)|@hono\/)/;
const forbiddenPlatformType =
  /\b(?:D1Database|D1PreparedStatement|D1Result|R2Bucket|MessageBatch|Queue)\b/;

export async function findDomainBoundaryViolations(sourceRoot = defaultSourceRoot) {
  const violations = [];
  let checkedSourceRoot;
  let allSourceFiles;
  try {
    checkedSourceRoot = await checkedRoot(sourceRoot);
    allSourceFiles = await allRegularFiles(checkedSourceRoot);
  } catch (error) {
    return [formatFilesystemBoundaryError(error)];
  }

  const importAnalyses = new Map();
  const syntaxCheckedFiles = new Set();
  const unsupportedSourceFiles = allSourceFiles.filter((file) => !isSupportedTypeScriptFile(file));
  if (unsupportedSourceFiles.length > 0) {
    violations.push(
      `Unsupported source file suffix or name form under src (only .ts, .tsx, .mts, and .cts are allowed): ${unsupportedSourceFiles.map(displayPath).join(', ')}`,
    );
  }

  const importAnalysis = async (file) => {
    const cached = importAnalyses.get(file);
    if (cached !== undefined) return cached;
    let analysis;
    try {
      analysis = parseTypeScriptImports(await readCheckedFile(file, checkedSourceRoot), file);
    } catch (error) {
      violations.push(formatFilesystemBoundaryError(error));
      analysis = { specifiers: [], unsupported: [], diagnostics: [] };
    }
    importAnalyses.set(file, analysis);
    if (!syntaxCheckedFiles.has(file)) {
      syntaxCheckedFiles.add(file);
      for (const diagnostic of analysis.diagnostics) {
        violations.push(
          `TypeScript import parsing failed closed for ${displayPath(file)}: ${diagnostic}`,
        );
      }
      for (const unsupported of analysis.unsupported) {
        violations.push(
          `Cannot classify ${unsupported.kind} at ${displayPath(file)}:${unsupported.line}; boundary checking fails closed for unsupported module syntax.`,
        );
      }
    }
    return analysis;
  };

  for (const file of allSourceFiles.filter(isSupportedTypeScriptFile)) {
    const analysis = await importAnalysis(file);
    await validateModuleSpecifiers(
      file,
      analysis.specifiers,
      checkedSourceRoot,
      allowedSourceExternalImports,
      violations,
    );
  }

  const domainRoot = path.join(checkedSourceRoot, 'domain');
  for (const file of sourceFiles(domainRoot, allSourceFiles, checkedSourceRoot)) {
    const source = await readCheckedFile(file, checkedSourceRoot).catch((error) => {
      appendUnique(violations, formatFilesystemBoundaryError(error));
      return '';
    });
    const analysis = await importAnalysis(file);
    const domainImports = analysis.specifiers
      .map(({ specifier }) => specifier)
      .filter((specifier) => forbiddenDomainPlatformImport.test(specifier));
    if (domainImports.length > 0 || forbiddenPlatformType.test(source)) {
      violations.push(
        `HTTP or Cloudflare platform dependencies leaked into the domain layer: ${displayPath(file)}`,
      );
    }
  }

  const applicationImports = [];
  for (const file of sourceFiles(
    path.join(checkedSourceRoot, 'application'),
    allSourceFiles,
    checkedSourceRoot,
  )) {
    const analysis = await importAnalysis(file);
    const internalImports = await internalTargetsFrom(
      file,
      analysis,
      checkedSourceRoot,
      violations,
    );
    if (internalImports.some((target) => target.startsWith('adapters/'))) {
      applicationImports.push(displayPath(file));
    }
  }
  if (applicationImports.length > 0) {
    violations.push(
      `Application services depend on adapter implementations: ${applicationImports.join(', ')}`,
    );
  }

  const adapterImports = [];
  for (const file of sourceFiles(
    path.join(checkedSourceRoot, 'adapters'),
    allSourceFiles,
    checkedSourceRoot,
  )) {
    const relative = relativeSourcePath(file, checkedSourceRoot);
    const segments = relative.split('/');
    const currentAdapter = segments[1];
    if (currentAdapter === undefined || !adapterNames.has(currentAdapter)) continue;

    const analysis = await importAnalysis(file);
    for (const { specifier } of analysis.specifiers) {
      const classification = classifyModuleSpecifier(specifier, allowedSourceExternalImports);
      if (classification !== 'relative') {
        if (classification !== 'allowlisted') {
          adapterImports.push(
            portOnlyAdapters.has(currentAdapter)
              ? `${displayPath(file)} imports ${classification} module ${JSON.stringify(specifier)}; ${currentAdapter} adapters are port-only and accept only exact platform/standard-library allowlist entries`
              : `${displayPath(file)} imports ${classification} module ${JSON.stringify(specifier)}; unknown or external module specifiers are rejected`,
          );
        } else if (
          portOnlyAdapters.has(currentAdapter) &&
          !allowedPortOnlyExternalImports.has(specifier)
        ) {
          adapterImports.push(
            `${displayPath(file)} imports non-platform dependency ${JSON.stringify(specifier)}; ${currentAdapter} adapters are port-only`,
          );
        }
        continue;
      }
      const target = await resolveInternalImport(file, specifier, checkedSourceRoot, violations);
      if (target === undefined) continue;
      if (target.startsWith('adapters/')) {
        const importedAdapter = target.split('/')[1];
        if (adapterNames.has(importedAdapter) && importedAdapter !== currentAdapter) {
          adapterImports.push(
            `${displayPath(file)} imports concrete adapter ${JSON.stringify(specifier)}`,
          );
        }
      }
      if (portOnlyAdapters.has(currentAdapter) && target !== 'application/ports') {
        adapterImports.push(
          `${displayPath(file)} imports ${JSON.stringify(specifier)}; ${currentAdapter} adapters may import only application/ports plus allowlisted platform/standard-library dependencies`,
        );
      }
    }
  }
  if (adapterImports.length > 0) {
    violations.push(`Adapter dependency boundary violations: ${adapterImports.join('; ')}`);
  }

  const directRouteMutations = [];
  for (const file of sourceFiles(
    path.join(checkedSourceRoot, 'api/routes'),
    allSourceFiles,
    checkedSourceRoot,
  )) {
    const source = await readCheckedFile(file, checkedSourceRoot).catch((error) => {
      appendUnique(violations, formatFilesystemBoundaryError(error));
      return '';
    });
    if (
      /repository\(c\)\.(?:create|update|put|replace|remove|transition|acquire|mark)[A-Z]/.test(
        source,
      )
    ) {
      directRouteMutations.push(displayPath(file));
    }
  }
  if (directRouteMutations.length > 0) {
    violations.push(
      `API routes bypass application services for mutations: ${directRouteMutations.join(', ')}`,
    );
  }

  const d1DecisionImports = [];
  for (const file of sourceFiles(
    path.join(checkedSourceRoot, 'adapters/d1'),
    allSourceFiles,
    checkedSourceRoot,
  )) {
    const analysis = await importAnalysis(file);
    for (const target of await internalTargetsFrom(file, analysis, checkedSourceRoot, violations)) {
      if (/^domain\/(?:lifecycle|policy|provider|resource)\//.test(target)) {
        d1DecisionImports.push(displayPath(file));
        break;
      }
    }
  }
  if (d1DecisionImports.length > 0) {
    violations.push(`D1 adapters import domain decision modules: ${d1DecisionImports.join(', ')}`);
  }

  return [...new Set(violations)];
}

function sourceFiles(directory, allSourceFiles, root) {
  const absolute = path.resolve(directory);
  if (!isPathContained(root, absolute)) return [];
  return allSourceFiles.filter(
    (file) => isPathContained(absolute, file) && isSupportedTypeScriptFile(file),
  );
}

async function internalTargetsFrom(file, analysis, sourceRoot, violations) {
  const targets = [];
  for (const { specifier } of analysis.specifiers) {
    const classification = classifyModuleSpecifier(specifier, allowedSourceExternalImports);
    if (classification !== 'relative') {
      if (classification !== 'allowlisted') {
        appendUnique(
          violations,
          `${displayPath(file)} contains ${classification} module specifier ${JSON.stringify(specifier)}; it is not in the checked dependency allowlist`,
        );
      }
      continue;
    }
    const target = await resolveInternalImport(file, specifier, sourceRoot, violations);
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

async function validateModuleSpecifiers(
  file,
  specifiers,
  sourceRoot,
  allowedExternalImports,
  violations,
) {
  for (const { specifier, kind, line } of specifiers) {
    const classification = classifyModuleSpecifier(specifier, allowedExternalImports);
    if (classification === 'relative') {
      try {
        await resolveRelativeModule(file, specifier, sourceRoot);
      } catch (error) {
        appendUnique(violations, formatFilesystemBoundaryError(error));
      }
      continue;
    }
    if (classification !== 'allowlisted') {
      appendUnique(
        violations,
        `${displayPath(file)}:${line} ${kind} uses ${classification} module specifier ${JSON.stringify(specifier)}; only contained relative modules and exact allowlisted packages/platform modules are accepted`,
      );
    }
  }
}

async function resolveInternalImport(file, specifier, sourceRoot, violations) {
  try {
    await resolveRelativeModule(file, specifier, sourceRoot);
  } catch (error) {
    appendUnique(violations, formatFilesystemBoundaryError(error));
    return undefined;
  }
  const target = path.resolve(path.dirname(file), specifier);
  if (!isPathContained(sourceRoot, target)) return undefined;
  return relativeSourcePath(target, sourceRoot)
    .replace(/(?:\.d)?\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/, '')
    .replace(/\/index$/, '');
}

function relativeSourcePath(file, sourceRoot) {
  return path.relative(sourceRoot, file).split(path.sep).join('/');
}

function displayPath(file) {
  return path.relative(cwd(), file).split(path.sep).join('/');
}

function appendUnique(violations, violation) {
  if (!violations.includes(violation)) violations.push(violation);
}

export async function checkDomainBoundary(sourceRoot = defaultSourceRoot) {
  return findDomainBoundaryViolations(sourceRoot);
}

const invokedScript = process.argv[1] === undefined ? '' : path.resolve(process.argv[1]);
if (invokedScript === fileURLToPath(import.meta.url)) {
  const violations = await findDomainBoundaryViolations();
  if (violations.length > 0) {
    throw new Error(violations.join('\n'));
  }
  globalThis.console.log('Domain boundary check passed.');
}
