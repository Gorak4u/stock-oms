/**
 * Validates vercel.json before it reaches a deploy.
 *
 * Vercel rejects unknown properties rather than ignoring them, and the failure
 * arrives at deploy time as a schema error — after a push, in someone else's
 * dashboard. JSON has no comment syntax, so the tempting thing is to invent one
 * (`"comment": "..."` next to a header) and that is exactly what gets rejected.
 *
 * This checks the shape locally so the mistake surfaces in CI instead. It is a
 * deliberately narrow allowlist of the keys this project uses, not a full
 * implementation of Vercel's schema: the goal is to catch a stray property, and
 * a check that tried to model everything would drift out of date and start
 * rejecting valid config.
 */

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'vercel.json');

/** Top-level keys this project uses. Extend deliberately, not reflexively. */
const TOP_LEVEL = new Set([
  '$schema', 'framework', 'installCommand', 'buildCommand', 'outputDirectory',
  'github', 'headers', 'redirects', 'rewrites', 'cleanUrls', 'trailingSlash',
  'regions', 'crons', 'ignoreCommand', 'devCommand',
]);

/** A header *route*. */
const ROUTE = new Set(['source', 'headers', 'has', 'missing']);

/** A single header. Only these two — this is the one that bit us. */
const HEADER = new Set(['key', 'value']);

const errors = [];

function check(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      errors.push(
        `${where} has unsupported property "${key}" ` +
          `(allowed: ${[...allowed].join(', ')})`,
      );
    }
  }
}

let config;
try {
  config = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`vercel.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

check(config, TOP_LEVEL, 'vercel.json');

const routes = Array.isArray(config.headers) ? config.headers : [];
routes.forEach((route, i) => {
  check(route, ROUTE, `headers[${i}]`);

  if (typeof route.source !== 'string') {
    errors.push(`headers[${i}] is missing a string "source"`);
  }

  const headers = Array.isArray(route.headers) ? route.headers : [];
  headers.forEach((header, j) => {
    check(header, HEADER, `headers[${i}].headers[${j}]`);

    if (typeof header.key !== 'string' || typeof header.value !== 'string') {
      errors.push(`headers[${i}].headers[${j}] needs string "key" and "value"`);
    }
  });
});

// The build command must actually produce what outputDirectory points at,
// or the deploy fails with "no output directory found" — the error that
// started all of this.
if (config.outputDirectory && !config.buildCommand) {
  errors.push('outputDirectory is set but buildCommand is not — nothing would produce it');
}

if (errors.length > 0) {
  console.error('vercel.json is invalid:\n');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('vercel.json looks valid');
