import { runtimeCookiePath } from './init-cookies.js';
import { unlink } from 'node:fs/promises';
import { config } from './config.js';
import { Extractor } from './extractor.js';
import { Pipeline } from './pipeline.js';
import { StreamManager } from './manager.js';
import { createApp } from './app.js';
import { capture, shutdownChildren } from './process.js';
import { log } from './log.js';
const dependencies = { ffmpeg: false, ytDlp: false };
await Promise.all(
  [
    ['ffmpeg', config.ffmpeg, ['-version']],
    ['ytDlp', config.ytDlp, ['--version']],
  ].map(async ([key, cmd, args]) => {
    try {
      await capture(cmd, args, { timeoutMs: 5000 });
      dependencies[key] = true;
    } catch {
      log('error', 'dependency_missing', { dependency: key });
    }
  }),
);
const extractor = new Extractor(config),
  manager = new StreamManager(config, new Pipeline(config, extractor));
await manager.init();
log('info', 'cookie_configuration', {
  configured: config.cookieConfigured,
  valid: config.cookieValid,
  source: config.cookieConfigured ? (process.env.YT_DLP_COOKIES_CONTENT ? 'environment' : 'file') : 'none',
  use: config.cookieValid ? 'fallback-only' : 'not-used',
  reason: config.cookieConfigured && !config.cookieValid ? config.cookieReason : undefined,
  note: config.cookieConfigured && !config.cookieValid ? 'expected Netscape cookie text/file; cookie-free extraction remains enabled' : undefined,
});
log('info', 'public_origin', {
  source: process.env.PUBLIC_ORIGIN ? 'PUBLIC_ORIGIN' : process.env.RAILWAY_PUBLIC_DOMAIN ? 'RAILWAY_PUBLIC_DOMAIN' : 'request-host',
  configured: !!config.publicOrigin,
});
const app = createApp(config, manager, extractor, { dependencies });
const server = app.listen(config.port, '0.0.0.0', () =>
  log('info', 'listening', { port: config.port, mode: config.demo ? 'demo' : 'live' }),
);
server.requestTimeout = 60000;
server.headersTimeout = 15000;
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log('info', 'shutdown', { signal });
  const deadline = setTimeout(() => process.exit(1), 20000);
  deadline.unref();
  app.locals.channelAbort.abort();
  server.close();
  await manager.shutdown();
  await shutdownChildren();
  if (runtimeCookiePath) await unlink(runtimeCookiePath).catch(() => {});
  server.closeAllConnections();
  clearTimeout(deadline);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('error', 'uncaught_exception', { code: err.code || 'INTERNAL' });
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', () => {
  log('error', 'unhandled_rejection');
  void shutdown('unhandledRejection');
});
