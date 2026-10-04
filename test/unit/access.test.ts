import { it, expect } from 'vitest';
import { authenticateAccessPrincipal } from '../../src/auth/access';

const humanIdentity = { user_uuid: '00000000-0000-4000-8000-000000000001' };
const access = (identity: unknown): CloudflareAccessContext => ({
  aud: 'test',
  getIdentity: async () => identity as CloudflareAccessIdentity | undefined,
});

it('rejects missing runtime Access', async () => {
  await expect(authenticateAccessPrincipal(undefined)).rejects.toMatchObject({
    status: 403,
    code: 'access_required',
  });
});

it('uses stable human UUIDs regardless of email', async () => {
  for (const email of ['before@example.invalid', 'after@example.invalid']) {
    expect(await authenticateAccessPrincipal(access({ ...humanIdentity, email }))).toEqual({
      identity: 'access:' + humanIdentity.user_uuid,
      type: 'human',
    });
  }
});

it('gives service identity precedence over human identity', async () => {
  expect(
    await authenticateAccessPrincipal(
      access({ ...humanIdentity, service_token_status: true, service_token_id: 'machine-id' }),
    ),
  ).toEqual({ identity: 'service:machine-id', type: 'service' });
});

it.each([
  undefined,
  null,
  {},
  { email: 'only@example.invalid' },
  { user_uuid: '' },
  { user_uuid: ' padded ' },
  { user_uuid: 'bad\nvalue' },
  { user_uuid: 'bad\u007fvalue' },
  { user_uuid: 42 },
  { user_uuid: 'x'.repeat(256) },
  { ...humanIdentity, service_token_status: 'true' },
  { ...humanIdentity, service_token_status: true },
  { service_token_status: true, service_token_id: '' },
  { service_token_status: true, service_token_id: 42 },
  { service_token_status: true, service_token_id: 'x'.repeat(249) },
])('rejects malformed identity %j', async (identity) => {
  await expect(authenticateAccessPrincipal(access(identity))).rejects.toMatchObject({
    status: 403,
    code: 'access_required',
  });
});

it('accepts an actor at the identity length limit', async () => {
  const subject = 'x'.repeat(248);
  expect(
    await authenticateAccessPrincipal(
      access({ service_token_status: true, service_token_id: subject }),
    ),
  ).toEqual({ identity: 'service:' + subject, type: 'service' });
});

it('rejects identity lookup failures', async () => {
  await expect(
    authenticateAccessPrincipal({
      aud: 'test',
      getIdentity: async () => {
        throw new Error('unavailable');
      },
    }),
  ).rejects.toMatchObject({ status: 403, code: 'access_required' });
});
