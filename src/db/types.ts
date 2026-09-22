export type Table =
  | 'locations'
  | 'devices'
  | 'virtual_machines'
  | 'interfaces'
  | 'vlans'
  | 'prefixes'
  | 'ip_addresses';
export type Row = Record<string, string | number | null> & { id: string };
export interface Environment {
  DB: D1Database;
  ENVIRONMENT: string;
  ALLOW_LOCAL_AUTH: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  LOCAL_AUTH_SECRET: string;
  LOCAL_ACTOR_IDENTITY: string;
}
export type ApiEnvironment = { Bindings: Environment; Variables: { actor: string } };

export type Patch<T> = { [K in keyof T]?: T[K] | undefined };
