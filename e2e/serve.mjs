// Starts the built server on a throwaway database for the e2e suite.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const port = process.env.E2E_PORT ?? '4310';
const dir = join(process.cwd(), '.playwright', 'data');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const child = spawn(process.execPath, ['server/dist/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: port,
    HOST: '127.0.0.1',
    DATABASE_PATH: join(dir, 'e2e.db'),
    WEB_DIST: 'web/dist',
    APP_URL: `http://127.0.0.1:${port}`,
    ADMIN_PIN: '2468',
    SCREEN_PIN: '1357',
    GATE_PIN: '3579',
    LOG_LEVEL: 'warn',
  },
});
child.on('exit', (c) => process.exit(c ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
