/* global supabase */
let _sbClient = null;

async function _getClient() {
  if (_sbClient) return _sbClient;
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Could not load auth config');
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  _sbClient = supabase.createClient(supabaseUrl, supabaseAnonKey);
  return _sbClient;
}

async function requireAuth() {
  try {
    const sb = await _getClient();
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) throw error;
    if (!session) {
      window.location.replace('/signin');
      return null;
    }
    return session;
  } catch (err) {
    console.error('[auth] requireAuth failed:', err);
    window.location.replace('/signin');
    return null;
  }
}

async function getAuthHeaders() {
  try {
    const sb = await _getClient();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return {};
    return { Authorization: 'Bearer ' + session.access_token };
  } catch (_) {
    return {};
  }
}

function renderNavUser(email) {
  const el = document.getElementById('nav-email');
  if (el) el.textContent = email;
}

async function signOut() {
  try {
    const sb = await _getClient();
    await sb.auth.signOut();
  } catch (_) {}
  window.location.replace('/signin');
}
