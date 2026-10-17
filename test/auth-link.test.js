// node --test test/  (npm test): the account-email landing pages' logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOMES,
  classifyAuthLink,
  needsSessionFromUrl,
  passwordProblem,
  resolveAuthLink,
  updatePassword,
} from '../auth-link.js';

// A Supabase client that records each auth call and answers from `replies`.
function fakeClient(replies = {}) {
  const calls = [];
  const answer = (name, args) => {
    calls.push([name, args]);
    return Promise.resolve(replies[name] ?? { data: {}, error: null });
  };
  return {
    calls,
    names: () => calls.map(([name]) => name),
    auth: {
      verifyOtp: (args) => answer('verifyOtp', args),
      getSession: () => answer('getSession'),
      signOut: (args) => answer('signOut', args),
      updateUser: (args) => answer('updateUser', args),
    },
  };
}

const expiredError = { name: 'AuthApiError', status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' };
const networkError = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };
const serverError = { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'secret server text' };

// --- classifyAuthLink ------------------------------------------------------

const cases = [
  ['template reset link', '?token_hash=abc&type=recovery', '', { kind: 'recovery', tokenHash: 'abc' }],
  ['template confirm link', '?token_hash=abc&type=email', '', { kind: 'confirm', tokenHash: 'abc', otpType: 'email' }],
  ['template confirm link, older type', '?token_hash=abc&type=signup', '', { kind: 'confirm', tokenHash: 'abc', otpType: 'signup' }],
  ['email change link', '?token_hash=abc&type=email_change', '', { kind: 'confirm', tokenHash: 'abc', otpType: 'email_change' }],
  ['token type Tally never sends', '?token_hash=abc&type=magiclink', '', { kind: 'none' }],
  ['token with no type', '?token_hash=abc', '', { kind: 'none' }],
  ['Android reset link', '', '#access_token=a&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery', { kind: 'recovery', sessionInUrl: true }],
  ['Android sign-up confirmation (tester BK)', '', '#access_token=a&refresh_token=r&type=signup', { kind: 'confirmed' }],
  ['Android email confirmation', '', '#access_token=a&type=email', { kind: 'confirmed' }],
  ['session link of another type', '', '#access_token=a&type=magiclink', { kind: 'none' }],
  ['iPhone PKCE link', '?code=0b3e4f', '', { kind: 'code' }],
  ['expired link in the hash', '', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { kind: 'error', code: 'otp_expired' }],
  ['error in the query', '?error=server_error&error_description=Oops', '', { kind: 'error', code: 'server_error' }],
  ['error beats a token', '?token_hash=abc&type=recovery&error_code=otp_expired', '', { kind: 'error', code: 'otp_expired' }],
  ['opened with no link', '', '', { kind: 'none' }],
  ['no leading ? or #', 'token_hash=abc&type=recovery', '', { kind: 'recovery', tokenHash: 'abc' }],
];

for (const [name, search, hash, expected] of cases) {
  test(`classify: ${name}`, () => {
    assert.deepEqual(classifyAuthLink(search, hash), expected);
  });
}

test('only the Android reset link lets supabase-js read a session from the URL', () => {
  for (const [, search, hash] of cases) {
    const link = classifyAuthLink(search, hash);
    assert.equal(needsSessionFromUrl(link), link.kind === 'recovery' && link.sessionInUrl === true);
  }
  assert.equal(needsSessionFromUrl({ kind: 'recovery', sessionInUrl: true }), true);
  assert.equal(needsSessionFromUrl({ kind: 'recovery', tokenHash: 'abc' }), false);
  assert.equal(needsSessionFromUrl({ kind: 'confirmed' }), false);
});

// --- resolveAuthLink ---------------------------------------------------------

test('a reset link verifies its token and shows the form', async () => {
  const client = fakeClient();
  assert.equal(await resolveAuthLink({ kind: 'recovery', tokenHash: 'abc' }, client), 'form');
  assert.deepEqual(client.calls, [['verifyOtp', { token_hash: 'abc', type: 'recovery' }]]);
});

test('an expired reset link says how to get a new one', async () => {
  const client = fakeClient({ verifyOtp: { data: {}, error: expiredError } });
  assert.equal(await resolveAuthLink({ kind: 'recovery', tokenHash: 'abc' }, client), 'recoveryExpired');
  assert.match(OUTCOMES.recoveryExpired.text, /Forgot password\?/);
});

test('a reset link with no connection says so, not "expired"', async () => {
  const client = fakeClient({ verifyOtp: { data: {}, error: networkError } });
  assert.equal(await resolveAuthLink({ kind: 'recovery', tokenHash: 'abc' }, client), 'offline');
});

test('a reset link the server fails on is "failed"', async () => {
  const client = fakeClient({ verifyOtp: { data: {}, error: serverError } });
  assert.equal(await resolveAuthLink({ kind: 'recovery', tokenHash: 'abc' }, client), 'failed');
});

