export class GlobalRegistryError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class AuthorizationError extends GlobalRegistryError {
  constructor(code: 'access_required' | 'cross_site_mutation' | 'forbidden', message: string) {
    super(code === 'access_required' ? 401 : 403, code, message);
  }
}
export const invalid = (message: string) =>
  new GlobalRegistryError(400, 'validation_error', message);
export const conflict = (message: string) => new GlobalRegistryError(409, 'conflict', message);
export const missing = () =>
  new GlobalRegistryError(404, 'not_found', 'The requested entity does not exist.');
export function databaseError(error: unknown): never {
  const message = String(error);
  if (/UNIQUE constraint|FOREIGN KEY constraint|relationship:/.test(message))
    throw conflict('A unique value or relationship conflicts with existing data.');
  if (/CHECK constraint|validation:/.test(message))
    throw invalid('The mutation violates a data constraint.');
  throw error;
}
