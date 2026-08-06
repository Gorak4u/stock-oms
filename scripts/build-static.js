/**
 * Stages the static site served by a CDN host.
 *
 * The only part of this platform that is genuinely static is the backtest
 * console: a single self-contained HTML file with the real engine compiled in,
 * no server, no database, no broker. That deploys anywhere. The trading
 * platform itself does not — it is a long-running process with a tick loop, a
 * held database lock and a websocket, none of which survive a serverless model.
 *
 * Keeping this separate from `build` is the point. A static host builds this
 * and gets a working console; it never accidentally publishes a half-running
 * copy of the trading system.
 *
 *   npm run build:static   →   public/index.html
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const console_ = path.join(root, 'dist', 'console.html');

execFileSync(process.execPath, [path.join(__dirname, 'build-console.js')], {
  cwd: root,
  stdio: 'inherit',
});

if (!fs.existsSync(console_)) {
  throw new Error('build-console.js did not produce dist/console.html');
}

fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });

// index.html rather than console.html: a static host serves the directory root.
fs.copyFileSync(console_, path.join(publicDir, 'index.html'));

const bytes = fs.statSync(path.join(publicDir, 'index.html')).size;
if (bytes < 10_000) {
  // The console inlines the whole engine; anything this small means the
  // bundle failed to inject and the deploy would be an empty shell.
  throw new Error(`public/index.html is only ${bytes} bytes — the engine did not inline`);
}

console.log(`staged public/index.html (${(bytes / 1024).toFixed(0)} KB)`);
