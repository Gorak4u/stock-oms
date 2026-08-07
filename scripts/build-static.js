/**
 * Stages the static site served by a CDN host.
 *
 * Both *user interfaces* are static files, and both go here:
 *
 *   index.html      the trading dashboard — a shell that reads the API
 *   console.html   the backtest console — self-contained, runs the real engine
 *                  in the browser, reaches nothing
 *
 * These are the same files the process serves at `/` and `/console`, under the
 * same paths, so there is one of each to maintain rather than two that drift.
 * Serving them from the CDN rather than through a function is purely so a page
 * load does not wake the engine.
 *
 * The engine itself is not here — it is a function (`api/index.ts`) or a
 * long-running process, depending on how you deploy. See DEPLOYMENT.md.
 *
 *   npm run build:static   →   public/
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const builtConsole = path.join(root, 'dist', 'console.html');
const dashboard = path.join(root, 'web', 'dashboard.html');

execFileSync(process.execPath, [path.join(__dirname, 'build-console.js')], {
  cwd: root,
  stdio: 'inherit',
});

if (!fs.existsSync(builtConsole)) {
  throw new Error('build-console.js did not produce dist/console.html');
}
if (!fs.existsSync(dashboard)) {
  throw new Error('missing web/dashboard.html');
}

fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });

// Mirrors the application's own routes exactly — `/` is the dashboard and
// `/console` the backtest console — so a link behaves the same whether the page
// came from the CDN or from the process. They diverged once, and the result was
// a root URL that meant two different things depending on where you opened it.
const pages = [
  [dashboard, 'index.html', 5_000],
  [builtConsole, 'console.html', 10_000],
];

for (const [from, name, minBytes] of pages) {
  const to = path.join(publicDir, name);
  fs.copyFileSync(from, to);

  const bytes = fs.statSync(to).size;
  if (bytes < minBytes) {
    // The console inlines the whole engine; a small file means the bundle
    // failed to inject and the deploy would be an empty shell.
    throw new Error(`public/${name} is only ${bytes} bytes — it did not build correctly`);
  }
  console.log(`staged public/${name} (${(bytes / 1024).toFixed(0)} KB)`);
}

// The dashboard is a shell that reads a live engine. Publishing one that had
// somehow been built with a baked-in endpoint or token would be a credential
// leak on a public URL, so the property is asserted rather than assumed.
const staged = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
if (/Bearer\s+[A-Za-z0-9._-]{16,}/.test(staged)) {
  throw new Error('public/index.html appears to contain a hard-coded token');
}
