import { describe, expect, it } from 'vitest';
import { allowlistMessage, emailAllowed, parseAllowlist } from '../src/lib/allowlist';
import { handler as preSignUp } from '../src/handlers/presignup';

describe('email allowlist', () => {
  it('allows everyone when unset', () => {
    expect(emailAllowed('anyone@anywhere.test', [])).toBe(true);
  });

  it('matches exact domains and *.subdomains, case-insensitively', () => {
    const list = parseAllowlist(' example.org, @Example.com ,*.corp.test ');
    expect(list).toEqual(['example.org', 'example.com', '*.corp.test']);
    expect(emailAllowed('Someone@EXAMPLE.org', list)).toBe(true);
    expect(emailAllowed('a@example.com', list)).toBe(true);
    expect(emailAllowed('a@eu.corp.test', list)).toBe(true);
    expect(emailAllowed('a@corp.test', list)).toBe(false); // wildcard means subdomains only
    expect(emailAllowed('a@evil-example.org', list)).toBe(false);
    expect(emailAllowed('a@example.org.evil.test', list)).toBe(false);
    expect(allowlistMessage(list)).toBe('Only @example.org, @example.com, @….corp.test email addresses can use this WGO instance.');
  });

  it('pre sign-up trigger rejects other domains but lets admin-created users through', async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.org';
    const ev = (email: string, triggerSource = 'PreSignUp_SignUp') => ({ triggerSource, request: { userAttributes: { email } }, response: {} }) as never;
    await expect(preSignUp(ev('me@example.org'))).resolves.toBeTruthy();
    // no full stop: Cognito wraps it as "PreSignUp failed with error <message>." and adds its own
    await expect(preSignUp(ev('me@gmail.com'))).rejects.toThrow(/^Only @example\.org email addresses can use this WGO instance$/);
    await expect(preSignUp(ev('me@gmail.com', 'PreSignUp_AdminCreateUser'))).resolves.toBeTruthy();
    delete process.env.ALLOWED_EMAIL_DOMAINS;
  });
});
