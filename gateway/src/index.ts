import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BanproofEngine } from './engine';
import { tollBoothMiddleware } from './middleware/tollBooth';

type Bindings = {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE: WorkflowBinding;
  CORS_ALLOWED_ORIGINS?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const configured = (c.env?.CORS_ALLOWED_ORIGINS as string | undefined) ?? 'http://localhost:5500';
      const allowedOrigins = configured
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

      if (origin && allowedOrigins.includes(origin)) {
        return origin;
      }

      return allowedOrigins[0] ?? '';
    },
    credentials: true
  })
);

// Health Check - Verifies D1 is actually connected
app.get('/api/health', async (c) => {
  try {
    const dbCheck = await c.env.DB.prepare('SELECT 1').first();
    return c.json({ status: 'ok', database: !!dbCheck, workflow: !!c.env.ENGINE });
  } catch (_err) {
    // If the DB binding is misconfigured or the query fails, report unhealthy instead of throwing
    return c.json(
      { status: 'error', database: false, workflow: !!c.env.ENGINE },
      503
    );
  }
});

// Protect all pro routes with Toll Booth authentication
app.use('/api/pro/*', tollBoothMiddleware);

// Trigger the AI Signal Workflow (Pro Only)
app.post('/api/pro/analyze', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const query = (body as Record<string, unknown>)?.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return c.json({ error: 'Missing or invalid field: query' }, 400);
  }

  // Derive userId from context set by tollBoothMiddleware
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const instance = await c.env.ENGINE.create({
    params: { query: query.trim(), userId }
  });
  return c.json({ success: true, workflowId: instance.id });
});

export { BanproofEngine };
export default app;
