import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { loadDotEnv } from './env';
import { features } from './features/registry';

const envFile = loadDotEnv();
const config = loadConfig();
// In dev this file is src/index.ts, in production it is bundled to dist/index.js;
// either way migrations sit next to it (the build copies them).
const srcRoot = dirname(fileURLToPath(import.meta.url));

const { app, ctx } = await buildApp({
  config,
  srcRoot,
  features,
  logger: { level: config.logLevel },
});

if (envFile) app.log.info({ envFile }, 'loaded .env');
if (config.env !== 'production' && !process.env.ADMIN_PIN) {
  app.log.warn(`dev PINs in use: console ${config.adminPin}, projector ${config.screenPin}, gate ${config.gatePin}`);
}
if (!ctx.push.enabled) app.log.warn('VAPID keys not set: push notifications disabled (npm run vapid -w server)');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
