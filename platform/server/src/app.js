import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostOriginGuard } from './security.js';
import { computeMetrics } from './metrics.js';
import { buildDocsTree, readDocFile, searchDocs, findBacklinks } from './docs.js';
import { queryMemory } from './memory.js';
import { listWorkflows, getWorkflow } from './workflows.js';
import { listSkills } from './skills.js';
import { listOperations } from './operations.js';
import { createExecutor } from './executor.js';
import { readAuditTail } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../../dashboard/dist');

/**
 * Build the Express app. Exported separately from listen() — the primary
 * test seam: tests drive /api/* in-process (supertest-style) with no bind.
 */
export function createApp(config, { executor = createExecutor(config) } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', hostOriginGuard(config));
  app.use('/api', express.json());

  app.get('/api/status', (req, res) => {
    res.json({
      status: 'ready',
      service: 'agentic-os-web-console',
      phase: 'P3',
      host: config.HOST,
      port: config.PORT,
      localHostname: config.LOCAL_HOSTNAME,
      repoRoot: config.REPO_ROOT,
      exposeRawContent: config.EXPOSE_RAW_CONTENT,
      refreshMs: config.REFRESH_MS,
      now: new Date().toISOString(),
    });
  });

  // Canonical metrics (ADR-0002): a live scan per request — no cache, no
  // TTL; refresh is simply "fetch again" (plan: Live reads).
  app.get('/api/metrics', async (req, res) => {
    try {
      res.json(await computeMetrics(config));
    } catch (err) {
      res.status(500).json({ error: 'metrics-failed', message: err.message });
    }
  });

  // Docs explorer: tree + single-file read. Raw *content* is gated by
  // EXPOSE_RAW_CONTENT (ADR-0005); path safety rejects traversal (400).
  app.get('/api/docs/tree', async (req, res) => {
    try {
      res.json(await buildDocsTree(config));
    } catch (err) {
      res.status(500).json({ error: 'docs-tree-failed', message: err.message });
    }
  });

  app.get('/api/docs/file', async (req, res) => {
    try {
      res.json(await readDocFile(config, req.query.path));
    } catch (err) {
      if (err.name === 'PathSafetyError') {
        res.status(400).json({ error: 'unsafe-path', message: err.message });
      } else if (err.name === 'RawContentHiddenError') {
        res.status(403).json({ error: 'raw-content-hidden', message: err.message });
      } else if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        res.status(404).json({ error: 'not-found', message: 'no such doc' });
      } else {
        res.status(500).json({ error: 'docs-file-failed', message: err.message });
      }
    }
  });

  // Search: filename matches always; raw bodies/snippets only with
  // EXPOSE_RAW_CONTENT=true (ADR-0005).
  app.get('/api/docs/search', async (req, res) => {
    try {
      res.json(await searchDocs(config, req.query.q));
    } catch (err) {
      if (err.name === 'BadQueryError') {
        res.status(400).json({ error: 'bad-query', message: err.message });
      } else {
        res.status(500).json({ error: 'docs-search-failed', message: err.message });
      }
    }
  });

  // Backlinks: docs that link to ?path= (relative, root-relative, wikilink,
  // heading-anchor forms). Same path safety as /api/docs/file.
  app.get('/api/docs/backlinks', async (req, res) => {
    try {
      res.json(await findBacklinks(config, req.query.path));
    } catch (err) {
      if (err.name === 'PathSafetyError') {
        res.status(400).json({ error: 'unsafe-path', message: err.message });
      } else {
        res.status(500).json({ error: 'docs-backlinks-failed', message: err.message });
      }
    }
  });

  // Memory recall (ADR-0001/0005): deterministic tag-based recall over
  // wiki/**/*.md only — mirrors the aos-query-memory Skill's mechanical half
  // (scripts/wiki-tags.py). raw/ is never read here regardless of
  // EXPOSE_RAW_CONTENT. Finds pages only; it never invokes Hermes, Claude,
  // Codex, or any Skill — synthesis stays a copy-only handoff in the UI.
  app.get('/api/memory/query', async (req, res) => {
    try {
      res.json(await queryMemory(config, req.query.topic));
    } catch (err) {
      if (err.name === 'BadQueryError') {
        res.status(400).json({ error: 'bad-query', message: err.message });
      } else {
        res.status(500).json({ error: 'memory-query-failed', message: err.message });
      }
    }
  });

  // Workflow registry (ADR-0006/0007): objective defects only; Unclassified
  // is first-class; precedence Missing links > Needs review > Unclassified >
  // Stale > OK.
  app.get('/api/workflows', async (req, res) => {
    try {
      res.json(await listWorkflows(config));
    } catch (err) {
      res.status(500).json({ error: 'workflows-failed', message: err.message });
    }
  });

  // Per-workflow lookup by ?path= (query param, not /:id — workflow paths
  // contain slashes).
  app.get('/api/workflow', async (req, res) => {
    try {
      res.json(await getWorkflow(config, req.query.path));
    } catch (err) {
      if (err.name === 'PathSafetyError' || err.name === 'NotAWorkflowError') {
        res.status(400).json({ error: 'bad-workflow-path', message: err.message });
      } else if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        res.status(404).json({ error: 'not-found', message: 'no such workflow' });
      } else {
        res.status(500).json({ error: 'workflow-failed', message: err.message });
      }
    }
  });

  // Skill registry (ADR-0001): a directory scan of .claude/skills — reports
  // exactly what exists (never a phantom); Skills are copy-invocation only,
  // never console-executable.
  app.get('/api/skills', async (req, res) => {
    try {
      res.json(await listSkills(config));
    } catch (err) {
      res.status(500).json({ error: 'skills-failed', message: err.message });
    }
  });

  // Operations catalog (ADR-0001): static and typed — guided (checklist +
  // command preview, copy-only) or executable (P3 allowlist, described but
  // not runnable). LLM-Skill-backed operations are always guided.
  app.get('/api/operations', (req, res) => {
    try {
      res.json(listOperations());
    } catch (err) {
      res.status(500).json({ error: 'operations-failed', message: err.message });
    }
  });

  // Audit tail: every Phase 3 run appends one entry (op, ts, status, files, output).
  app.get('/api/audit', async (req, res) => {
    try {
      res.json(await readAuditTail(config));
    } catch (err) {
      res.status(500).json({ error: 'audit-failed', message: err.message });
    }
  });

  // Controlled execution (Phase 3, ADR-0001): allowlist-only, dry-run first,
  // explicit confirm, single-flight, audited. The :id only selects a row in
  // the executor's fixed command table — it is never interpolated.
  const sendExecError = (res, err) => {
    if (err.name === 'ExecError') {
      res.status(err.status).json({ error: err.code, message: err.message });
    } else {
      res.status(500).json({ error: 'exec-failed', message: err.message });
    }
  };
  app.post('/api/operations/:id/dry-run', (req, res) => {
    try {
      res.json(executor.dryRun(req.params.id));
    } catch (err) {
      sendExecError(res, err);
    }
  });
  // Run starts a job and answers 202 immediately (roadmap §4.2); progress
  // via the snapshot and SSE routes below. Validation is unchanged and
  // still synchronous — nothing executes on a refused request.
  app.post('/api/operations/:id/run', (req, res) => {
    try {
      res.status(202).json(executor.run(req.params.id, req.body ?? {}));
    } catch (err) {
      sendExecError(res, err);
    }
  });

  app.get('/api/operations/runs/:runId', (req, res) => {
    const run = executor.getRun(req.params.runId);
    if (!run) res.status(404).json({ error: 'no-such-run' });
    else res.json(run);
  });

  // SSE stream for one run: first the current snapshot, then live output
  // chunks, then the final snapshot. Same-origin only — it sits behind the
  // same Host/Origin guard as every /api route.
  app.get('/api/operations/runs/:runId/events', (req, res) => {
    const run = executor.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: 'no-such-run' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', run);
    if (run.status !== 'running') {
      send('done', run);
      res.end();
      return;
    }
    const unsubscribe = executor.subscribe(req.params.runId, (event) => {
      if (event.type === 'output') send('output', { stream: event.stream, chunk: event.chunk });
      if (event.type === 'done') {
        send('done', event.snapshot);
        res.end();
      }
    });
    req.on('close', unsubscribe);
    // The job may have finished between the snapshot and the subscribe —
    // re-check so the client never waits on a 'done' that already happened.
    const now = executor.getRun(req.params.runId);
    if (now && now.status !== 'running') {
      unsubscribe();
      send('done', now);
      res.end();
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not-found' });
  });

  // Prod: serve the built dashboard at / (single loopback port).
  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  return app;
}
