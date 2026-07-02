// Entrypoint: builds config, enforces the ADR-0005 startup guard, and binds.
// Importing app.js never binds — the app/listen split is the primary test seam.
import { createConfig, assertStartable } from './config.js';
import { createApp } from './app.js';

const config = createConfig();

try {
  assertStartable(config);
} catch (err) {
  console.error(`[console] refusing to start: ${err.message}`);
  process.exit(1);
}

const app = createApp(config);
const server = app.listen(config.PORT, config.HOST, () => {
  const addr = server.address();
  console.log(`[console] listening on http://${addr.address}:${addr.port} (localhost-only private console)`);
});
