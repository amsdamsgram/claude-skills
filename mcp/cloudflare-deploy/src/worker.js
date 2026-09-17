// MCP server + page host. One Worker, one hostname, no DNS:
//   POST /mcp          publishes a page and locks it behind Cloudflare Access
//   GET  /p/<project>  serves that page out of KV
//
// Each project gets its own path-scoped Access application, so two pages on the
// same Worker can have completely different guest lists.
//
// The Cloudflare credential lives here as a Worker secret and never reaches the
// person asking for the deploy.

const API = "https://api.cloudflare.com/client/v4";
const PROTOCOL_VERSION = "2025-06-18";
const PROJECT_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

// connect-src 'none' is the line that earns its keep: whatever else goes wrong
// inside the page, it cannot send anything out.
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

class ToolError extends Error {}

const pagePath = (project) => `/p/${project}`;
const pageUrl = (env, project) => `https://${env.PUBLIC_HOST}${pagePath(project)}`;

async function cf(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const detail = (json.errors || []).map((e) => e.message).join("; ");
    throw new ToolError(`Cloudflare API ${method} ${path} failed: ${detail || res.status}`);
  }
  return json.result;
}

function accessRules({ emails, emailDomain }) {
  if (emailDomain) return [{ email_domain: { domain: emailDomain.replace(/^@/, "") } }];
  const list = (emails || []).map((e) => e.trim()).filter(Boolean);
  if (!list.length) throw new ToolError("no email addresses given — refusing to publish without a guest list");
  return list.map((email) => ({ email: { email } }));
}

// Order matters: the lock goes up before the content does, so there is no window
// in which the page is readable by anyone holding the URL.
async function deployPrivatePage(env, { project, html, emails, email_domain, session }) {
  if (!PROJECT_RE.test(project || "")) {
    throw new ToolError(`invalid project name '${project}' — lowercase letters, digits and hyphens only`);
  }
  if (!html || !html.trim()) throw new ToolError("html is empty — nothing to publish");

  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const destination = `${env.PUBLIC_HOST}${pagePath(project)}`;
  const sessionDuration = session || "24h";
  const include = accessRules({ emails, emailDomain: email_domain });
  const who = email_domain ? `anyone @${email_domain.replace(/^@/, "")}` : emails.join(", ");

  const policyName = `${project} — allowed`;
  const policyBody = { name: policyName, decision: "allow", include };
  const policies = await cf(env, "GET", `/accounts/${account}/access/policies?per_page=200`);
  const found = policies.find((p) => p.name === policyName);
  const policyId = found
    ? (await cf(env, "PUT", `/accounts/${account}/access/policies/${found.id}`, policyBody), found.id)
    : (await cf(env, "POST", `/accounts/${account}/access/policies`, policyBody)).id;

  const appBody = {
    name: project,
    type: "self_hosted",
    destinations: [{ type: "public", uri: destination }],
    session_duration: sessionDuration,
    app_launcher_visible: false,
    auto_redirect_to_identity: false,
    policies: [{ id: policyId, precedence: 1 }],
  };
  const apps = await cf(env, "GET", `/accounts/${account}/access/apps?per_page=200`);
  const app = apps.find((a) => (a.destinations || []).some((d) => d.uri === destination));
  if (app) await cf(env, "PUT", `/accounts/${account}/access/apps/${app.id}`, appBody);
  else await cf(env, "POST", `/accounts/${account}/access/apps`, appBody);

  await env.PAGES.put(`page:${project}`, html);

  // Anonymous fetch is the real proof, but a Worker calling a path it serves
  // itself may not leave the edge. Fall back to asserting the lock exists rather
  // than reporting a success nobody checked.
  let verdict;
  try {
    const res = await fetch(pageUrl(env, project), { redirect: "follow" });
    const landed = res.url ? new URL(res.url).hostname : "";
    if (!landed) throw new ToolError("the self-request returned no final URL");
    verdict = landed.endsWith("cloudflareaccess.com")
      ? "PROTECTED — an anonymous request lands on the Cloudflare Access login."
      : `UNVERIFIED — an anonymous request ended at ${res.url} instead of the login screen. Check the Access application for ${destination} before sharing this link.`;
  } catch {
    const check = await cf(env, "GET", `/accounts/${account}/access/apps?per_page=200`);
    verdict = check.some((a) => (a.destinations || []).some((d) => d.uri === destination))
      ? "PROTECTED (indirect) — the Access application covering this path is in place; the self-request could not be made from inside the Worker."
      : `UNVERIFIED — no Access application covers ${destination}. Do not share this link.`;
  }

  return [
    verdict,
    ``,
    `  address   ${pageUrl(env, project)}`,
    `  allowed   ${who}`,
    `  session   ${sessionDuration}`,
    `  size      ${new TextEncoder().encode(html).length} bytes`,
    ``,
    `Visitors sign in with a six-digit code emailed to them. Re-run with a different`,
    `guest list to change who gets in; the policy is updated in place, not duplicated.`,
  ].join("\n");
}

