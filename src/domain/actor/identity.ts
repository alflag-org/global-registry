import { z } from 'zod';

export const PRINCIPAL_TYPES = ['human', 'service'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

const MAX_IDENTITY_LENGTH = 256;

export const canonicalActorIdentitySchema = z
  .string()
  .min(1)
  .max(MAX_IDENTITY_LENGTH)
  .superRefine((identity, context) => {
    const separator = identity.indexOf(':');
    const prefix = separator === -1 ? '' : identity.slice(0, separator);
    const subject = separator === -1 ? '' : identity.slice(separator + 1);

    if (prefix !== 'access' && prefix !== 'service') {
      context.addIssue({
        code: 'custom',
        message: 'Identity must use the access: or service: canonical prefix.',
      });
    }
    if (
      subject.length === 0 ||
      subject !== subject.trim() ||
      [...subject].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      })
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Identity subject must be non-empty and contain no control characters.',
      });
    }
  });

export function principalTypeFromIdentity(identity: string): PrincipalType {
  const canonicalIdentity = canonicalActorIdentitySchema.parse(identity);
  return canonicalIdentity.startsWith('service:') ? 'service' : 'human';
}
