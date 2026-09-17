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

/**
 * Build the runtime config from an env object. All tunables live here
 * (single source); nothing else reads process.env.
 */
export function createConfig(env = process.env) {
  const proxy = proxyFromEnv(env);
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
    REPO_ROOT: env.REPO_ROOT
      ? path.resolve(env.REPO_ROOT.replace(/^~(?=\/|$)/, env.HOME ?? '~'))
      : path.resolve(__dirname, '../../..'),
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
