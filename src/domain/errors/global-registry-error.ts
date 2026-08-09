import type { JsonObject } from '../models/global-registry';

export class GlobalRegistryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: JsonObject | undefined;

  constructor(status: number, code: string, message: string, details?: JsonObject) {
    super(message);
    this.name = 'GlobalRegistryError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends GlobalRegistryError {
  constructor(code: string, message: string, details?: JsonObject) {
    super(422, code, message, details);
    this.name = 'ValidationError';
  }
}

export class RequestError extends GlobalRegistryError {
  constructor(code: string, message: string, details?: JsonObject, status = 400) {
    super(status, code, message, details);
    this.name = 'RequestError';
  }
}

export class PayloadTooLargeError extends RequestError {
  constructor(message = 'The request body is too large.') {
    super('request_too_large', message, undefined, 413);
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsupportedMediaTypeError extends RequestError {
  constructor(message = 'JSON request bodies must use application/json.') {
    super('unsupported_media_type', message, undefined, 415);
    this.name = 'UnsupportedMediaTypeError';
  }
}

export class ConflictError extends GlobalRegistryError {
  constructor(code: string, message: string, details?: JsonObject) {
    super(409, code, message, details);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends GlobalRegistryError {
  constructor(entity: string, key: string) {
    super(404, 'not_found', `${entity} not found.`, { entity, key });
    this.name = 'NotFoundError';
  }
}

export class AuthorizationError extends GlobalRegistryError {
  constructor(
    code:
      | 'access_required'
      | 'actor_inactive'
      | 'actor_not_registered'
      | 'cross_site_mutation'
      | 'forbidden',
    message: string,
  ) {
    super(code === 'access_required' ? 401 : 403, code, message);
    this.name = 'AuthorizationError';
  }
}
