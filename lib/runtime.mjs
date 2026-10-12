export const roles = ['operator', 'dispatcher', 'worker', 'admin'];

export function runtimeConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
  const remote = production || !['localhost', '127.0.0.1', '::1'].includes(host);
  let origin = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || '';
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('PUBLIC_ORIGIN must be a plain origin');
    if (production && parsed.protocol !== 'https:') throw new Error('Production requires an HTTPS PUBLIC_ORIGIN');
    origin = parsed.origin;
  }
  if (production && !origin) throw new Error('Set PUBLIC_ORIGIN or RENDER_EXTERNAL_URL before production startup');
  const passwords = Object.fromEntries(roles.map(role => [role, env[`${role.toUpperCase()}_PASSWORD`] || (!remote ? env.DEMO_PASSWORD || 'RoadDemo2026!' : '')]));
  if (remote) {
    for (const role of roles) if (passwords[role].length < 16 || passwords[role] === 'RoadDemo2026!') throw new Error(`Set ${role.toUpperCase()}_PASSWORD (at least 16 characters)`);
    if (new Set(Object.values(passwords)).size !== roles.length) throw new Error('Use different passwords for each role');
  }
  const maxVideoMB = Number(env.MAX_VIDEO_MB || (production ? 32 : 140));
  if (!Number.isInteger(maxVideoMB) || maxVideoMB < 1 || maxVideoMB > 140) throw new Error('MAX_VIDEO_MB must be between 1 and 140');
  return { production, remote, host, origin, passwords, maxVideoMB };
}

export function requestOriginAllowed(req, config) {
  if (!req.headers.origin) return true;
  const expected = config.origin || `http://${req.headers.host}`;
  return req.headers.origin === expected;
}
