import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export const supportedTypeScriptExtensions = Object.freeze(['.ts', '.tsx', '.mts', '.cts']);
export const MAX_CHECKED_FILE_BYTES = 8 * 1024 * 1024;

const staticStringKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
]);

export class FilesystemBoundaryError extends Error {
  constructor(message) {
    super(`Filesystem boundary violation: ${message}`);
    this.name = 'FilesystemBoundaryError';
  }
}

export function formatFilesystemBoundaryError(error) {
  if (error instanceof FilesystemBoundaryError) return error.message;
  return 'Filesystem boundary violation: unable to inspect the checked tree';
}

export function isSupportedTypeScriptFile(fileName) {
  return supportedTypeScriptExtensions.some((extension) => fileName.endsWith(extension));
}

export function isRelativeModuleSpecifier(specifier) {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

export function classifyModuleSpecifier(specifier, allowedSpecifiers) {
  if (isRelativeModuleSpecifier(specifier)) return 'relative';
  if (allowedSpecifiers.has(specifier)) return 'allowlisted';
  if (
    specifier.startsWith('/') ||
    specifier.startsWith('\\') ||
    specifier.includes('\\') ||
    /^[A-Za-z]:/.test(specifier)
  ) {
    return 'external-path';
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return 'external-url';
  return 'unknown-bare';
}

export async function checkedRoot(directory) {
  const absolute = path.resolve(directory);
  const information = await readLstat(absolute, 'checked root');
  if (information.isSymbolicLink()) {
    throw new FilesystemBoundaryError(`checked root is a symbolic link: ${absolute}`);
  }
  if (!information.isDirectory()) {
    throw new FilesystemBoundaryError(`checked root is not a directory: ${absolute}`);
  }
  const resolved = await resolveRealpath(absolute, 'checked root');
  return resolved;
}

export async function allRegularFiles(directory) {
  const root = await checkedRoot(directory);
  return walkCheckedTree(root, root);
}

async function walkCheckedTree(directory, root) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new FilesystemBoundaryError(`directory cannot be read: ${directory}`);
  }

  const files = [];
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const information = await readLstat(target, 'filesystem entry');
    if (information.isSymbolicLink()) {
      throw new FilesystemBoundaryError(`unsupported symbolic link: ${target}`);
    }
    if (information.isDirectory()) {
      files.push(...(await walkCheckedTree(target, root)));
      continue;
    }
    if (!information.isFile()) {
      throw new FilesystemBoundaryError(
        `unsupported non-regular filesystem entry: ${target} (${filesystemKind(information)})`,
      );
    }
    files.push(await checkedRegularFile(target, root, information));
  }
  return files.sort();
}

async function checkedRegularFile(file, root, knownInformation, maxBytes = MAX_CHECKED_FILE_BYTES) {
  const absolute = path.resolve(file);
  if (!isPathContained(root, absolute)) {
    throw new FilesystemBoundaryError(`path is outside checked root: ${absolute}`);
  }
  const information = knownInformation ?? (await readLstat(absolute, 'regular file'));
  if (information.isSymbolicLink()) {
    throw new FilesystemBoundaryError(`unsupported symbolic link: ${absolute}`);
  }
  if (!information.isFile()) {
    throw new FilesystemBoundaryError(
      `unsupported non-regular filesystem entry: ${absolute} (${filesystemKind(information)})`,
    );
  }
  ensureBoundedRegularFile(information, absolute, maxBytes);
  const resolved = await resolveRealpath(absolute, 'regular file');
  if (!isPathContained(root, resolved)) {
    throw new FilesystemBoundaryError(`path realpath is outside checked root: ${absolute}`);
  }
  return resolved;
}

