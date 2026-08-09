import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const MAX_STAGED_EXPORT_BYTES = 32 * 1024 * 1024;
const CHILD_STAGING_DIRECTORY_FD = 3;

export async function validateExportOutputPath(outputPath, repositoryRoot = process.cwd()) {
  if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
    throw new Error('export output path is required explicitly.');
  }
  if (!path.isAbsolute(outputPath) || outputPath.includes('\\')) {
    throw new Error('export output path must be an absolute POSIX or platform-native path.');
  }
  if (process.platform === 'win32') {
    throw new Error('secure SQL export publishing requires a POSIX descriptor-backed filesystem.');
  }
  const absoluteOutputPath = path.resolve(outputPath);
  const leaf = path.basename(absoluteOutputPath);
  if (leaf.length === 0 || leaf === '.' || leaf === '..') {
    throw new Error('export output path must name a file.');
  }
  const checkedRepositoryRoot = await checkedRealDirectory(repositoryRoot, 'repository root');
  const parentPath = path.dirname(absoluteOutputPath);
  const checkedParent = await checkedRealDirectory(parentPath, 'export output parent');
  if (
    isContained(checkedRepositoryRoot.path, absoluteOutputPath) ||
    isContained(checkedRepositoryRoot.path, checkedParent.path)
  ) {
    throw new Error('export output must remain outside the repository worktree.');
  }

  const existing = await optionalLstat(absoluteOutputPath);
  if (existing !== undefined) {
    throw new Error('export output already exists; refusing to overwrite it.');
  }
  return {
    outputPath: absoluteOutputPath,
    leaf,
    parentPath: checkedParent.path,
    parentIdentity: checkedParent.identity,
  };
}

