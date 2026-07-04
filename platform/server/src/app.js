import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostOriginGuard } from './security.js';
import { computeMetrics } from './metrics.js';
import { buildDocsTree, readDocFile, searchDocs, findBacklinks } from './docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../../dashboard/dist');

/**
 * Build the Express app. Exported separately from listen() — the primary
 * test seam: tests drive /api/* in-process (supertest-style) with no bind.
 */
export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', hostOriginGuard());
  app.use('/api', express.json());

  app.get('/api/status', (req, res) => {
    res.json({
      status: 'ready',
      service: 'agentic-os-web-console',
      phase: 'P1',
      host: config.HOST,
      port: config.PORT,
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

  // Controlled execution is Phase 3 (ADR-0001); until then both endpoints 501.
  const notImplemented = (req, res) => {
    res.status(501).json({
      error: 'not-implemented',
      message: 'Operation execution is Phase 3; this console is read-only (ADR-0001)',
    });
  };
  app.post('/api/operations/:id/dry-run', notImplemented);
  app.post('/api/operations/:id/run', notImplemented);

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
