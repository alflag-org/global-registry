export const LOCATION_CATEGORIES = ['site', 'region', 'zone'] as const;
export const ADDRESS_FAMILIES = ['ipv4', 'ipv6', 'dual_stack'] as const;
export const COMPUTE_SUBSTRATES = ['vm', 'container', 'bare_metal'] as const;
export const ARCHITECTURES = ['amd64', 'arm64'] as const;
export const VOLUME_ACCESS_MODES = [
  'read_write_once',
  'read_write_many',
  'read_only_many',
] as const;
export const SERVICE_TOPOLOGIES = ['single', 'high_availability', 'distributed'] as const;
export const ENDPOINT_PROTOCOLS = ['tcp', 'udp', 'http', 'https'] as const;
export const ENDPOINT_EXPOSURES = ['private', 'internal', 'public'] as const;
export const BACKUP_REPOSITORY_TYPES = ['object_storage', 'filesystem'] as const;
