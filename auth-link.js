// What a Tally account email link asks this site to do, and the words the
// page shows for each outcome. Used by reset-password.html and
// confirm-email.html through auth-page.js; no DOM here, so `npm test`
// (node --test test/) covers every case.
//
// The links arrive in four shapes:
// - `?token_hash=...&type=recovery|email|signup|email_change`: the email
//   templates' own links (Supabase's documented PKCE / cross-device shape).
//   The page verifies the token itself with `verifyOtp`.
// - `#access_token=...&type=recovery|signup|...`: Supabase's default link
//   from an app using the implicit flow (Android, supabase-kt). Supabase
//   has already verified it before redirecting here.
// - `?code=...`: Supabase's default link from an app using PKCE (iOS,
//   supabase-swift). Only the phone that asked holds the code verifier, so
//   a browser can't finish it (tally-native TALLY-MEDIUM-79).
// - `error`, `error_code`, `error_description` in the query or the hash:
//   Supabase turned the link down (expired, already used).

const CONFIRM_TYPES = new Set(['email', 'signup', 'email_change']);

const RECOVERY_EXPIRED =
  'This link has expired or has already been used. To get a new one, open Tally, ' +
  'go to Sign in and tap "Forgot password?".';
const CONFIRM_EXPIRED =
  'This link has expired or has already been used. If you have already confirmed your ' +
  'email, open Tally and sign in.';

export const MIN_PASSWORD_LENGTH = 6;

// Each outcome the page can end on: its heading, its text, whether the
// password form shows, and whether the text is an error.
export const OUTCOMES = {
  form: {
    title: 'Choose a new password',
    text: '',
    showForm: true,
  },
  updated: {
    title: 'Password updated',
    text: 'Open Tally and sign in with your new password.',
  },
  confirmed: {
    title: 'Email confirmed',
    text: 'Your Tally account is ready. Open Tally and sign in with your email and password.',
  },
  recoveryExpired: { title: 'Link expired', text: RECOVERY_EXPIRED, isError: true },
  confirmExpired: { title: 'Link expired', text: CONFIRM_EXPIRED, isError: true },
  linkExpired: {
    title: 'Link expired',
    text:
      'This link has expired or has already been used. If you were confirming your email ' +
      'and have done it before, open Tally and sign in. If you were resetting your password, ' +
      'open Tally, go to Sign in and tap "Forgot password?" for a new link.',
    isError: true,
  },
  code: {
    title: 'Open Tally',
    text:
      'If you were confirming your email, you are all set: open Tally and sign in. ' +
      'If you were resetting your password, this link can\'t be finished in a browser. ' +
      'To get a new one, open Tally, go to Sign in and tap "Forgot password?".',
  },
  none: {
    title: 'Open the link in your email',
    text: 'This page opens from the links in emails from Tally. Open the latest email from Tally and tap its link.',
  },
  offline: {
    title: 'No connection',
    text: 'Couldn\'t reach Tally. Check your connection, then open the link again.',
    isError: true,
  },
  failed: {
    title: 'Something went wrong',
    text: 'This link didn\'t work. Open the latest email from Tally and tap its link again.',
    isError: true,
  },
};

/**
 * The link the page was opened with, from `location.search` and
 * `location.hash`. Read before anything else touches the URL.
 */
export function classifyAuthLink(search, hash) {
  const query = new URLSearchParams((search || '').replace(/^\?/, ''));
  const fragment = new URLSearchParams((hash || '').replace(/^#/, ''));
  const param = (name) => query.get(name) ?? fragment.get(name);

  if (param('error') || param('error_code') || param('error_description')) {
    return { kind: 'error', code: param('error_code') || param('error') || 'unknown' };
  }

  const tokenHash = query.get('token_hash');
  if (tokenHash) {
    const type = query.get('type');
    if (type === 'recovery') return { kind: 'recovery', tokenHash };
    if (CONFIRM_TYPES.has(type)) return { kind: 'confirm', tokenHash, otpType: type };
    return { kind: 'none' };
  }

  if (fragment.get('access_token')) {
    const type = fragment.get('type');
    if (type === 'recovery') return { kind: 'recovery', sessionInUrl: true };
    // Supabase confirmed the email before redirecting: nothing left to do.
    if (CONFIRM_TYPES.has(type)) return { kind: 'confirmed' };
    return { kind: 'none' };
  }

  if (query.get('code')) return { kind: 'code' };
  return { kind: 'none' };
}

/**
 * Whether supabase-js may read the session from the URL. Only Android's
 * older recovery link carries one the page needs; every other link is
 * verified by hand or needs no session, so none is stored in the browser.
 */
export function needsSessionFromUrl(link) {
  return link.kind === 'recovery' && link.sessionInUrl === true;
}

/** True when a supabase-js error is a failed request rather than an answer. */
export function isNetworkError(error) {
  if (!error) return false;
  return error.name === 'AuthRetryableFetchError' || error.status === 0 || error instanceof TypeError;
}

function verifyFailure(error, expired) {
  if (isNetworkError(error)) return 'offline';
  return error.code === 'otp_expired' || error.status === 403 ? expired : 'failed';
}

/**
 * Carries out the link with the Supabase `client` and returns the key of
 * the outcome to show (see OUTCOMES). A confirmation ends the browser's
 * session straight away: the account is used from the app, not here.
 */
export async function resolveAuthLink(link, client) {
  switch (link.kind) {
    case 'recovery': {
      if (link.tokenHash) {
        const { error } = await client.auth.verifyOtp({ token_hash: link.tokenHash, type: 'recovery' });
        return error ? verifyFailure(error, 'recoveryExpired') : 'form';
      }
      const { data, error } = await client.auth.getSession();
      if (error) return verifyFailure(error, 'recoveryExpired');
      return data && data.session ? 'form' : 'recoveryExpired';
    }
    case 'confirm': {
      const { error } = await client.auth.verifyOtp({ token_hash: link.tokenHash, type: link.otpType });
      if (error) return verifyFailure(error, 'confirmExpired');
      await client.auth.signOut({ scope: 'local' });
      return 'confirmed';
    }
    case 'confirmed':
      return 'confirmed';
    case 'error':
      return link.code === 'otp_expired' || link.code === 'access_denied' ? 'linkExpired' : 'failed';
    case 'code':
      return 'code';
    default:
      return 'none';
  }
}

/** The form's own check before anything is sent: an error line, or null. */
export function passwordProblem(password, confirm) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) return 'The passwords don\'t match.';
  return null;
}

/**
 * Sets the new password, then ends the browser's session. Returns
 * `{ ok: true }` or `{ ok: false, message }`, never the server's own text.
 */
export async function updatePassword(client, password, confirm) {
  const problem = passwordProblem(password, confirm);
  if (problem) return { ok: false, message: problem };
  const { error } = await client.auth.updateUser({ password });
  if (error) {
    if (isNetworkError(error)) {
      return { ok: false, message: 'Couldn\'t reach Tally. Check your connection and try again.' };
    }
    if (error.code === 'same_password') {
      return { ok: false, message: 'Choose a password you haven\'t used before.' };
    }
    if (error.code === 'weak_password') {
      return { ok: false, message: 'Password is too weak. Use at least 6 characters.' };
    }
    return { ok: false, message: 'Couldn\'t update your password. Try again.' };
  }
  await client.auth.signOut({ scope: 'local' });
  return { ok: true };
}
