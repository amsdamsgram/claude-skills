// Local MCP server over stdio. The Cloudflare token arrives as an environment
// variable that Claude injects from the OS keychain, so it never appears in a
// conversation and never has to be handed to each person using this.
//
// Every Cloudflare call lives in deploy.sh, which this only ever shells out to —
// there is one implementation of the lock-before-upload order, not two.

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const PROTOCOL_VERSION = "2025-06-18";
const DEPLOY = path.join(__dirname, "deploy.sh");
const PROJECT_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...a) => process.stderr.write(a.join(" ") + "\n");

class ToolError extends Error {}

function guestListArgs({ emails, email_domain }) {
  if (email_domain) return ["--email-domain", String(email_domain).replace(/^@/, "")];
  const list = (emails || []).map((e) => String(e).trim()).filter(Boolean);
  if (!list.length) throw new ToolError("no email addresses given — refusing to touch the guest list without one");
  return ["--emails", list.join(",")];
}

function runDeploy(args) {
  return new Promise((resolve) => {
    const child = spawn("bash", [DEPLOY, ...args], {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "",
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || "",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: 1, out: `could not run deploy.sh: ${err.message}` }));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

// ANSI escapes are for a terminal; they only add noise in a chat transcript.
const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function deployPrivatePage({ path: target, project, emails, email_domain, session, branch }) {
  if (!PROJECT_RE.test(project || "")) {
    throw new ToolError(`invalid project name '${project}' — lowercase letters, digits and hyphens only`);
  }
  if (!target) throw new ToolError("path is required — the folder or .html file to publish");
  if (!fs.existsSync(target)) {
    throw new ToolError(`no such file or folder: ${target}. This runs on the local machine, so give the real path on disk, not a path inside a sandbox.`);
  }
  const args = ["--dir", target, "--project", project, ...guestListArgs({ emails, email_domain })];
  if (session) args.push("--session", session);
  if (branch) args.push("--branch", branch);
  return runDeploy(args);
}

async function setPageAccess({ project, emails, email_domain, session }) {
  if (!PROJECT_RE.test(project || "")) {
    throw new ToolError(`invalid project name '${project}' — lowercase letters, digits and hyphens only`);
  }
  const args = ["--skip-upload", "--project", project, ...guestListArgs({ emails, email_domain })];
  if (session) args.push("--session", session);
  return runDeploy(args);
}

const guestListProps = {
  emails: {
    type: "array",
    items: { type: "string" },
    description: "Exact addresses allowed to sign in. The right choice for anything confidential.",
  },
  email_domain: {
    type: "string",
    description: "Allow everyone with an address at this domain instead of a named list. Fine for a handbook, wrong for payroll.",
  },
  session: { type: "string", description: "How long a login lasts. Defaults to 24h; use 8h for shared machines." },
};

const TOOLS = [
  {
    name: "deploy_private_page",
    description:
      "Publish a folder, or a single .html file, to Cloudflare Pages behind a Cloudflare Access email login. The lock is created before anything is uploaded, and the result says whether an anonymous request actually lands on the login screen. Re-run with the same project to publish an update. Reads the file from this machine's disk, so there is no size limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path on this machine to the folder, or to a single .html file." },
        project: {
          type: "string",
          description:
            "Becomes the public hostname <project>.pages.dev, so it is guessable and must not advertise the contents: 'tm-tool-2026', never 'exec-salaries'.",
        },
        ...guestListProps,
        branch: { type: "string", description: "Production branch name. Defaults to main." },
      },
      required: ["path", "project"],
    },
  },
  {
    name: "set_page_access",
    description:
      "Change who can open an already-published page — add someone, remove someone, or swap a named list for a whole domain — without republishing the content. The policy is updated in place rather than duplicated. Removing someone takes effect when their current session expires.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The existing project name." },
        ...guestListProps,
      },
      required: ["project"],
    },
  },
];

const HANDLERS = { deploy_private_page: deployPrivatePage, set_page_access: setPageAccess };

async function handle(msg) {
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
      const fn = HANDLERS[msg.params?.name];
      if (!fn) throw new ToolError(`unknown tool '${msg.params?.name}'`);
      try {
        if (!process.env.CLOUDFLARE_API_TOKEN) {
          throw new ToolError("no Cloudflare API token configured — set it in the extension's settings, where it is kept in the OS keychain");
        }
        const { code, out } = await fn(msg.params.arguments || {});
        return { content: [{ type: "text", text: clean(out) || "(no output)" }], isError: code !== 0 };
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

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("ignoring unparseable line");
      continue;
    }
    if (msg.id === undefined) continue; // a notification; nothing to answer

    try {
      send({ jsonrpc: "2.0", id: msg.id, result: await handle(msg) });
    } catch (err) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: err.code || -32603, message: err.message } });
    }
  }
});
