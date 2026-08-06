/**
 * Copies non-TypeScript runtime assets into the build output.
 *
 * `tsc` only emits .js for .ts inputs, so anything read at runtime by path —
 * the SQL migrations, in particular — is silently absent from `dist` without
 * this. The failure mode is a container that builds cleanly and then dies on
 * its first `migrate()` call, so the copy is verified rather than assumed.
 *
 * Migrations are copied as a directory rather than a fixed list: a new
 * migration that someone forgot to add here would be a container that starts
 * against a schema one version behind, which is worse than a build error.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const directories = [['src/persistence/migrations', 'dist/persistence/migrations', '.sql']];

for (const [from, to, extension] of directories) {
  const source = path.join(root, from);
  const destination = path.join(root, to);

  if (!fs.existsSync(source)) {
    throw new Error(`missing build asset directory: ${from}`);
  }

  const files = fs.readdirSync(source).filter((file) => file.endsWith(extension));
  if (files.length === 0) {
    throw new Error(`no ${extension} files found in ${from}`);
  }

  fs.mkdirSync(destination, { recursive: true });
  for (const file of files) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
    if (!fs.existsSync(path.join(destination, file))) {
      throw new Error(`failed to copy ${from}/${file}`);
    }
  }

  console.log(`copied ${files.length} file(s) ${from} → ${to}`);
}
