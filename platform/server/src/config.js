import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** True if `hostname` (no port, no brackets) is a loopback name. */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  return LOOPBACK_HOSTNAMES.has(hostname.replace(/^\[|\]$/g, '').toLowerCase());
}

/**
 * Build the runtime config from an env object. All tunables live here
 * (single source); nothing else reads process.env.
 */
export function createConfig(env = process.env) {
  return {
    PORT: Number(env.PORT ?? 3001),
    HOST: env.HOST ?? '127.0.0.1',
    // Default assumes platform/ lives inside the Agentic OS repo
    // (repo root = ../../.. from server/src). Overridable for dev/tests.
    REPO_ROOT: env.REPO_ROOT
      ? path.resolve(env.REPO_ROOT.replace(/^~(?=\/|$)/, env.HOME ?? '~'))
      : path.resolve(__dirname, '../../..'),
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
