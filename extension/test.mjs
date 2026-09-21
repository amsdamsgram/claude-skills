// Drives the server over stdio against a fake deploy.sh, so the arguments it
// builds are checked without touching Cloudflare.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cf-ext-"));
fs.copyFileSync(path.join(here, "server/index.js"), path.join(sandbox, "index.js"));
fs.writeFileSync(path.join(sandbox, "deploy.sh"), '#!/usr/bin/env bash\necho "ARGS: $*"\n');
fs.chmodSync(path.join(sandbox, "deploy.sh"), 0o755);

const page = path.join(sandbox, "page.html");
fs.writeFileSync(page, "<h1>hi</h1>");

const server = spawn("node", [path.join(sandbox, "index.js")], {
  env: { ...process.env, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" },
});
server.stderr.on("data", () => {});

const pending = new Map();
let buf = "";
server.stdout.setEncoding("utf8");
server.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let id = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const mine = ++id;
    pending.set(mine, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
  });

const init = await rpc("initialize", {});
assert.equal(init.result.serverInfo.name, "cloudflare-deploy");

const list = await rpc("tools/list", {});
assert.deepEqual(list.result.tools.map((t) => t.name), ["deploy_private_page", "set_page_access"]);

// a publish passes the path, the project and the guest list straight through
const ok = await rpc("tools/call", {
  name: "deploy_private_page",
  arguments: { path: page, project: "tm-tool-2026", emails: ["ana@corp.com", " ben@corp.com "], session: "8h" },
});
assert.ok(!ok.result.isError, ok.result.content[0].text);
const args = ok.result.content[0].text;
assert.match(args, new RegExp(`--dir ${page}`));
assert.match(args, /--project tm-tool-2026/);
assert.match(args, /--emails ana@corp\.com,ben@corp\.com/);
assert.match(args, /--session 8h/);

// changing the guest list must not republish the content
const acl = await rpc("tools/call", {
  name: "set_page_access",
  arguments: { project: "tm-tool-2026", email_domain: "@corp.com" },
});
assert.match(acl.result.content[0].text, /--skip-upload/);
assert.match(acl.result.content[0].text, /--email-domain corp\.com/);
assert.doesNotMatch(acl.result.content[0].text, /--dir/);

// refusals: no guest list, bad project name, missing file
for (const [args_, pattern] of [
  [{ path: page, project: "ok-name" }, /guest list/],
  [{ path: page, project: "Not Valid!", emails: ["a@b.com"] }, /invalid project name/],
  [{ path: "/nope/missing.html", project: "ok-name", emails: ["a@b.com"] }, /no such file/],
]) {
  const r = await rpc("tools/call", { name: "deploy_private_page", arguments: args_ });
  assert.equal(r.result.isError, true, JSON.stringify(args_));
  assert.match(r.result.content[0].text, pattern);
}

server.kill();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log("all checks passed");
