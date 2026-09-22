import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { app } from '../src/api/app';
import type { Row } from '../src/db/types';
export async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request(`http://localhost${path.startsWith('/') ? path : '/api/v1/' + path}`, {
      method,
      headers: {
        host: 'localhost',
        'x-global-registry-dev-secret': env.LOCAL_AUTH_SECRET,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}
export async function create(path: string, body: unknown): Promise<Row> {
  const response = await api(path, 'POST', body);
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(201);
  return data as Row;
}
export async function get(path: string): Promise<Row> {
  const response = await api(path);
  expect(response.status).toBe(200);
  return response.json() as Promise<Row>;
}
export const location = () =>
  create('locations', { name: 'Test location', slug: 'test-' + crypto.randomUUID() });
export async function network(cidr: string) {
  const l = await location();
  return create('prefixes', { location_id: l.id, cidr });
}