export async function readCheckedFile(file, root, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_CHECKED_FILE_BYTES;
  const checkedRootPath = await checkedRoot(root);
  const checkedFile = await checkedRegularFile(file, checkedRootPath, undefined, maxBytes);
  let handle;
  try {
    const pathBeforeOpen = await readLstat(checkedFile, 'checked file');
    ensureBoundedRegularFile(pathBeforeOpen, checkedFile, maxBytes);
    handle = await open(checkedFile, checkedReadFlags());
    const before = await handle.stat();
    ensureBoundedRegularFile(before, checkedFile, maxBytes);
    assertStableFileIdentity(pathBeforeOpen, before, checkedFile);
    const pathBefore = await readLstat(checkedFile, 'checked file');
    assertStableFileIdentity(pathBefore, before, checkedFile);
    const source = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    assertStableFileIdentity(before, after, checkedFile);
    const pathAfter = await readLstat(checkedFile, 'checked file');
    assertStableFileIdentity(before, pathAfter, checkedFile);
    return source;
  } catch (error) {
    if (error instanceof FilesystemBoundaryError) throw error;
    throw new FilesystemBoundaryError(
      `file cannot be read without a stable regular handle: ${checkedFile}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function resolveRelativeModule(file, specifier, expectedRoot) {
  if (!isRelativeModuleSpecifier(specifier)) {
    throw new FilesystemBoundaryError(
      `module ${JSON.stringify(specifier)} is not a contained relative module`,
    );
  }
  const root = await checkedRoot(expectedRoot);
  const source = await checkedRegularFile(file, root);
  const target = path.resolve(path.dirname(source), specifier);
  if (!isPathContained(root, target)) {
    throw new FilesystemBoundaryError(
      `relative module ${JSON.stringify(specifier)} from ${source} is outside checked root`,
    );
  }

  const candidates = [
    target,
    ...supportedTypeScriptExtensions.map((extension) => `${target}${extension}`),
    ...supportedTypeScriptExtensions.map((extension) => path.join(target, `index${extension}`)),
    `${target}.js`,
    path.join(target, 'index.js'),
  ];
  for (const candidate of candidates) {
    const information = await optionalLstat(candidate);
    if (information === undefined) continue;
    if (information.isSymbolicLink()) {
      throw new FilesystemBoundaryError(`unsupported symbolic link: ${candidate}`);
    }
    if (information.isDirectory()) continue;
    if (!information.isFile()) {
      throw new FilesystemBoundaryError(
        `unsupported non-regular filesystem entry: ${candidate} (${filesystemKind(information)})`,
      );
    }
    return checkedRegularFile(candidate, root, information);
  }
  throw new FilesystemBoundaryError(
    `relative module ${JSON.stringify(specifier)} from ${source} cannot be resolved inside checked root`,
  );
}

async function readLstat(target, kind) {
  try {
    return await lstat(target);
  } catch {
    throw new FilesystemBoundaryError(`${kind} cannot be read: ${target}`);
  }
}

async function optionalLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw new FilesystemBoundaryError(`filesystem entry cannot be read: ${target}`);
  }
}

async function resolveRealpath(target, kind) {
  try {
    return await realpath(target);
  } catch {
    throw new FilesystemBoundaryError(`${kind} realpath cannot be read: ${target}`);
  }
}

function checkedReadFlags() {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new FilesystemBoundaryError('the platform does not provide O_NOFOLLOW');
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
}

function ensureBoundedRegularFile(information, target, maxBytes) {
  if (!information.isFile()) {
    throw new FilesystemBoundaryError(
      `unsupported non-regular filesystem entry: ${target} (${filesystemKind(information)})`,
    );
  }
  if (information.size > maxBytes) {
    throw new FilesystemBoundaryError(
      `regular file exceeds the ${maxBytes}-byte inspection limit: ${target}`,
    );
  }
}

function assertStableFileIdentity(expected, actual, target) {
  if (!sameFileIdentity(expected, actual)) {
    throw new FilesystemBoundaryError(`checked file changed during inspection: ${target}`);
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    sameStatTime(left, right, 'mtime') &&
    sameStatTime(left, right, 'ctime') &&
    sameStatTime(left, right, 'birthtime')
  );
}

function sameStatTime(left, right, name) {
  const nanoseconds = `${name}Ns`;
  if (left[nanoseconds] !== undefined || right[nanoseconds] !== undefined) {
    return left[nanoseconds] === right[nanoseconds];
  }
  return left[`${name}Ms`] === right[`${name}Ms`];
}

function filesystemKind(information) {
  if (information.isFIFO()) return 'fifo';
  if (information.isSocket()) return 'socket';
  if (information.isCharacterDevice()) return 'character-device';
  if (information.isBlockDevice()) return 'block-device';
  return 'unsupported';
}

export function isPathContained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function parseTypeScriptImports(source, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(fileName),
  );
  const specifiers = [];
  const unsupported = [];

  const position = (node) => {
    const lineAndCharacter = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return lineAndCharacter.line + 1;
  };

  const addUnsupported = (node, kind) => {
    unsupported.push({ kind, line: position(node) });
  };

  const addStaticSpecifier = (node, argument, kind) => {
    if (argument !== undefined && staticStringKinds.has(argument.kind)) {
      specifiers.push({ specifier: argument.text, kind, line: position(node) });
      return true;
    }
    addUnsupported(node, kind);
    return false;
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      addStaticSpecifier(node, node.moduleSpecifier, 'import declaration');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addStaticSpecifier(node, node.moduleSpecifier, 'export declaration');
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (!ts.isExternalModuleReference(reference)) {
        addUnsupported(node, 'import-equals declaration');
      } else {
        addStaticSpecifier(node, reference.expression, 'import-equals declaration');
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      addStaticSpecifier(node, argument, 'import type');
    } else if (ts.isImportCall(node)) {
      if (node.arguments.length !== 1) {
        addUnsupported(node, 'dynamic import');
      } else {
        addStaticSpecifier(node, node.arguments[0], 'dynamic import');
      }
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isRequire) {
        if (node.arguments.length !== 1) {
          addUnsupported(node, 'require');
        } else {
          addStaticSpecifier(node, node.arguments[0], 'require');
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    specifiers,
    unsupported,
    diagnostics: sourceFile.parseDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ),
  };
}
