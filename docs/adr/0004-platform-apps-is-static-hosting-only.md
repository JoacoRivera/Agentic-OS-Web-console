# "Platform Apps" is static frontend hosting only; backend hosting is a separate product

In Phase 1, the console's "Platform Apps" feature means **static frontend hosting only**:
scan `platform/apps/*/dist`, `express.static`-mount each at `/apps/<name>`. It serves built
React/Angular/Vite frontends. It does **not** host Nest/Node backend apps.

We decided this because hosting a live backend requires a whole process model — spawn /
supervise / restart, env injection, port allocation, reverse proxying, logs, health checks,
security boundaries — none of which exists in this plan, and all of which conflicts with the
console's no-arbitrary-execution safety model (see ADR-0001). A memory console and a local
app supervisor are two different products that happen to share a port; bundling a PaaS into
the memory console would smuggle a large process-lifecycle and security surface in under a
one-line "platform hook".

## Consequences

- Drop/qualify any claim that the console hosts "Node/Nest apps" in Phase 1 ("Host" = serve
  static builds).
- Backend/Nest hosting is explicitly out of scope and deferred to a separate future
  "local app supervisor" project/phase with its own process model and security review.
