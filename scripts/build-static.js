/**
 * Stages the static site served by a CDN host.
 *
 * Both *user interfaces* are static files, and both go here:
 *
 *   index.html      the backtest console — self-contained, runs the real engine
 *                   in the browser, reaches nothing
 *   dashboard.html  the trading dashboard — a shell that reads a live engine
 *                   over the API, configured at runtime
 *
 * What does *not* go here is the engine. It is a long-running process with a
 * tick loop, a held database advisory lock and in-memory risk state (the
 * square-off guard, the drawdown baseline, staged approvals), none of which
 * survive a serverless model — the risk controls would silently stop working.
 * It runs on a host that keeps a process alive; see DEPLOYMENT.md.
 *
 * The dashboard shipped here is the same file the engine serves at `/`, so
 * there is one dashboard to maintain rather than two that drift.
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

const pages = [
  // index.html, not console.html: a static host serves the directory root.
  [builtConsole, 'index.html', 10_000],
  [dashboard, 'dashboard.html', 5_000],
  // Also under its own name so the dashboard's "Backtest console →" link
  // resolves the same way whether the page is served by the CDN or the engine.
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
const staged = fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf8');
if (/Bearer\s+[A-Za-z0-9._-]{16,}/.test(staged)) {
  throw new Error('public/dashboard.html appears to contain a hard-coded token');
}
