// ============================================================
// Turnstile middleware
// Verifies the Cloudflare Turnstile challenge token on every
// request that requires bot protection.
//
// Usage:
//   app.use('/api/public/*', turnstile);
//
// The client must send the token in one of:
//   - Header:  cf-turnstile-response
//   - Query:   ?cf-turnstile-response=<token>
//   - JSON body field: cf_turnstile_response
// ============================================================

import { Context, Next } from 'hono';
import type { Env, Variables } from '../types.js';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function turnstile(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
): Promise<Response | void> {
  const token =
    c.req.header('cf-turnstile-response') ??
    c.req.query('cf-turnstile-response');

  if (!token) {
    return c.json(
      { error: 'Bot verification required. Missing cf-turnstile-response.' },
      403,
    );
  }

  const ip = c.req.header('CF-Connecting-IP') ?? '';

  const body = new FormData();
  body.append('secret',   c.env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  const res = await fetch(SITEVERIFY_URL, { method: 'POST', body });
  const outcome = await res.json<{
    success:      boolean;
    'error-codes': string[];
  }>();

  if (!outcome.success) {
    return c.json(
      { error: 'Bot challenge failed.', codes: outcome['error-codes'] },
      403,
    );
  }

  await next();
}
