/**
 * Exercises the serverless composition the way Vercel does.
 *
 * Builds the app, serves a few routes, runs a tick, and runs two ticks at once
 * to confirm the lease admits only one. Kept as a script rather than a test
 * because it drives the real entry points against a real database, which is
 * what a deploy actually does.
 */
import { createApp, runTick, resetAssembly } from '../src/serverless';

async function main(): Promise<void> {
  const app = await createApp();
  const auth = { authorization: `Bearer ${process.env.API_TOKEN}` };

  for (const url of ['/health', '/api/status', '/api/positions', '/api/orders']) {
    const r = await app.inject({ method: 'GET', url, headers: auth });
    console.log(`  GET  ${url.padEnd(18)} ${r.statusCode}`);
  }

  const unauth = await app.inject({ method: 'GET', url: '/api/status' });
  console.log(`  GET  /api/status (no token) ${unauth.statusCode}`);

  const tickNoAuth = await app.inject({ method: 'POST', url: '/api/tick' });
  console.log(`  POST /api/tick (no token)   ${tickNoAuth.statusCode}`);

  const tick = await app.inject({ method: 'POST', url: '/api/tick', headers: auth });
  console.log(`  POST /api/tick              ${tick.statusCode}  ${tick.body}`);

  const [a, b] = await Promise.all([runTick(), runTick()]);
  console.log(`  concurrent ticks            ran=${a.ran} / ran=${b.ran}`);
  if (a.ran && b.ran) throw new Error('two ticks ran at once — the lease did not hold');

  await app.close();
  resetAssembly();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); });
