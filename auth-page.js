// The account-email landing pages (reset-password.html, confirm-email.html):
// reads the link once, carries it out, shows one outcome, and offers the
// password form only for a password reset. The decisions are in
// auth-link.js; this file only touches the page.
import {
  OUTCOMES,
  classifyAuthLink,
  needsSessionFromUrl,
  resolveAuthLink,
  updatePassword,
} from './auth-link.js';

const SUPABASE_URL = 'https://fxbtbgwbniidtalnoaad.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4YnRiZ3dibmlpZHRhbG5vYWFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMjc2NzksImV4cCI6MjA4NzcwMzY3OX0.qL7cfIvdR-CGmPzpyDeVNUN_BUZFhNsiRlHzD-FpeSE';

const el = (id) => document.getElementById(id);

// Read the link before supabase-js or anything else changes the URL.
const link = classifyAuthLink(window.location.search, window.location.hash);

// The CDN bundle declares `window.supabase`, so the client is `client`.
// No session is written to the browser's storage, and only Android's older
// recovery link lets supabase-js read a session from the URL.
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    detectSessionInUrl: needsSessionFromUrl(link),
    persistSession: false,
    autoRefreshToken: false,
  },
});

function show(key) {
  const outcome = OUTCOMES[key] || OUTCOMES.failed;
  el('loading').hidden = true;
  el('title').textContent = outcome.title;
  el('title').hidden = false;
  document.title = `Tally - ${outcome.title}`;
  const text = el('text');
  text.textContent = outcome.text;
  text.hidden = !outcome.text;
  text.className = outcome.isError ? 'text error' : 'text';
  el('form').hidden = !outcome.showForm;
  if (outcome.showForm) el('password').focus();
  else el('title').focus();
}

function showFormError(message) {
  const line = el('form-error');
  line.textContent = message;
  line.hidden = false;
}

el('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el('submit');
  el('form-error').hidden = true;
  button.disabled = true;
  button.textContent = 'Updating...';
  const result = await updatePassword(client, el('password').value, el('confirm').value)
    .catch(() => ({ ok: false, message: 'Couldn\'t update your password. Try again.' }));
  if (result.ok) {
    show('updated');
    return;
  }
  showFormError(result.message);
  button.disabled = false;
  button.textContent = 'Update password';
});

const outcome = await resolveAuthLink(link, client).catch(() => 'failed');
// The link's token is spent or useless now: keep it out of the address bar
// and the browser history.
window.history.replaceState(null, '', window.location.pathname);
show(outcome);
