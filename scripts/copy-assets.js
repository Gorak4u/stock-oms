/**
 * Copies non-TypeScript runtime assets into the build output.
 *
 * `tsc` only emits .js for .ts inputs, so anything read at runtime by path —
 * the SQL schema, in particular — is silently absent from `dist` without this.
 * The failure mode is a container that builds cleanly and then dies on its
 * first `migrate()` call, so the copy is verified rather than assumed.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const assets = [['src/persistence/schema.sql', 'dist/persistence/schema.sql']];

for (const [from, to] of assets) {
  const source = path.join(root, from);
  const destination = path.join(root, to);

  if (!fs.existsSync(source)) {
    throw new Error(`missing build asset: ${from}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);

  if (!fs.existsSync(destination)) {
    throw new Error(`failed to copy ${from} → ${to}`);
  }
  console.log(`copied ${from} → ${to}`);
}
