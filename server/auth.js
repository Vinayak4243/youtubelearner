const { createClient } = require('@supabase/supabase-js');

const getSupabaseConfig = () => ({
  url: (process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/i, ''),
  anonKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || ''
});

const hasSupabaseConfig = () => {
  const { url, anonKey } = getSupabaseConfig();
  return Boolean(url && anonKey);
};

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.match(/^Bearer\s+(.+)$/i)?.[1] || null;
}

function cookieValues(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([name]) => name));
}

function sessionCookies(session, clear = false) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const accessAge = clear ? 0 : Math.max(0, session.expires_in || 3600);
  const refreshAge = clear ? 0 : 60 * 60 * 24 * 30;
  const access = clear ? '' : encodeURIComponent(session.access_token);
  const refresh = clear ? '' : encodeURIComponent(session.refresh_token);
  return [
    `ap_access=${access}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accessAge}${secure}`,
    `ap_refresh=${refresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${refreshAge}${secure}`
  ];
}

function createUserClient(token) {
  const { url, anonKey } = getSupabaseConfig();
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

async function authenticateRequest(req, res, next) {
  if (!hasSupabaseConfig()) return res.status(503).json({ error: 'Authentication is not configured.', code: 'auth_unavailable' });
  const cookies = cookieValues(req);
  let token = bearerToken(req) || cookies.ap_access;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.', code: 'not_authenticated' });

  try {
    let client = createUserClient(token);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      if (!cookies.ap_refresh) return res.status(401).json({ error: 'Your session expired. Sign in again.', code: 'session_expired' });
      const { url, anonKey } = getSupabaseConfig();
      const refreshClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const refreshed = await refreshClient.auth.refreshSession({ refresh_token: cookies.ap_refresh });
      if (refreshed.error || !refreshed.data.session || !refreshed.data.user) {
        res.setHeader('Set-Cookie', sessionCookies(null, true));
        return res.status(401).json({ error: 'Your session expired. Sign in again.', code: 'session_expired' });
      }
      token = refreshed.data.session.access_token;
      res.setHeader('Set-Cookie', sessionCookies(refreshed.data.session));
      client = createUserClient(token);
      req.user = refreshed.data.user;
    } else {
      req.user = data.user;
    }
    req.userSupabase = client;
    req.authToken = token;
    next();
  } catch (error) {
    console.error('Authentication provider unavailable:', error.status || error.code || 'request_failed');
    return res.status(503).json({ error: 'Authentication service is temporarily unavailable.', code: 'auth_unavailable' });
  }
}

module.exports = { getSupabaseConfig, hasSupabaseConfig, authenticateRequest, sessionCookies, cookieValues, createUserClient };
