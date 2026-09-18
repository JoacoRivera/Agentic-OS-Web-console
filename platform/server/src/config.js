import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const LOCAL_HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.localhost)?$/;

function normalizeHostname(hostname) {
  if (typeof hostname !== 'string') return null;
  return hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
}

/** True if `hostname` (no port, no brackets) is a loopback name. */
export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

/**
 * True when a request hostname is a literal loopback name or the one explicit
 * local alias configured by the operator.
 */
export function isAllowedLocalHostname(hostname, localHostname = null) {
  const normalized = normalizeHostname(hostname);
  return (
    LOOPBACK_HOSTNAMES.has(normalized) ||
    (localHostname !== null && normalized === localHostname)
  );
}

function localHostnameFromEnv(value) {
  if (value === undefined || value === '') return null;
  const hostname = normalizeHostname(value);
  if (!LOCAL_HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      'Invalid LOCAL_HOSTNAME: use one single-label hostname containing only letters, ' +
        'numbers, and interior hyphens, optionally followed by .localhost ' +
        '(for example, agentic-os-console.localhost).'
    );
  }
  return hostname;
}

const PROXY_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROXY_SECRET_MIN_LENGTH = 32;

/**
 * ADR-0005 amendment (2026-09-17): one authenticated reverse-proxy hostname.
 * Both halves are required together; either alone is invalid configuration.
 */
function proxyFromEnv(env) {
  const hasHostname = env.PROXY_HOSTNAME !== undefined && env.PROXY_HOSTNAME !== '';
  const hasSecret = env.PROXY_SECRET !== undefined && env.PROXY_SECRET !== '';
  if (!hasHostname && !hasSecret) return { hostname: null, secret: null };
  if (!hasHostname || !hasSecret) {
    throw new Error('Invalid proxy configuration: PROXY_HOSTNAME and PROXY_SECRET must be set together.');
  }
  const hostname = normalizeHostname(env.PROXY_HOSTNAME);
  if (!PROXY_HOSTNAME_PATTERN.test(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(
      'Invalid PROXY_HOSTNAME: use one exact multi-label DNS name (for example, aos-console.home.arpa).'
    );
  }
  if (env.PROXY_SECRET.length < PROXY_SECRET_MIN_LENGTH) {
    throw new Error(`Invalid PROXY_SECRET: use at least ${PROXY_SECRET_MIN_LENGTH} characters.`);
  }
  return { hostname, secret: env.PROXY_SECRET };
}

const expandHome = (value, env) => path.resolve(value.replace(/^~(?=\/|$)/, env.HOME ?? '~'));

const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/**
 * ADR-0010: the Family Health record is a second, optional repo root with no
 * default. It must never sit inside the memory repo (the 2026-07-23 raw
 * snapshot is evidence, not a data source) nor contain it.
 */
function healthRootFromEnv(env, repoRoot) {
  if (env.HEALTH_REPO_ROOT === undefined || env.HEALTH_REPO_ROOT === '') return null;
  const root = expandHome(env.HEALTH_REPO_ROOT, env);
  if (isInside(root, repoRoot) || isInside(repoRoot, root)) {
    throw new Error(
      'Invalid HEALTH_REPO_ROOT (ADR-0010): the Family Health record must be a separate ' +
        'clone, not a path inside the memory repo (or one containing it).'
    );
  }
  return root;
}

/**
 * ADR-0011: Firefly III is an optional external source. URL and token are set
 * together or not at all. The token must never cross a network in cleartext,
 * so a plain-http URL is accepted only for a loopback host; anything else
 * must be https. On this host the right value is http://127.0.0.1:8081 — the
 * public name (finances.home.arpa) would route out to Caddy and back.
 */
function fireflyFromEnv(env) {
  const hasUrl = env.FIREFLY_URL !== undefined && env.FIREFLY_URL !== '';
  const hasToken = env.FIREFLY_TOKEN !== undefined && env.FIREFLY_TOKEN !== '';
  // Validated even when the section is off, so a typo in the link base is
  // reported at startup instead of silently producing no links later.
  const publicUrl = publicUrlFromEnv(env);
  if (!hasUrl && !hasToken) return { url: null, token: null, publicUrl };
  if (!hasUrl || !hasToken) {
    throw new Error('Invalid Firefly configuration (ADR-0011): FIREFLY_URL and FIREFLY_TOKEN must be set together.');
  }
  let parsed;
  try {
    parsed = new URL(env.FIREFLY_URL);
  } catch {
    throw new Error('Invalid FIREFLY_URL: not a URL (for example, http://127.0.0.1:8081).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid FIREFLY_URL: use http:// or https://.');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Invalid FIREFLY_URL (ADR-0011): plain http is allowed only for a loopback host, so the ' +
        'access token never crosses a network in cleartext. Use https:// for a remote Firefly.'
    );
  }
  // Normalize to an origin + optional base path, without a trailing slash.
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  return { url: base, token: env.FIREFLY_TOKEN, publicUrl };
}

/**
 * The browser-facing Firefly address used only to build "open in Firefly"
 * links — deliberately distinct from FIREFLY_URL. The server reaches Firefly
 * over loopback, which a browser on another device cannot use, so the link
 * target is separate config. It is safe to expose (it is the name the owner
 * already types) and carries no credential; unset simply means no links.
 */
