import { serve } from '@hono/node-server';
import { app } from './index.js';

const parsedPort = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

serve({
  fetch: app.fetch,
  port
}, (info) => {
  console.log(`Toll Booth Gateway running at http://localhost:${info.port}`);
});
