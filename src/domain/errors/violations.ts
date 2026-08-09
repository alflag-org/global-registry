import type { z } from 'zod';
import type { JsonObject } from '../models/global-registry';

export interface DomainViolation {
  code: string;
  path: string;
  message: string;
}

export function zodViolations(error: z.ZodError): DomainViolation[] {
  return error.issues.map((issue) => ({
    code: zodIssueCode(issue.code),
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export function violationsDetails(violations: DomainViolation[]): JsonObject {
  return {
    violations: violations.map((violation) => ({
      code: violation.code,
      path: violation.path,
      message: violation.message,
    })),
  };
}

function zodIssueCode(code: string): string {
  switch (code) {
    case 'invalid_type':
      return 'invalid_type';
    case 'invalid_value':
      return 'invalid_value';
    case 'too_small':
      return 'value_too_small';
    case 'too_big':
      return 'value_too_large';
    case 'unrecognized_keys':
      return 'unknown_field';
    default:
      return 'invalid_value';
  }
}
