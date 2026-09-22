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
export function registerRoutes(app: OpenAPIHono<ApiEnvironment>) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/locations',
      tags: ['Location'],
      summary: 'List locations',
      request: { query: s.locationQuery },
      responses: {
        200: json(z.object({ items: z.array(s.location), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listLocation(c.env.DB, c.req.valid('query'));
      return c.json(
        { items: result.items.map((row) => s.location.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/locations/{id}',
      tags: ['Location'],
      summary: 'Get locations detail',
      request: { params: s.params },
      responses: { 200: json(s.location), ...errors },
    }),
    async (c) =>
      c.json(s.location.parse(await q.getLocation(c.env.DB, c.req.valid('param').id)), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/locations',
      tags: ['Location'],
      summary: 'Create locations',
      request: {
        body: { required: true, content: { 'application/json': { schema: s.locationInput } } },
      },
      responses: { 201: json(s.location), ...errors },
    }),
    async (c) =>
      c.json(
        s.location.parse(await q.createLocation(c.env.DB, c.get('actor'), c.req.valid('json'))),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/locations/{id}',
      tags: ['Location'],
      summary: 'Update locations',
      request: {
        params: s.params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: s.locationInput.partial().refine((v) => Object.keys(v).length > 0, {
                message: 'Provide at least one field.',
              }),
            },
          },
        },
      },
      responses: { 200: json(s.location), ...errors },
    }),
    async (c) =>
      c.json(
        s.location.parse(
          await q.updateLocation(
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
      path: '/api/v1/locations/{id}',
      tags: ['Location'],
      summary: 'Delete locations',
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deleteLocation(c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/devices',
      tags: ['Device'],
      summary: 'List devices',
      request: { query: s.deviceQuery },
      responses: {
        200: json(z.object({ items: z.array(s.device), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listDevice(c.env.DB, c.req.valid('query'));
      return c.json(
        { items: result.items.map((row) => s.device.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/devices/{id}',
      tags: ['Device'],
      summary: 'Get devices detail',
      request: { params: s.params },
      responses: { 200: json(s.deviceDetail), ...errors },
    }),
    async (c) =>
      c.json(
        s.deviceDetail.parse(await details.deviceDetail(c.env.DB, c.req.valid('param').id)),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/devices',
      tags: ['Device'],
      summary: 'Create devices',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: s.deviceInput.superRefine(s.sourceIdentity) } },
        },
      },
      responses: { 201: json(s.device), ...errors },
    }),
    async (c) =>
      c.json(
        s.device.parse(await q.createDevice(c.env.DB, c.get('actor'), c.req.valid('json'))),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/devices/{id}',
      tags: ['Device'],
      summary: 'Update devices',
      request: {
        params: s.params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: s.deviceInput.partial().refine((v) => Object.keys(v).length > 0, {
                message: 'Provide at least one field.',
              }),
            },
          },
        },
      },
      responses: { 200: json(s.device), ...errors },
    }),
    async (c) =>
      c.json(
        s.device.parse(
          await q.updateDevice(
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
      path: '/api/v1/devices/{id}',
      tags: ['Device'],
      summary: 'Delete devices',
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deleteDevice(c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/virtual-machines',
      tags: ['VM'],
      summary: 'List virtual-machines',
      request: { query: s.vmQuery },
      responses: {
        200: json(z.object({ items: z.array(s.vm), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listVM(c.env.DB, c.req.valid('query'));
      return c.json(
        { items: result.items.map((row) => s.vm.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/virtual-machines/{id}',
      tags: ['VM'],
      summary: 'Get virtual-machines detail',
      request: { params: s.params },
      responses: { 200: json(s.vmDetail), ...errors },
    }),
    async (c) =>
      c.json(s.vmDetail.parse(await details.vmDetail(c.env.DB, c.req.valid('param').id)), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/virtual-machines',
      tags: ['VM'],
      summary: 'Create virtual-machines',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: s.vmInput.superRefine(s.sourceIdentity) } },
        },
      },
      responses: { 201: json(s.vm), ...errors },
    }),
    async (c) =>
      c.json(s.vm.parse(await q.createVM(c.env.DB, c.get('actor'), c.req.valid('json'))), 201),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/virtual-machines/{id}',
      tags: ['VM'],
      summary: 'Update virtual-machines',
      request: {
        params: s.params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: s.vmInput.partial().refine((v) => Object.keys(v).length > 0, {
                message: 'Provide at least one field.',
              }),
            },
          },
        },
      },
      responses: { 200: json(s.vm), ...errors },
    }),
    async (c) =>
      c.json(
        s.vm.parse(
          await q.updateVM(c.env.DB, c.get('actor'), c.req.valid('param').id, c.req.valid('json')),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/virtual-machines/{id}',
      tags: ['VM'],
      summary: 'Delete virtual-machines',
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deleteVM(c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/interfaces',
      tags: ['Interface'],
      summary: 'List interfaces',
      request: { query: s.interfaceQuery },
      responses: {
        200: json(z.object({ items: z.array(s.networkInterface), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listInterface(c.env.DB, c.req.valid('query'));
      return c.json(
        { items: result.items.map((row) => s.networkInterface.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/interfaces/{id}',
      tags: ['Interface'],
      summary: 'Get interfaces detail',
      request: { params: s.params },
      responses: { 200: json(s.networkInterface), ...errors },
    }),
    async (c) =>
      c.json(
        s.networkInterface.parse(await q.getInterface(c.env.DB, c.req.valid('param').id)),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/interfaces',
      tags: ['Interface'],
      summary: 'Create interfaces',
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: s.interfaceInput.superRefine(s.interfaceOwner) },
          },
        },
      },
      responses: { 201: json(s.networkInterface), ...errors },
    }),
    async (c) =>
      c.json(
        s.networkInterface.parse(
          await q.createInterface(c.env.DB, c.get('actor'), c.req.valid('json')),
        ),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/interfaces/{id}',
      tags: ['Interface'],
      summary: 'Update interfaces',
      request: {
        params: s.params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: s.interfaceInput.partial().refine((v) => Object.keys(v).length > 0, {
                message: 'Provide at least one field.',
              }),
            },
          },
        },
      },
      responses: { 200: json(s.networkInterface), ...errors },
    }),
    async (c) =>
      c.json(
        s.networkInterface.parse(
          await q.updateInterface(
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
      path: '/api/v1/interfaces/{id}',
      tags: ['Interface'],
      summary: 'Delete interfaces',
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deleteInterface(c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/vlans',
      tags: ['VLAN'],
      summary: 'List vlans',
      request: { query: s.vlanQuery },
      responses: {
        200: json(z.object({ items: z.array(s.vlan), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listVLAN(c.env.DB, c.req.valid('query'));
      return c.json(
        { items: result.items.map((row) => s.vlan.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/vlans/{id}',
      tags: ['VLAN'],
      summary: 'Get vlans detail',
      request: { params: s.params },
      responses: { 200: json(s.vlan), ...errors },
    }),
    async (c) => c.json(s.vlan.parse(await q.getVLAN(c.env.DB, c.req.valid('param').id)), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/vlans',
      tags: ['VLAN'],
      summary: 'Create vlans',
      request: {
        body: { required: true, content: { 'application/json': { schema: s.vlanInput } } },
      },
      responses: { 201: json(s.vlan), ...errors },
    }),
    async (c) =>
      c.json(s.vlan.parse(await q.createVLAN(c.env.DB, c.get('actor'), c.req.valid('json'))), 201),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/vlans/{id}',
      tags: ['VLAN'],
      summary: 'Update vlans',
      request: {
        params: s.params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: s.vlanInput.partial().refine((v) => Object.keys(v).length > 0, {
                message: 'Provide at least one field.',
              }),
            },
          },
        },
      },
      responses: { 200: json(s.vlan), ...errors },
    }),
    async (c) =>
      c.json(
        s.vlan.parse(
          await q.updateVLAN(
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
      path: '/api/v1/vlans/{id}',
      tags: ['VLAN'],
      summary: 'Delete vlans',
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deleteVLAN(c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/prefixes',
      tags: ['Prefix'],
      summary: 'List prefixes',
      request: { query: s.prefixQuery },
      responses: {
        200: json(z.object({ items: z.array(s.networkPrefix), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listPrefix(c.env.DB, c.req.valid('query'));
      return c.json(
        { items: result.items.map((row) => s.networkPrefix.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/prefixes/{id}',
      tags: ['Prefix'],
      summary: 'Get prefixes detail',
      request: { params: s.params },
      responses: { 200: json(s.prefixDetail), ...errors },
    }),
    async (c) =>
      c.json(
        s.prefixDetail.parse(await details.prefixDetail(c.env.DB, c.req.valid('param').id)),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/prefixes',
      tags: ['Prefix'],
      summary: 'Create prefixes',
      request: {
        body: { required: true, content: { 'application/json': { schema: s.prefixInput } } },
      },
      responses: { 201: json(s.networkPrefix), ...errors },
    }),
    async (c) =>
      c.json(
        s.networkPrefix.parse(await q.createPrefix(c.env.DB, c.get('actor'), c.req.valid('json'))),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/prefixes/{id}',
      tags: ['Prefix'],
      summary: 'Update prefixes',
      request: {
        params: s.params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: s.prefixInput.partial().refine((v) => Object.keys(v).length > 0, {
                message: 'Provide at least one field.',
              }),
            },
          },
        },
      },
      responses: { 200: json(s.networkPrefix), ...errors },
    }),
    async (c) =>
      c.json(
        s.networkPrefix.parse(
          await q.updatePrefix(
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
      path: '/api/v1/prefixes/{id}',
      tags: ['Prefix'],
      summary: 'Delete prefixes',
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deletePrefix(c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ip-addresses',
      tags: ['IP'],
      summary: 'List ip-addresses',
      request: { query: s.ipQuery },
      responses: {
        200: json(z.object({ items: z.array(s.ip), total: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const result = await q.listIP(c.env.DB, c.req.valid('query'));
      return c.json(
        { items: result.items.map((row) => s.ip.parse(row)), total: result.total },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ip-addresses/{id}',
      tags: ['IP'],
      summary: 'Get ip-addresses detail',
      request: { params: s.params },
      responses: { 200: json(s.ip), ...errors },
    }),
    async (c) => c.json(s.ip.parse(await q.getIP(c.env.DB, c.req.valid('param').id)), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ip-addresses',
      tags: ['IP'],
      summary: 'Create ip-addresses',
      request: { body: { required: true, content: { 'application/json': { schema: s.ipInput } } } },
      responses: { 201: json(s.ip), ...errors },
    }),
    async (c) =>
      c.json(s.ip.parse(await q.createIP(c.env.DB, c.get('actor'), c.req.valid('json'))), 201),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/ip-addresses/{id}',
      tags: ['IP'],
      summary: 'Update ip-addresses',
      request: {
        params: s.params,
        body: {
          required: true,
          content: {
            'application/json': {
              schema: s.ipInput.partial().refine((v) => Object.keys(v).length > 0, {
                message: 'Provide at least one field.',
              }),
            },
          },
        },
      },
      responses: { 200: json(s.ip), ...errors },
    }),
    async (c) =>
      c.json(
        s.ip.parse(
          await q.updateIP(c.env.DB, c.get('actor'), c.req.valid('param').id, c.req.valid('json')),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ip-addresses/{id}',
      tags: ['IP'],
      summary: 'Release IP address',
      request: { params: s.params },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await q.deleteIP(c.env.DB, c.get('actor'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );

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