test('the Android reset link shows the form once supabase-js has its session', async () => {
  const withSession = fakeClient({ getSession: { data: { session: { access_token: 'a' } }, error: null } });
  assert.equal(await resolveAuthLink({ kind: 'recovery', sessionInUrl: true }, withSession), 'form');
  const without = fakeClient({ getSession: { data: { session: null }, error: null } });
  assert.equal(await resolveAuthLink({ kind: 'recovery', sessionInUrl: true }, without), 'recoveryExpired');
});

test('a confirm link verifies its token, then ends the browser session', async () => {
  const client = fakeClient();
  assert.equal(await resolveAuthLink({ kind: 'confirm', tokenHash: 'abc', otpType: 'email' }, client), 'confirmed');
  assert.deepEqual(client.calls, [
    ['verifyOtp', { token_hash: 'abc', type: 'email' }],
    ['signOut', { scope: 'local' }],
  ]);
});

test('an expired confirm link keeps no session and says to sign in', async () => {
  const client = fakeClient({ verifyOtp: { data: {}, error: expiredError } });
  assert.equal(await resolveAuthLink({ kind: 'confirm', tokenHash: 'abc', otpType: 'email' }, client), 'confirmExpired');
  assert.deepEqual(client.names(), ['verifyOtp']);
});

test('an Android sign-up confirmation says "Email confirmed" and asks for no password (tester BK)', async () => {
  const client = fakeClient();
  const link = classifyAuthLink('', '#access_token=a&refresh_token=r&type=signup');
  const outcome = await resolveAuthLink(link, client);
  assert.equal(outcome, 'confirmed');
  assert.equal(OUTCOMES[outcome].showForm, undefined);
  assert.equal(OUTCOMES[outcome].title, 'Email confirmed');
  assert.deepEqual(client.calls, []);
});

test('an iPhone PKCE link explains itself and calls nothing', async () => {
  const client = fakeClient();
  assert.equal(await resolveAuthLink({ kind: 'code' }, client), 'code');
  assert.deepEqual(client.calls, []);
});

test('error links: expired or denied read as expired, anything else as failed', async () => {
  const client = fakeClient();
  assert.equal(await resolveAuthLink({ kind: 'error', code: 'otp_expired' }, client), 'linkExpired');
  assert.equal(await resolveAuthLink({ kind: 'error', code: 'access_denied' }, client), 'linkExpired');
  assert.equal(await resolveAuthLink({ kind: 'error', code: 'server_error' }, client), 'failed');
  assert.equal(await resolveAuthLink({ kind: 'none' }, client), 'none');
  assert.deepEqual(client.calls, []);
});

test('only a password reset link ever shows the password form', async () => {
  for (const [name, search, hash] of cases) {
    const link = classifyAuthLink(search, hash);
    const outcome = await resolveAuthLink(link, fakeClient({ getSession: { data: { session: { access_token: 'a' } }, error: null } }));
    assert.ok(OUTCOMES[outcome], `${name}: ${outcome} has no outcome`);
    assert.equal(OUTCOMES[outcome].showForm === true, link.kind === 'recovery', name);
  }
});

test('outcome copy follows the house style: no em dashes, nothing empty but the form', () => {
  for (const [key, outcome] of Object.entries(OUTCOMES)) {
    assert.ok(outcome.title, key);
    assert.ok(!`${outcome.title}${outcome.text}`.includes('\u2014'), key);
    if (!outcome.showForm) assert.ok(outcome.text, key);
  }
});

// --- the password form -------------------------------------------------------

test('passwordProblem: length first, then the match', () => {
  assert.equal(passwordProblem('12345', '12345'), 'Password must be at least 6 characters.');
  assert.equal(passwordProblem('123456', '123457'), 'The passwords don\'t match.');
  assert.equal(passwordProblem('123456', '123456'), null);
});

test('updatePassword sends nothing while the form is wrong', async () => {
  const client = fakeClient();
  assert.deepEqual(await updatePassword(client, 'short', 'short'), { ok: false, message: 'Password must be at least 6 characters.' });
  assert.deepEqual(client.calls, []);
});

test('updatePassword sets the password, then ends the browser session', async () => {
  const client = fakeClient();
  assert.deepEqual(await updatePassword(client, 'new-secret', 'new-secret'), { ok: true });
  assert.deepEqual(client.calls, [
    ['updateUser', { password: 'new-secret' }],
    ['signOut', { scope: 'local' }],
  ]);
});

test('updatePassword failures say what to do, never the server\'s own text', async () => {
  const reply = (error) => fakeClient({ updateUser: { data: {}, error } });
  assert.equal((await updatePassword(reply({ status: 422, code: 'same_password' }), 'abcdef', 'abcdef')).message,
    'Choose a password you haven\'t used before.');
  assert.equal((await updatePassword(reply({ status: 422, code: 'weak_password' }), 'abcdef', 'abcdef')).message,
    'Password is too weak. Use at least 6 characters.');
  assert.equal((await updatePassword(reply(networkError), 'abcdef', 'abcdef')).message,
    'Couldn\'t reach Tally. Check your connection and try again.');
  const generic = await updatePassword(reply(serverError), 'abcdef', 'abcdef');
  assert.equal(generic.message, 'Couldn\'t update your password. Try again.');
  assert.ok(!generic.message.includes('secret server text'));
});
