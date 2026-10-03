import { createExecutionContext } from 'cloudflare:test';

export const humanIdentity = {
  user_uuid: '00000000-0000-4000-8000-000000000001',
  email: 'developer@example.invalid',
  service_token_status: false,
};

export function fakeAccessContext(identity: CloudflareAccessIdentity | null = humanIdentity) {
  return Object.assign(createExecutionContext(), {
    access: { aud: 'global-registry-test', getIdentity: async () => identity },
  });
}
