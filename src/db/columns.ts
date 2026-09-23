// Public column lists per entity, in storage order. Audit snapshots and API rows
// expose exactly these; derived lookup columns (family, ranges, keys) stay internal.
export const locationColumns = [
  'id',
  'name',
  'slug',
  'description',
  'created_at',
  'updated_at',
] as const;
export const deviceColumns = [
  'id',
  'location_id',
  'name',
  'role',
  'manufacturer',
  'model',
  'serial_number',
  'source',
  'source_scope',
  'source_id',
  'description',
  'created_at',
  'updated_at',
] as const;
export const vmColumns = [
  'id',
  'name',
  'host_device_id',
  'vcpu',
  'memory_mb',
  'disk_mb',
  'source',
  'source_scope',
  'source_id',
  'description',
  'created_at',
  'updated_at',
] as const;
export const interfaceColumns = [
  'id',
  'device_id',
  'virtual_machine_id',
  'name',
  'mac_address',
  'description',
  'created_at',
  'updated_at',
] as const;
export const vlanColumns = [
  'id',
  'location_id',
  'vid',
  'name',
  'description',
  'created_at',
  'updated_at',
] as const;
export const prefixColumns = [
  'id',
  'location_id',
  'vlan_id',
  'cidr',
  'name',
  'description',
  'created_at',
  'updated_at',
] as const;
export const ipColumns = [
  'id',
  'prefix_id',
  'interface_id',
  'address',
  'status',
  'dns_name',
  'description',
  'created_at',
  'updated_at',
] as const;
