import type { ExportRecord } from '../domain/models/global-registry';

interface ExportStore {
  createExport(actorId: string): Promise<ExportRecord>;
}

export class ExportService {
  constructor(private readonly store: ExportStore) {}

  create(actorId: string): Promise<ExportRecord> {
    return this.store.createExport(actorId);
  }
}
