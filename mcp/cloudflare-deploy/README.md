# cloudflare-deploy-mcp

A connector that publishes a private page for someone who never sees a Cloudflare
credential. The API token lives in this Worker as a secret; the person asking for
the deploy just talks to Claude.

Why this exists: the Cowork sandbox is destroyed at the end of every session, so a
skill running there has nowhere to keep a token — it would have to be pasted into
the conversation each time. A connector moves the credential server-side.

## What it does

One tool, `deploy_private_page(project, html, emails, email_domain?, session?)`:

1. Creates or updates the Cloudflare Access policy — the guest list
2. Creates or updates the Access application on `<project>.<PAGES_DOMAIN>` — the lock
3. **Then** stores the HTML in KV
4. Fetches the URL anonymously and reports whether it actually lands on the login

The lock goes up before the content does, so there is no window in which the page
is readable by anyone holding the URL. Step 4 is the part that matters — the tool
says `UNVERIFIED` rather than claiming a success nobody checked.

The same Worker serves the stored page on `<project>.<PAGES_DOMAIN>` with
`connect-src 'none'`, so whatever else goes wrong inside the page, it cannot send
anything out.

## What you need first

- A domain on your Cloudflare account. Access applications attach to a hostname in
  a zone you control, which is what makes the login real.
- Zero Trust enabled, with a login method at **Settings › Authentication**.
  One-time PIN needs no configuration and is what sends the six-digit codes.

## Setup

```bash
npx wrangler kv namespace create PAGES     # put the id in wrangler.jsonc
```

Edit `wrangler.jsonc`: replace `share.example.com` with your subdomain, `example.com`
with your zone, and the KV id.

Create the API token at **My Profile › API Tokens › Custom token**, scoped to the
single account you deploy into. It needs exactly one permission — Account level,
**Access: Apps and Policies → Edit**. Nothing else. It cannot read your account,
touch DNS, or serve anything.

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
openssl rand -hex 32 | npx wrangler secret put MCP_SHARED_SECRET
npx wrangler deploy
```

`MCP_SHARED_SECRET` is not user authentication. It only proves a request arrived
through the portal instead of straight off the internet.

## Putting a login in front of the connector

The Worker's MCP endpoint holds a credential that can create Access applications,
so it must not be reachable by anyone who learns the URL.

In **Cloudflare One › AI Controls › MCP server portals**, create a portal, add this
Worker as an upstream server (`https://deploy.<PAGES_DOMAIN>`) with bearer-token
auth set to your `MCP_SHARED_SECRET`, and attach an Access policy listing the people
allowed to use it. The portal returns a `401` with OAuth discovery metadata, Claude
follows it, and the user signs in through Access — the same six-digit email code
their readers get.

Then in Claude or Cowork: **Customize › Connectors › +**, name it, paste the portal
URL. Nobody types a token at any point.

> Attach the Access policy to the portal, not to `*.<PAGES_DOMAIN>`. A wildcard
> application would also cover the MCP hostname and block the portal's own calls.

## Check it still works

```bash
node test.mjs
```

Runs offline against a stubbed Cloudflare API. Fails if the guest-list validation,
the project-name validation, the lock-before-content order, the response headers,
or the honest `UNVERIFIED` verdict break.

## Ceiling

One self-contained HTML document per project — the page travels through the model's
context as a tool argument, so this suits reports and dashboards, not asset-heavy
folders. For those, use the `cloudflare-deploy` skill with a local token instead.
