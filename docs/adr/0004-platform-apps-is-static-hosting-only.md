# "Platform Apps" is static frontend hosting only; backend hosting is a separate product; and same-origin app hosting is deferred out of P1

When the console's "Platform Apps" feature exists, it means **static frontend hosting only**:
scan `platform/apps/*/dist`, `express.static`-mount each. It serves built
React/Angular/Vite frontends. It does **not** host Nest/Node backend apps.

We decided the *capability* scope because hosting a live backend requires a whole process
model — spawn / supervise / restart, env injection, port allocation, reverse proxying, logs,
health checks, security boundaries — none of which exists in this plan, and all of which
conflicts with the console's no-arbitrary-execution safety model (see ADR-0001). A memory
console and a local app supervisor are two different products that happen to share a port;
bundling a PaaS into the memory console would smuggle a large process-lifecycle and security
surface in under a one-line "platform hook".

## Trust boundary (the part capability-scoping missed)

Scoping the *capability* (static only) does **not** scope the *browser trust boundary*.
Static frontend hosting **on the same origin as the memory API** grants the hosted bundle
**ambient read access to the console API**: a page at `127.0.0.1:3001/apps/<name>/` calling
`fetch('/api/...')` sends the console's own `Origin`, which the ADR-0005 Origin allowlist
must accept — so the DNS-rebinding defense is bypassed *by design*, and any hosted bundle
(plus its transitive npm supply chain) can read all `wiki/` contents (and raw, if
`EXPOSE_RAW_CONTENT=true`) and exfiltrate over the network. This risk is present in Phase 1
with static hosting alone — it is **not** the deferred backend supervisor's problem.

**Therefore same-origin Platform Apps are not part of P1.** P1 stays a clean private console
with no untrusted same-origin extensions.

## Consequences

- **Platform Apps is deferred out of P1** (sidebar entry, the `apps/*/dist` scan, and the
  `/apps/<name>` mounts). P1 serves only the dashboard itself.
- Drop/qualify any claim that the console hosts "Node/Nest apps" ("Host" = serve static
  builds).
- Backend/Nest hosting is explicitly out of scope and deferred to a separate future
  "local app supervisor" project/phase with its own process model and security review.
- **When app hosting returns it must be separate-origin by design:** a different port (or a
  distinct loopback host if practical); no same-origin access to `/api/*`; the API denies app
  origins by default; per-app opt-in via explicit CORS or token-scoped grants only if a
  specific app needs memory data; and an explicit warning that hosted bundles are executable
  frontend code with supply-chain risk.
