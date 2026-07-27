import { isAllowedLocalHostname } from './config.js';

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

/**
 * DNS-rebinding / cross-origin defense (ADR-0005). Loopback bind is
 * necessary but insufficient: a browser page can still fetch() the API and
 * DNS rebinding defeats the Same-Origin Policy. So every /api request must
 * (a) carry a loopback Host header (or the single explicitly configured local
 * alias) and (b) carry no Origin, or an Origin with the same local allowlist.
 * No permissive CORS anywhere — we never emit CORS headers, so cross-origin
 * reads are blocked by the browser even where a request lands.
 */
export function hostOriginGuard(config) {
  return (req, res, next) => {
    const hostname = hostnameOf(req.headers.host ?? '');
    if (!isAllowedLocalHostname(hostname, config.LOCAL_HOSTNAME)) {
      return res.status(403).json({
        error: 'forbidden-host',
        message:
          'Host header must be a loopback host or the configured local hostname ' +
          '(DNS-rebinding defense, ADR-0005)',
      });
    }
    const origin = req.headers.origin;
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
