import { MiddlewareHandler } from 'hono';
import { validateProofOfAgency } from '../validators/proofOfAgency.js';

export const tollBoothMiddleware: MiddlewareHandler = async (c: any, next: any) => {
  console.log(`[Toll Booth] Intercepted ${c.req.method} request to ${c.req.url}`);
  
  const authHeader = c.req.header('Authorization');
  const nodeIp = c.req.header('X-Forwarded-For') || 'unknown';

  // Extract token
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return c.json({ error: 'Unauthorized. The Toll Booth requires payment or valid PoA token.' }, 401);
  }

  // Check Proof of Agency Validation
  const poaResult = validateProofOfAgency({ ip: nodeIp, token });
  
  if (!poaResult.isValid) {
    console.warn(`[Toll Booth] Rejected request. Match failed: ${poaResult.reason}`);
    return c.json({ error: `Proof of Agency failure: ${poaResult.reason}` }, 403);
  }

  // Log successful "Sponsorship Guardrail" signal filtering
  console.log(`[Toll Booth] Signal accepted. Risk Level: ${poaResult.riskLevel}`);
  
  // Custom headers to pass on to the handler downstream
  c.set('poaScore', poaResult.score);

  await next();
};
