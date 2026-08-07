/**
 * Vercel function entry point for the whole application.
 *
 * Every request — the dashboard, the console, the API — arrives here and is
 * handed to the same Fastify instance the always-on process builds. There is no
 * second implementation of any route; `vercel.json` rewrites everything to this
 * file and Fastify does the routing, exactly as it does under `npm start`.
 *
 * The instance is cached across invocations that reuse a warm container, so a
 * cold start pays for migrating and rebuilding state once rather than per
 * request.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/serverless';

let ready: Promise<{ emit: (req: IncomingMessage, res: ServerResponse) => void }> | null = null;

async function handler(): Promise<{ emit: (req: IncomingMessage, res: ServerResponse) => void }> {
  const app = await createApp();
  // `server.emit('request', …)` is Fastify's documented way to drive it from an
  // existing Node request without listening on a port.
  return { emit: (req, res) => app.server.emit('request', req, res) };
}

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    ready ??= handler();
    const app = await ready;
    app.emit(req, res);
  } catch (error) {
    // A failure here is a failure to *build* the app — a missing API_TOKEN, an
    // unreachable database — so it happens before any route runs and would
    // otherwise surface as an opaque 500 with nothing in the body.
    ready = null;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: 'error', msg: 'failed to build app', detail }));

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `application failed to start: ${detail}` }));
  }
}
