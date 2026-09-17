import crypto from 'node:crypto';
import { isAllowedLocalHostname } from './config.js';

/** Header the authenticated reverse proxy injects (ADR-0005 amendment). */
export const PROXY_SECRET_HEADER = 'x-aos-proxy-auth';

function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function originHostname(originHeader) {
  try {
    return new URL(originHeader).hostname;
  } catch {
    return null; // includes the literal "null" origin — rejected
  }
}

function secretMatches(presented, expected) {
  if (typeof presented !== 'string') return false;
  // Hash both sides so timingSafeEqual sees equal lengths.
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * DNS-rebinding / cross-origin defense (ADR-0005). Loopback bind is
 * necessary but insufficient: a browser page can still fetch() the API and
 * DNS rebinding defeats the Same-Origin Policy. So every /api request must
 * (a) carry a loopback Host header (or the single explicitly configured local
 * alias) and (b) carry no Origin, or an Origin with the same local allowlist.
 * No permissive CORS anywhere — we never emit CORS headers, so cross-origin
 * reads are blocked by the browser even where a request lands.
 *
 * Amendment (2026-09-17): when PROXY_HOSTNAME is configured, a request whose
 * Host is exactly that name is accepted only with the proxy secret header,
 * and then only with no Origin or that same proxy origin. The proxy and local
 * allowlists never mix.
 */
export function hostOriginGuard(config) {
  return (req, res, next) => {
    const hostname = hostnameOf(req.headers.host ?? '');
    const origin = req.headers.origin;

    if (config.PROXY_HOSTNAME !== null && hostname === config.PROXY_HOSTNAME) {
      if (!secretMatches(req.headers[PROXY_SECRET_HEADER], config.PROXY_SECRET)) {
        return res.status(403).json({
          error: 'forbidden-proxy',
          message: 'Proxy hostname requests must come through the authenticated proxy (ADR-0005)',
        });
      }
      if (origin !== undefined && originHostname(origin) !== config.PROXY_HOSTNAME) {
        return res.status(403).json({
          error: 'forbidden-origin',
          message: 'Cross-origin requests are not allowed (ADR-0005)',
        });
      }
      return next();
    }

    if (!isAllowedLocalHostname(hostname, config.LOCAL_HOSTNAME)) {
      return res.status(403).json({
        error: 'forbidden-host',
        message:
          'Host header must be a loopback host or the configured local hostname ' +
          '(DNS-rebinding defense, ADR-0005)',
      });
    }
    if (
      origin !== undefined &&
      !isAllowedLocalHostname(originHostname(origin), config.LOCAL_HOSTNAME)
    ) {
      return res.status(403).json({
        error: 'forbidden-origin',
        message: 'Cross-origin requests are not allowed (ADR-0005)',
      });
    }
    next();
  };
}
