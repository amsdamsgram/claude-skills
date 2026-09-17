// Smallest check that fails if the RPC layer, the guest-list validation or the
// lock-before-content order breaks. No network: the Cloudflare API is stubbed.
import assert from "node:assert/strict";
import worker from "./src/worker.js";

const HOST = "cloudflare-deploy-mcp.example.workers.dev";
const calls = [];
const kv = new Map();
const env = {
  CLOUDFLARE_API_TOKEN: "t",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  PUBLIC_HOST: HOST,
  MCP_SHARED_SECRET: "shh",
  PAGES: {
    put: async (k, v) => void kv.set(k, v),
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
  },
};

// Stateful enough that a created Access app is visible to the next GET, which is
// what the indirect-verification fallback relies on.
const store = { policies: [], apps: [] };
let landsOnLogin = true;

globalThis.fetch = async (url, init = {}) => {
  const method = init.method || "GET";
  const { pathname } = new URL(url);
  calls.push(`${method} ${pathname}`);

  if (String(url).startsWith("https://api.cloudflare.com")) {
    const kind = pathname.includes("/access/policies") ? "policies" : "apps";
    let result = store[kind];
    if (method === "POST") {
      const item = { id: `${kind}-${store[kind].length + 1}`, ...JSON.parse(init.body) };
      store[kind].push(item);
      result = item;
    }
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  }

  const res = new Response("", { status: 200 });
  Object.defineProperty(res, "url", {
    value: landsOnLogin ? "https://team.cloudflareaccess.com/login" : String(url),
  });
  return res;
};

const rpc = (body, headers = { Authorization: "Bearer shh" }) =>
  worker.fetch(
    new Request(`https://${HOST}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );

// a request without the shared secret never reaches the tool
assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {})).status, 401);

const tools = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
assert.equal(tools.result.tools[0].name, "deploy_private_page");

// refuses to publish with no guest list
const naked = await (
  await rpc({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "deploy_private_page", arguments: { project: "ok-name", html: "<h1>hi</h1>" } },
  })
).json();
assert.equal(naked.result.isError, true);
assert.match(naked.result.content[0].text, /guest list/);
assert.equal(kv.size, 0, "nothing may be stored when the guest list is rejected");

// a name that would become someone else's URL is refused
const bad = await (
  await rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "deploy_private_page", arguments: { project: "Not Valid!", html: "x", emails: ["a@b.com"] } },
  })
).json();
assert.equal(bad.result.isError, true);

// the happy path: lock goes up before the content is stored, scoped to this path
calls.length = 0;
const ok = await (
  await rpc({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "deploy_private_page", arguments: { project: "tm-tool-2026", html: "<h1>hi</h1>", emails: ["ana@corp.com"] } },
  })
).json();
assert.ok(!ok.result.isError, ok.result?.content?.[0]?.text);
assert.match(ok.result.content[0].text, /PROTECTED/);
assert.match(ok.result.content[0].text, new RegExp(`https://${HOST}/p/tm-tool-2026`));
assert.ok(calls.some((c) => c.includes("/access/apps")), "an Access application must be created");
assert.equal(store.apps[0].destinations[0].uri, `${HOST}/p/tm-tool-2026`, "the lock must be scoped to this page's path");
assert.equal(kv.get("page:tm-tool-2026"), "<h1>hi</h1>");

// two pages on the same Worker get separate locks, so guest lists do not bleed
await rpc({
  jsonrpc: "2.0", id: 5, method: "tools/call",
  params: { name: "deploy_private_page", arguments: { project: "other-page", html: "<h1>other</h1>", emails: ["ben@corp.com"] } },
});
assert.equal(store.apps.length, 2);
assert.notEqual(store.apps[0].policies[0].id, store.apps[1].policies[0].id);

// a page that answers anonymously instead of redirecting is reported, not celebrated
landsOnLogin = false;
const leaky = await (
  await rpc({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "deploy_private_page", arguments: { project: "leaky", html: "<h1>x</h1>", emails: ["ana@corp.com"] } },
  })
).json();
assert.match(leaky.result.content[0].text, /UNVERIFIED/);
landsOnLogin = true;

// the page is served back with the headers that stop it phoning home
const served = await worker.fetch(new Request(`https://${HOST}/p/tm-tool-2026`), env);
assert.equal(served.status, 200);
assert.match(served.headers.get("content-security-policy"), /connect-src 'none'/);
assert.equal((await worker.fetch(new Request(`https://${HOST}/p/nope`), env)).status, 404);
assert.equal((await worker.fetch(new Request(`https://${HOST}/`), env)).status, 404);

console.log("all checks passed");