export async function createExportStaging(destination) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error('secure SQL export publishing requires no-follow directory handles.');
  }
  if (!Number.isInteger(constants.O_RDONLY)) {
    throw new Error('secure SQL export publishing requires read-only directory handles.');
  }

  const parentHandle = await open(
    destination.parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let stagingPath;
  let stagingName;
  let stagingHandle;
  try {
    if (!Number.isInteger(parentHandle.fd) || parentHandle.fd < CHILD_STAGING_DIRECTORY_FD) {
      throw new Error(
        'secure SQL export publishing requires a directory descriptor that can be inherited by the export child.',
      );
    }
    const parentInformation = await parentHandle.stat();
    assertRegularDirectory(parentInformation, destination.parentPath);
    if (!sameDirectoryIdentity(directoryIdentity(parentInformation), destination.parentIdentity)) {
      throw new Error('export output parent changed before its stable directory handle opened.');
    }
    const parentDescriptorPath = descriptorPath(parentHandle);
    stagingName = `.global-registry-export-${randomUUID()}`;
    stagingPath = path.join(destination.parentPath, stagingName);
    await mkdir(path.join(parentDescriptorPath, stagingName), { mode: 0o700 });
    stagingHandle = await open(
      path.join(parentDescriptorPath, stagingName),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!Number.isInteger(stagingHandle.fd) || stagingHandle.fd < CHILD_STAGING_DIRECTORY_FD) {
      throw new Error(
        'secure SQL export publishing requires an inheritable staging directory descriptor.',
      );
    }
    const stagingInformation = await stagingHandle.stat();
    assertPrivateDirectory(stagingInformation, stagingPath);
    const stagedPathInformation = await lstat(path.join(parentDescriptorPath, stagingName));
    if (
      stagedPathInformation.isSymbolicLink() ||
      !sameDirectoryIdentity(
        directoryIdentity(stagedPathInformation),
        directoryIdentity(stagingInformation),
      )
    ) {
      throw new Error(
        'export staging directory changed before the child could use its descriptor.',
      );
    }
    return {
      ...destination,
      parentHandle,
      parentDescriptorPath,
      stagingName,
      stagingPath,
      stagingHandle,
      stagedOutputPath: path.join(descriptorPath(stagingHandle), 'export.sql'),
      childStagedOutputPath: path.join(childDescriptorPath(stagingHandle), 'export.sql'),
      stagingIdentity: directoryIdentity(stagingInformation),
    };
  } catch (error) {
    await stagingHandle?.close().catch(() => undefined);
    if (stagingName !== undefined) {
      await rm(path.join(descriptorPath(parentHandle), stagingName), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    await parentHandle.close().catch(() => undefined);
    throw error;
  }
}

export async function publishStagedExport(session) {
  await assertStableStagingDirectory(session);
  const stagedInformation = await checkedRegularFile(session.stagedOutputPath, 'staged SQL export');
  await syncRegularFile(session.stagedOutputPath, stagedInformation);
  await assertStableDestinationParent(session);

  const publishedPath = path.join(session.parentDescriptorPath, session.leaf);
  try {
    await link(session.stagedOutputPath, publishedPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('export output appeared during export; refusing to overwrite it.', {
        cause: error,
      });
    }
    if (error?.code === 'EXDEV') {
      throw new Error('export staging and destination are on different filesystems.', {
        cause: error,
      });
    }
    throw new Error('atomic no-replace SQL export publication failed.', { cause: error });
  }

  let publishedInformation;
  try {
    publishedInformation = await lstat(publishedPath);
    if (
      publishedInformation.isSymbolicLink() ||
      !publishedInformation.isFile() ||
      !sameFileIdentity(publishedInformation, stagedInformation)
    ) {
      throw new Error('published SQL export is not the validated regular staging file.');
    }
    await assertStableDestinationParent(session);
    await assertStableStagingDirectory(session);
    await session.parentHandle.sync();
  } catch (error) {
    if (publishedInformation !== undefined) {
      await removePublishedFileIfOwned(publishedPath, publishedInformation).catch(() => undefined);
    }
    throw error;
  }
  return session.outputPath;
}

export async function cleanupExportStaging(session) {
  await rm(path.join(session.parentDescriptorPath, session.stagingName), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  await session.stagingHandle.close().catch(() => undefined);
  await session.parentHandle.close().catch(() => undefined);
}

async function assertStableStagingDirectory(session) {
  const currentStaging = await lstat(
    path.join(session.parentDescriptorPath, session.stagingName),
  ).catch((error) => {
    throw new Error(
      `export staging directory changed while the command ran: ${session.stagingPath}`,
      {
        cause: error,
      },
    );
  });
  if (
    currentStaging.isSymbolicLink() ||
    !currentStaging.isDirectory() ||
    !sameDirectoryIdentity(directoryIdentity(currentStaging), session.stagingIdentity)
  ) {
    throw new Error(
      `export staging directory changed while the command ran: ${session.stagingPath}`,
    );
  }
  const openStaging = await session.stagingHandle.stat();
  if (!sameDirectoryIdentity(directoryIdentity(openStaging), session.stagingIdentity)) {
    throw new Error(
      `export staging directory handle changed while the command ran: ${session.stagingPath}`,
    );
  }
}

async function assertStableDestinationParent(session) {
  const currentParent = await checkedRealDirectory(
    path.dirname(session.outputPath),
    'export output parent',
  );
  if (
    currentParent.path !== session.parentPath ||
    !sameDirectoryIdentity(currentParent.identity, session.parentIdentity)
  ) {
    throw new Error(`export output parent changed while the command ran: ${session.outputPath}`);
  }
  const openParent = await session.parentHandle.stat();
  if (!sameDirectoryIdentity(directoryIdentity(openParent), session.parentIdentity)) {
    throw new Error(
      `export output parent handle changed while the command ran: ${session.outputPath}`,
    );
  }
}

async function syncRegularFile(filePath, expectedInformation) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const information = await handle.stat();
    if (!information.isFile() || !sameFileIdentity(information, expectedInformation)) {
      throw new Error('staged SQL export changed while it was being published.');
    }
    if (information.size === 0 || information.size > MAX_STAGED_EXPORT_BYTES) {
      throw new Error('staged SQL export is empty or exceeds the bounded export size.');
    }
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function removePublishedFileIfOwned(publishedPath, expectedInformation) {
  const current = await lstat(publishedPath).catch(() => undefined);
  if (current !== undefined && sameFileIdentity(current, expectedInformation)) {
    await rm(publishedPath, { force: true });
  }
}

async function checkedRegularFile(filePath, label) {
  const information = await lstat(filePath).catch((error) => {
    throw new Error(`${label} was not created as a readable regular file: ${filePath}`, {
      cause: error,
    });
  });
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  if (information.size === 0 || information.size > MAX_STAGED_EXPORT_BYTES) {
    throw new Error(`${label} is empty or exceeds the bounded export size: ${filePath}`);
  }
  return information;
}

async function checkedRealDirectory(directory, label) {
  const absolute = path.resolve(directory);
  const information = await lstat(absolute).catch((error) => {
    throw new Error(`${label} cannot be inspected: ${absolute}`, { cause: error });
  });
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error(`${label} must be a regular directory without a symlink: ${absolute}`);
  }
  await rejectSymlinkedComponents(absolute, label);
  const resolved = await realpath(absolute).catch((error) => {
    throw new Error(`${label} realpath cannot be inspected: ${absolute}`, { cause: error });
  });
  const resolvedInformation = await lstat(resolved).catch((error) => {
    throw new Error(`${label} changed while it was inspected: ${absolute}`, { cause: error });
  });
  if (!resolvedInformation.isDirectory()) {
    throw new Error(`${label} is not a stable directory: ${absolute}`);
  }
  return {
    path: resolved,
    identity: directoryIdentity(resolvedInformation),
  };
}

async function rejectSymlinkedComponents(directory, label) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  const remainder = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of remainder) {
    current = path.join(current, component);
    const information = await lstat(current).catch((error) => {
      throw new Error(`${label} component cannot be inspected: ${current}`, { cause: error });
    });
    if (information.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic-link component: ${current}`);
    }
    if (!information.isDirectory()) {
      throw new Error(`${label} component is not a directory: ${current}`);
    }
  }
}

async function optionalLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`export output cannot be inspected: ${target}`, { cause: error });
  }
}

function descriptorPath(handle) {
  if (handle.fd === undefined || !path.isAbsolute('/proc/self/fd')) {
    throw new Error('secure SQL export publishing requires /proc/self/fd directory handles.');
  }
  return `/proc/self/fd/${handle.fd}`;
}

function childDescriptorPath(handle) {
  if (
    handle.fd === undefined ||
    !Number.isInteger(handle.fd) ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 0
  ) {
    throw new Error('secure SQL export publishing requires a stable parent process descriptor.');
  }
  return `/proc/${process.pid}/fd/${handle.fd}`;
}

function assertRegularDirectory(information, target) {
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`export output parent is not a regular directory: ${target}`);
  }
}

function assertPrivateDirectory(information, target) {
  assertRegularDirectory(information, target);
  if ((information.mode & 0o077) !== 0) {
    throw new Error(`export staging directory is not private: ${target}`);
  }
  if (typeof process.getuid === 'function' && information.uid !== process.getuid()) {
    throw new Error(`export staging directory is not process-owned: ${target}`);
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function directoryIdentity(information) {
  return { dev: information.dev, ino: information.ino, mode: information.mode };
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
