import type { FileHandle } from 'node:fs/promises';

export const MAX_STAGED_EXPORT_BYTES: number;

export interface ExportDestination {
  outputPath: string;
  leaf: string;
  parentPath: string;
  parentIdentity: { dev: number; ino: number; mode: number };
}

export interface ExportStaging extends ExportDestination {
  parentHandle: FileHandle;
  parentDescriptorPath: string;
  stagingName: string;
  stagingPath: string;
  stagingHandle: FileHandle;
  stagedOutputPath: string;
  childStagedOutputPath: string;
  stagingIdentity: { dev: number; ino: number; mode: number };
}

export function validateExportOutputPath(
  outputPath: string,
  repositoryRoot?: string,
): Promise<ExportDestination>;
export function createExportStaging(destination: ExportDestination): Promise<ExportStaging>;
export function publishStagedExport(session: ExportStaging): Promise<string>;
export function cleanupExportStaging(session: ExportStaging): Promise<void>;
