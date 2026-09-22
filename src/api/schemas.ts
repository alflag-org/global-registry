import { z } from '@hono/zod-openapi';
import { address, prefix } from '../ipam/address';
const name = z.string().trim().min(1).max(200);
const id = z.uuid();
const text = z.string().max(4000).nullable().optional();
const reference = id.nullable().optional();
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional();
const source = {
  source: name.nullable().optional(),
  source_scope: name.nullable().optional(),
  source_id: name.nullable().optional(),
};
const timestamps = { id, created_at: z.iso.datetime(), updated_at: z.iso.datetime() };
export const locationInput = z
  .object({
    name,
    slug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: text,
  })
  .strict();
export const deviceInput = z
  .object({
    location_id: id,
    name,
    role: name,
    manufacturer: name.nullable().optional(),
    model: name.nullable().optional(),
    serial_number: name.nullable().optional(),
    ...source,
    description: text,
  })
  .strict();
export const vmInput = z
  .object({
    name,
    host_device_id: reference,
    vcpu: positive,
    memory_mb: positive,
    disk_mb: positive,
    ...source,
    description: text,
  })
  .strict();
export const interfaceInput = z
  .object({
    device_id: reference,
    virtual_machine_id: reference,
    name,
    mac_address: z
      .string()
      .regex(/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/)
      .transform((v) => v.toLowerCase())
      .nullable()
      .optional(),
    description: text,
  })
  .strict();
export const vlanInput = z
  .object({ location_id: id, vid: z.number().int().min(1).max(4094), name, description: text })
  .strict();
function canonical(kind: 'address' | 'prefix') {
  return z
    .string()
    .min(1)
    .max(100)
    .transform((v, ctx) => {
      try {
        return kind === 'address' ? address(v).address : prefix(v).cidr;
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: String(error) });
        return z.NEVER;
      }
    });
}
export const prefixInput = z
  .object({
    location_id: id,
    vlan_id: reference,
    cidr: canonical('prefix'),
    name: name.nullable().optional(),
    description: text,
  })
  .strict();
export const ipInput = z
  .object({
    prefix_id: id,
    interface_id: reference,
    address: canonical('address'),
    status: z.enum(['assigned', 'reserved']),
    dns_name: z.string().trim().min(1).max(253).nullable().optional(),
    description: text,
  })
  .strict();
export const allocationInput = ipInput.pick({
  interface_id: true,
  dns_name: true,
  description: true,
});
export function sourceIdentity(
  value: {
    source?: string | null | undefined;
    source_scope?: string | null | undefined;
    source_id?: string | null | undefined;
  },
  ctx: z.RefinementCtx,
) {
  const count = [value.source, value.source_scope, value.source_id].filter((v) => v != null).length;
  if (count !== 0 && count !== 3)
    ctx.addIssue({
      code: 'custom',
      message: 'source, source_scope and source_id must all be set or all be null.',
    });
}
export function interfaceOwner(
  value: { device_id?: string | null | undefined; virtual_machine_id?: string | null | undefined },
  ctx: z.RefinementCtx,
) {
  if ((value.device_id != null) === (value.virtual_machine_id != null))
    ctx.addIssue({
      code: 'custom',
      message: 'An interface must have exactly one Device or Virtual Machine owner.',
    });
}
export const location = locationInput.required().extend(timestamps).openapi('Location');
export const device = deviceInput.required().extend(timestamps).openapi('Device');
export const vm = vmInput.required().extend(timestamps).openapi('VirtualMachine');
export const networkInterface = interfaceInput.required().extend(timestamps).openapi('Interface');
export const vlan = vlanInput.required().extend(timestamps).openapi('VLAN');
// Output schemas contain canonical strings, with no input transformations.
export const networkPrefix = prefixInput
  .required()
  .extend({ ...timestamps, cidr: z.string() })
  .openapi('Prefix');
export const ip = ipInput
  .required()
  .extend({ ...timestamps, address: z.string() })
  .openapi('IPAddress');
export const deviceDetail = device
  .extend({
    interfaces: z.array(networkInterface),
    ip_addresses: z.array(ip),
    virtual_machines: z.array(vm),
  })
  .openapi('DeviceDetail');
export const vmDetail = vm
  .extend({
    host_device: device.nullable(),
    location: location.nullable(),
    interfaces: z.array(networkInterface),
    ip_addresses: z.array(ip),
  })
  .openapi('VirtualMachineDetail');
export const prefixDetail = networkPrefix
  .extend({
    location,
    vlan: vlan.nullable(),
    ip_addresses: z.array(ip),
    more_specific_prefixes: z.array(networkPrefix),
  })
  .openapi('PrefixDetail');
export const auditId = z.string().regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
export const audit = z
  .object({
    id: auditId,
    actor: z.string(),
    action: z.enum(['create', 'update', 'delete', 'allocate', 'release']),
    entity_type: z.string(),
    entity_id: id,
    before_json: z.string().nullable(),
    after_json: z.string().nullable(),
    created_at: z.iso.datetime(),
  })
  .openapi('AuditLog');
export const errorSchema = z.object({ code: z.string(), message: z.string() }).openapi('Error');
export const params = z.object({ id });
export const pagination = {
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};
export const locationQuery = z.object(pagination).strict();
export const deviceQuery = z
  .object({
    ...pagination,
    location_id: id.optional(),
    source: name.optional(),
    source_scope: name.optional(),
  })
  .strict();
export const vmQuery = z
  .object({
    ...pagination,
    location_id: id.optional(),
    host_device_id: id.optional(),
    source: name.optional(),
    source_scope: name.optional(),
  })
  .strict();
export const interfaceQuery = z
  .object({ ...pagination, device_id: id.optional(), virtual_machine_id: id.optional() })
  .strict();
export const vlanQuery = z.object({ ...pagination, location_id: id.optional() }).strict();
export const prefixQuery = z
  .object({ ...pagination, location_id: id.optional(), vlan_id: id.optional() })
  .strict();
export const ipQuery = z
  .object({
    ...pagination,
    prefix_id: id.optional(),
    interface_id: id.optional(),
    status: z.enum(['assigned', 'reserved']).optional(),
  })
  .strict();
export const auditQuery = z
  .object({
    ...pagination,
    entity_type: z
      .enum([
        'locations',
        'devices',
        'virtual_machines',
        'interfaces',
        'vlans',
        'prefixes',
        'ip_addresses',
      ])
      .optional(),
    entity_id: id.optional(),
    actor: z.string().max(256).optional(),
    action: audit.shape.action.optional(),
  })
  .strict();
export type Query = { q?: string | undefined; limit: number; offset: number } & Record<
  string,
  string | number | undefined
>;
