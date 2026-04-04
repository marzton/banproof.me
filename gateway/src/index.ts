import { Hono } from 'hono';
import { tollBoothMiddleware } from './middleware/tollBooth.js';

type Variables = {
  poaScore: number;
};

export const app = new Hono<{ Variables: Variables }>();

// Testing public route vs private route
app.get('/public/milestones', (c) => {
  return c.json({ message: 'Public milestones data', status: 'unrestricted' });
});

// Protect all /api/ endpoints with the Toll Booth
app.use('/api/*', tollBoothMiddleware);

app.post('/api/verify', async (c) => {
  let body;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  return c.json({ message: 'Payload verified', data: body });
});

app.get('/api/data/goldshore', (c) => {
  return c.json({ 
    message: 'Gold Shore logic execution success',
    data: { drsScore: 85, recommendation: 'Approve' } 
  });
});
