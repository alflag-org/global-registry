import type { OpenAPIHono } from '@hono/zod-openapi';
import { ExportService } from '../../application/exports';
import { NotFoundError } from '../../domain/errors/global-registry-error';
import { createExportRoute, getExportRoute, toExportRecordResponse } from '../contracts/exports';
import type { ApiEnvironment } from '../environment';
import { actor, repository } from '../environment';

export function registerExportRoutes(app: OpenAPIHono<ApiEnvironment>): void {
  app.openapi(createExportRoute, async (c) => {
    const { format } = c.req.valid('json');
    void format;
    const exportRecord = await new ExportService(repository(c)).create(actor(c).id);
    return c.json(toExportRecordResponse(exportRecord), 202);
  });

  app.openapi(getExportRoute, async (c) => {
    const { id } = c.req.valid('param');
    const exportRecord = await repository(c).getExport(id);
    if (exportRecord === null) throw new NotFoundError('Export', id);
    return c.json(toExportRecordResponse(exportRecord), 200);
  });
}
