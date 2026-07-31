/**
 * Builds the standalone backtest console.
 *
 * Bundles the platform core for the browser and inlines it into
 * `web/console.template.html`, producing a single self-contained HTML file that
 * runs the real engine — same strategy, risk, sizing, cost and fill code as the
 * Node build, not a reimplementation.
 *
 * `node:crypto` is aliased to a pure-JS SHA-256 shim so the audit chain hashes
 * identically in the browser; `__tests__/cryptoShim.test.ts` asserts the two
 * agree byte for byte.
 *
 *   npm run build:console   →   dist/console.html
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist');
const bundlePath = path.join(outDir, 'engine.js');
const templatePath = path.join(root, 'web', 'console.template.html');
const outPath = path.join(outDir, 'console.html');

const MARKER = '/*__ENGINE__*/';

fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  path.join(root, 'node_modules', '.bin', 'esbuild'),
  [
    'src/browser.ts',
    '--bundle',
    '--format=iife',
    '--global-name=TP',
    '--platform=browser',
    '--target=es2020',
    '--minify',
    '--alias:node:crypto=./src/shims/nodeCrypto.browser.ts',
    `--outfile=${bundlePath}`,
  ],
  { cwd: root, stdio: 'inherit' },
);

const template = fs.readFileSync(templatePath, 'utf8');
if (!template.includes(MARKER)) {
  throw new Error(`${templatePath} is missing the ${MARKER} injection point`);
}

const bundle = fs.readFileSync(bundlePath, 'utf8');
fs.writeFileSync(outPath, template.replace(MARKER, bundle));

const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`\nBuilt ${path.relative(root, outPath)} (${kb} kB) — open it directly in a browser.`);
