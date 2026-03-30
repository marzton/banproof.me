export interface Env {
  INFRA_SECRETS: KVNamespace;
  // If we audit Cloudflare later, we'll need the CF API token here too
  // CF_API_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Only allow triggering the audit from a specific path
    if (url.pathname !== '/run-audit') {
      return new Response('Audit endpoint is /run-audit', { status: 404 });
    }

    try {
      // 1. Retrieve the exact GitHub Personal Access Token from the KV Namespace
      const ghPat = await env.INFRA_SECRETS.get('GH_PAT');

      if (!ghPat) {
        return new Response('CRITICAL ERR: GH_PAT not found in KV Namespace.', { status: 500 });
      }

      // 2. Audit GitHub Account & Repository Settings (Simulating basic GitHub API calls)
      const ghHeaders = {
        'Authorization': `token ${ghPat}`,
        'User-Agent': 'banproof-auditor',
        'Accept': 'application/vnd.github.v3+json'
      };

      const [userResponse, reposResponse] = await Promise.all([
        fetch('https://api.github.com/user', { headers: ghHeaders }),
        fetch('https://api.github.com/user/repos?visibility=all&sort=updated', { headers: ghHeaders })
      ]);

      const ghUser = await userResponse.json();
      const ghRepos = await reposResponse.json();

      // Placeholder for Cloudflare Audit metrics 
      // (Requires fetching against https://api.cloudflare.com/client/v4/zones using a CF_API_TOKEN)
      const cfAuditNotes = "Cloudflare API token not yet bound. Domains/Workers audit pending Lead Admin approval.";

      const auditReport = {
        timestamp: new Date().toISOString(),
        github: {
          accountStatus: userResponse.ok ? `Authenticated as ${ghUser.login}` : 'Auth Failed',
          repoCount: Array.isArray(ghRepos) ? ghRepos.length : 0,
          settingsMismatches: "Scan initialized...", // Add specific configuration audits here
        },
        cloudflare: {
          status: cfAuditNotes
        }
      };

      return new Response(JSON.stringify(auditReport, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (err: any) {
      return new Response(`Audit Execution Failed: ${err.message}`, { status: 500 });
    }
  }
};