const TOOLS = [
  {
    name: "deploy_private_page",
    description:
      "Publish a single self-contained HTML page behind a Cloudflare Access email login, so only the addresses you name can open it. The lock is created before the content is stored, and the result states whether an anonymous request actually lands on the login screen. Re-run with the same project to publish an update or change the guest list.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Becomes the public URL, so it is guessable and must not advertise the contents: 'tm-tool-2026', never 'exec-salaries'. Lowercase letters, digits and hyphens.",
        },
        html: { type: "string", description: "The complete HTML document to publish." },
        emails: {
          type: "array",
          items: { type: "string" },
          description: "Exact addresses allowed to sign in. The right choice for anything confidential.",
        },
        email_domain: {
          type: "string",
          description:
            "Allow everyone with an address at this domain instead of a named list. Fine for a handbook, wrong for payroll.",
        },
        session: { type: "string", description: "How long a login lasts. Defaults to 24h; use 8h for shared machines." },
      },
      required: ["project", "html"],
    },
  },
];

async function handleRpc(env, msg) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "cloudflare-deploy", version: "1.0.0" },
      };
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      if (msg.params?.name !== "deploy_private_page") {
        throw new ToolError(`unknown tool '${msg.params?.name}'`);
      }
      try {
        const text = await deployPrivatePage(env, msg.params.arguments || {});
        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
        throw err;
      }
    }
    case "ping":
      return {};
    default: {
      const e = new Error(`method not found: ${msg.method}`);
      e.code = -32601;
      throw e;
    }
  }
}

function missingConfig(env) {
  return ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PUBLIC_HOST", "MCP_SHARED_SECRET"].filter((k) => !env[k]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return new Response("MCP endpoint — POST JSON-RPC here", { status: 405 });

      // The portal in front does the user authentication; this only proves the
      // request came through it and not straight off the internet.
      const auth = request.headers.get("Authorization") || "";
      const expected = `Bearer ${env.MCP_SHARED_SECRET}`;
      if (!env.MCP_SHARED_SECRET || auth.length !== expected.length || auth !== expected) {
        return new Response("unauthorized", { status: 401 });
      }
      const gaps = missingConfig(env);
      if (gaps.length) return new Response(`worker is missing config: ${gaps.join(", ")}`, { status: 500 });

      const msg = await request.json().catch(() => null);
      if (!msg) return new Response("bad JSON", { status: 400 });
      if (msg.id === undefined) return new Response(null, { status: 202 });

      try {
        const result = await handleRpc(env, msg);
        return Response.json({ jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        return Response.json({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: err.code || -32603, message: err.message },
        });
      }
    }

    const match = url.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/);
    if (!match) return new Response("not found", { status: 404 });

    const html = await env.PAGES.get(`page:${match[1]}`);
    if (html === null) return new Response("not found", { status: 404 });

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  },
};