function publicUrlFromEnv(env) {
  if (env.FIREFLY_PUBLIC_URL === undefined || env.FIREFLY_PUBLIC_URL === '') return null;
  let parsed;
  try {
    parsed = new URL(env.FIREFLY_PUBLIC_URL);
  } catch {
    throw new Error('Invalid FIREFLY_PUBLIC_URL: not a URL (for example, http://finances.home.arpa).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid FIREFLY_PUBLIC_URL: use http:// or https://.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Invalid FIREFLY_PUBLIC_URL: it is sent to the browser and must carry no credentials.');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Build the runtime config from an env object. All tunables live here
 * (single source); nothing else reads process.env.
 */
export function createConfig(env = process.env) {
  const proxy = proxyFromEnv(env);
  const firefly = fireflyFromEnv(env);
  const financeAllowProxy = env.FINANCE_ALLOW_PROXY === 'true';
  if (financeAllowProxy && (firefly.url === null || proxy.hostname === null)) {
    throw new Error(
      'Invalid FINANCE_ALLOW_PROXY (ADR-0011): it requires both the FIREFLY_URL/FIREFLY_TOKEN pair ' +
        'and a configured PROXY_HOSTNAME/PROXY_SECRET pair; on its own it is dead configuration.'
    );
  }
  const repoRoot = env.REPO_ROOT ? expandHome(env.REPO_ROOT, env) : path.resolve(__dirname, '../../..');
  const healthRoot = healthRootFromEnv(env, repoRoot);
  const familyHealthAllowProxy = env.FAMILY_HEALTH_ALLOW_PROXY === 'true';
  if (familyHealthAllowProxy && (healthRoot === null || proxy.hostname === null)) {
    throw new Error(
      'Invalid FAMILY_HEALTH_ALLOW_PROXY (ADR-0010): it requires both HEALTH_REPO_ROOT and a ' +
        'configured PROXY_HOSTNAME/PROXY_SECRET pair; on its own it is dead configuration.'
    );
  }
  return {
    PORT: Number(env.PORT ?? 3001),
    HOST: env.HOST ?? '127.0.0.1',
    // Optional, explicit browser alias. Use a .localhost name for automatic
    // loopback resolution, or map a single-label name in the OS hosts file.
    LOCAL_HOSTNAME: localHostnameFromEnv(env.LOCAL_HOSTNAME),
    // Optional authenticated reverse proxy (ADR-0005 amendment): requests
    // with Host === PROXY_HOSTNAME must carry PROXY_SECRET_HEADER. The bind
    // stays loopback; the proxy (Caddy) owns user auth and injects the secret.
    PROXY_HOSTNAME: proxy.hostname,
    PROXY_SECRET: proxy.secret,
    // Default assumes platform/ lives inside the Agentic OS repo
    // (repo root = ../../.. from server/src). Overridable for dev/tests.
    REPO_ROOT: repoRoot,
    // ADR-0010: optional live Family Health record (separate private clone).
    // null = section absent. Never inside REPO_ROOT. Loopback-only unless the
    // owner sets FAMILY_HEALTH_ALLOW_PROXY together with the proxy pair.
    HEALTH_REPO_ROOT: healthRoot,
    FAMILY_HEALTH_ALLOW_PROXY: familyHealthAllowProxy,
    // ADR-0011: optional Firefly III source. null = section absent. The token
    // stays server-side and is never reported by /api/status. Loopback-only
    // unless the owner sets FINANCE_ALLOW_PROXY with the proxy pair.
    FIREFLY_URL: firefly.url,
    FIREFLY_TOKEN: firefly.token,
    // Link target for the browser only — never used to make an API call.
    FIREFLY_PUBLIC_URL: firefly.publicUrl,
    FINANCE_ALLOW_PROXY: financeAllowProxy,
    // Upstream call budget and how long a good response stays reusable.
    FIREFLY_TIMEOUT_MS: Number(env.FIREFLY_TIMEOUT_MS ?? 8000),
    FINANCE_CACHE_MS: Number(env.FINANCE_CACHE_MS ?? 60000),
    // Distinct months of transaction history a trend indicator needs before
    // it reports a value instead of what it is waiting for (ADR-0011).
    FINANCE_MIN_TREND_MONTHS: Number(env.FINANCE_MIN_TREND_MONTHS ?? 3),
    // Audit sink (gitignored): P3 execution appends here; P1 only tails it.
    AUDIT_LOG_PATH: env.AUDIT_LOG_PATH
      ? path.resolve(env.AUDIT_LOG_PATH)
      : path.resolve(__dirname, '../../logs/operations.log'),
    // Size-based rollover: when the live log reaches ROTATE_BYTES it becomes
    // .1 (older files shift up, the oldest beyond ROTATE_KEEP is dropped).
    // Rotation renames whole files only — appended lines are never rewritten.
    AUDIT_ROTATE_BYTES: Number(env.AUDIT_ROTATE_BYTES ?? 1_000_000),
    AUDIT_ROTATE_KEEP: Number(env.AUDIT_ROTATE_KEEP ?? 3),
    // Gates raw *content* over HTTP only; raw metrics are always computed (ADR-0005).
    EXPOSE_RAW_CONTENT: env.EXPOSE_RAW_CONTENT === 'true',
    // No auth layer exists in Phase 1; this stays false until one is designed.
    AUTH_CONFIGURED: false,
    LINT_STALE_DAYS: 7,
    WORKFLOW_STALE_DAYS: 90,
    RECENT_ACTIVITY_LIMIT: 6,
    DRAFT_LIMIT: 6,
    REFRESH_MS: 30000,
  };
}

/**
 * ADR-0005: a non-loopback HOST without configured auth is invalid
 * configuration — the server must refuse to start, not warn.
 */
export function assertStartable(config) {
  if (!isLoopbackHostname(config.HOST) && !config.AUTH_CONFIGURED) {
    throw new Error(
      `Invalid configuration (ADR-0005): HOST=${config.HOST} is not loopback and no auth ` +
        `layer is configured. This console exposes memory contents and must not be reachable ` +
        `beyond localhost without auth. No auth layer exists in Phase 1 — use a loopback HOST ` +
        `(127.0.0.1, localhost, ::1).`
    );
  }
}
