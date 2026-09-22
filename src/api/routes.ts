import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import * as s from './schemas';
import * as q from '../db/queries';
import * as details from '../db/details';
import { allocate } from '../ipam/allocate';
import { list } from '../db/lists';
import { required } from '../db/mutations';
import type { ApiEnvironment } from '../db/types';
const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
  description: 'Success',
});
const errors = {
  400: { ...json(s.errorSchema), description: 'Validation error' },
  401: { ...json(s.errorSchema), description: 'Authentication required' },
  403: { ...json(s.errorSchema), description: 'Forbidden' },
  404: { ...json(s.errorSchema), description: 'Not found' },
  409: { ...json(s.errorSchema), description: 'Uniqueness, relationship or concurrency conflict' },
  503: { ...json(s.errorSchema), description: 'Authentication configuration or keys unavailable' },
};
const nonEmpty = (schema: z.ZodObject<z.ZodRawShape>) =>
  schema.partial().refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field.',
  });
interface Resource {
  entity: q.Entity;
  path: string;
  tag: string;
  name: string;
  deleteVerb: string;
  query: z.ZodObject<z.ZodRawShape>;
  output: z.ZodType;
  detail?: { schema: z.ZodType; get: (db: D1Database, id: string) => Promise<unknown> };
}
function registerResource(app: OpenAPIHono<ApiEnvironment>, resource: Resource) {
  const { entity, path, tag, name, deleteVerb, query, output } = resource;
  const base = `/api/v1/${path}`;
  const getOne =
    resource.detail?.get ?? ((db: D1Database, id: string) => q.getEntity(entity, db, id));
  const detailSchema = resource.detail?.schema ?? output;
  app.openapi(
    createRoute({
      method: 'get',
      path: base,
      tags: [tag],
      summary: `List ${name}`,
      request: { query },
      responses: {
        200: json(z.object({ items: z.array(output), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listEntity(entity, c.env.DB, c.req.valid('query') as s.Query);
      return c.json(
        { items: result.items.map((row) => output.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: `${base}/{id}`,
      tags: [tag],
      summary: `Get ${name} detail`,
      request: { params: s.params },
      responses: { 200: json(detailSchema), ...errors },
    }),
    async (c) => c.json(detailSchema.parse(await getOne(c.env.DB, c.req.valid('param').id)), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base,
      tags: [tag],
      summary: `Create ${name}`,
      request: {
        body: { required: true, content: { 'application/json': { schema: entity.schema } } },
      },
      responses: { 201: json(output), ...errors },
    }),
    async (c) =>
      c.json(
        output.parse(await q.createEntity(entity, c.env.DB, c.get('actor'), c.req.valid('json'))),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: `${base}/{id}`,
      tags: [tag],
      summary: `Update ${name}`,
      request: {
        params: s.params,
        body: {
          required: true,
          content: { 'application/json': { schema: nonEmpty(entity.input) } },
        },
      },
      responses: { 200: json(output), ...errors },
    }),
    async (c) =>
      c.json(
        output.parse(
          await q.updateEntity(
            entity,
            c.env.DB,
            c.get('actor'),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: `${base}/{id}`,
      tags: [tag],
      summary: deleteVerb,
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deleteEntity(entity, c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}
const resources: Resource[] = [
  {
    entity: q.entities.locations,
    path: 'locations',
    tag: 'Location',
    name: 'locations',
    deleteVerb: 'Delete locations',
    query: s.locationQuery,
    output: s.location,
  },
  {
    entity: q.entities.devices,
    path: 'devices',
    tag: 'Device',
    name: 'devices',
    deleteVerb: 'Delete devices',
    query: s.deviceQuery,
    output: s.device,
    detail: { schema: s.deviceDetail, get: details.deviceDetail },
  },
  {
    entity: q.entities.virtual_machines,
    path: 'virtual-machines',
    tag: 'VM',
    name: 'virtual-machines',
    deleteVerb: 'Delete virtual-machines',
    query: s.vmQuery,
    output: s.vm,
    detail: { schema: s.vmDetail, get: details.vmDetail },
  },
  {
    entity: q.entities.interfaces,
    path: 'interfaces',
    tag: 'Interface',
    name: 'interfaces',
    deleteVerb: 'Delete interfaces',
    query: s.interfaceQuery,
    output: s.networkInterface,
  },
  {
    entity: q.entities.vlans,
    path: 'vlans',
    tag: 'VLAN',
    name: 'vlans',
    deleteVerb: 'Delete vlans',
    query: s.vlanQuery,
    output: s.vlan,
  },
  {
    entity: q.entities.prefixes,
    path: 'prefixes',
    tag: 'Prefix',
    name: 'prefixes',
    deleteVerb: 'Delete prefixes',
    query: s.prefixQuery,
    output: s.networkPrefix,
    detail: { schema: s.prefixDetail, get: details.prefixDetail },
  },
  {
    entity: q.entities.ip_addresses,
    path: 'ip-addresses',
    tag: 'IP',
    name: 'ip-addresses',
    deleteVerb: 'Release IP address',
    query: s.ipQuery,
    output: s.ip,
  },
];
export function registerRoutes(app: OpenAPIHono<ApiEnvironment>) {
  for (const resource of resources) registerResource(app, resource);
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/prefixes/{id}/allocate',
      tags: ['Prefix'],
      summary: 'Allocate the lowest available IP address',
      request: {
        params: s.params,
        body: { required: true, content: { 'application/json': { schema: s.allocationInput } } },
      },
      responses: { 201: json(s.ip), ...errors },
    }),
    async (c) =>
      c.json(
        s.ip.parse(
          await allocate(c.env.DB, c.get('actor'), c.req.valid('param').id, c.req.valid('json')),
        ),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/audit-log',
      tags: ['Audit Log'],
      summary: 'List append-only audit records',
      request: { query: s.auditQuery },
      responses: {
        200: json(z.object({ items: z.array(s.audit), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await list(
        c.env.DB,
        'audit_log',
        '*',
        c.req.valid('query'),
        ['actor', 'entity_id', 'entity_type', 'action'],
        { entity_type: 'entity_type', entity_id: 'entity_id', actor: 'actor', action: 'action' },
      );
      return c.json(
        { items: result.items.map((row) => s.audit.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/audit-log/{id}',
      tags: ['Audit Log'],
      summary: 'Get an audit record',
      request: { params: z.object({ id: s.auditId }) },
      responses: { 200: json(s.audit), ...errors },
    }),
    async (c) =>
      c.json(
        s.audit.parse(
          await required(c.env.DB, 'SELECT * FROM audit_log WHERE id=?', c.req.valid('param').id),
        ),
        200,
      ),
  );
}
