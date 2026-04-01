import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { BanproofEngine } from './engine';

type Bindings = {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE: WorkflowBinding;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors({ origin: 'http://localhost:5500', credentials: true }));

// Health Check - Verifies D1 is actually connected
app.get('/api/health', async (c) => {
  const dbCheck = await c.env.DB.prepare('SELECT 1').first();
  return c.json({ status: 'ok', database: !!dbCheck, workflow: !!c.env.ENGINE });
});

// Trigger the AI Signal Workflow (Pro Only)
app.post('/api/pro/analyze', async (c) => {
  const body = await c.req.json();
  // Trigger the durable workflow engine
  const instance = await c.env.ENGINE.create({
    params: { query: body.query, userId: 'test-user-001' }
  });
  return c.json({ success: true, workflowId: instance.id });
});

export { BanproofEngine };
export default app;
