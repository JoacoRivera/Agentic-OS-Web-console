import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostOriginGuard } from './security.js';

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
