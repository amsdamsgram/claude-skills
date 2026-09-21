---
name: cloudflare-deploy
description: Publish a static site — a folder, or a single HTML file — to Cloudflare Pages behind a Cloudflare Access email login. Use when the user wants to deploy, host or put online a page, site, report, dashboard or internal tool, especially privately or for named people only; put something behind a login or password; or asks about Cloudflare Pages plus Access. Also handles changing who is allowed in and re-deploying an update. Asks for anything it is missing before touching the account.
---

# Private page on Cloudflare

Publishes a folder of static files to Cloudflare Pages and puts a Cloudflare Access
login in front of it, so only named email addresses can open it. Free on
Cloudflare's Zero Trust free tier. Visitors sign in with a six-digit code emailed
to them — no password to distribute, no SSO to configure.

`deploy.sh` does the whole thing and is safe to re-run.

## Never publish it another way

The point of this skill is that the page is locked before it is readable. A plain
`wrangler deploy`, a Workers static-assets upload or a dashboard drag-and-drop
puts it online with no login at all — for a page worth protecting that is worse
than not deploying. If `deploy.sh` cannot run, stop and say why. Do not reach for
another route, and do not fall back to a public URL.

A missing `CLOUDFLARE_API_TOKEN` is not a reason to improvise. On a host whose
sandbox is wiped between sessions there is nowhere to keep one, so ask for the
token and the account id, export them for this session, and carry on:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

If they pasted it into a conversation, tell them to revoke it once the deploy is
done — chat history is not a secret store.

## Order of operations (why the script exists)

The dashboard route publishes first and locks afterwards, which leaves the page
readable by anyone who has the URL for as long as that takes. The script reverses
it:

1. Create the Pages project — reserves `<project>.pages.dev`, serves nothing yet
2. Create the Access policy (who is allowed)
3. Create the Access application (the lock), covering the live site **and** every preview deployment
4. Only then upload the files
5. Fetch the URL anonymously and assert it redirects to `cloudflareaccess.com`

There is no window in which the content is public. Step 5 is the part that
matters — never report success without it.

## Gather the three inputs first

"Deploy this site on Cloudflare" is a complete request. Never guess the missing
pieces and never run with placeholders — this publishes to the open internet under
a name the user has to live with.

**Step 1 — take what the conversation already gives you.** A path the user named,
a file just written, a list of colleagues already discussed. Do not re-ask for it.

**Step 2 — ask for the rest in one turn**, one question per missing item, each with
concrete options drawn from the actual situation and room for a free-text answer.
Use an `AskUserQuestion`-style tool if the host offers one; otherwise ask them
together as a short numbered list and wait for a single reply:

| Missing | How to ask |
|---|---|
| What to publish | Offer the real candidates: files and folders in the working directory. A single `.html` file is fine — the script stages it as `index.html`. |
| Project name | Propose two or three **neutral** names. It becomes the public hostname and is guessable, so it must not advertise the contents: `tm-tool-2026`, never `exec-salaries`. Say that in the question. |
| Who gets in | Offer: just the user (their own address), a named list, or everyone at one domain. Warn in the option text that a whole domain is wrong for anything confidential. |

Add session duration as a fourth question only if the content is sensitive —
otherwise `24h` is a fine default and one fewer thing to answer.

**Step 3 — open the page and look before confirming.** Read what is actually being
published. Two things to raise, because the login fixes neither:

- **Anything in the folder is served**, linked or not: old drafts, `.DS_Store`, a
  stray spreadsheet, a key in a comment. List the files you are about to upload so
  the user sees them.
- **Anything the page loads from another domain** hands that domain every
  visitor's IP. In the EU that is a live data-protection question. Say so and
  offer to self-host them first.

**Step 4 — confirm, then run.** Show the summary and wait for an explicit yes:

```
  publishing   valeo-pay-positioning_5.html  (1.4 MB, staged as index.html)
  address      https://tm-tool-2026.pages.dev
  allowed      ana@corp.com, ben@corp.com
  session      24h
```

Only the deploy needs the gate. Re-running later to publish an update to an
existing project is routine — just say what you are doing.

## Setup (once per machine)

Create the token at **My Profile › API Tokens › Create Token › Custom token**.
All permissions are **Account**-scoped, not Zone. Two are required:

| Permission | Level | Pays for |
|---|---|---|
| Cloudflare Pages | Edit | Creating the project and uploading the files |
| Access: Apps and Policies | Edit | The lock and the guest list |

Two more are optional, and skipping them is the better choice — a token that can
publish a page should not also be able to read your account settings:

| Permission | Level | Only needed if |
|---|---|---|
| Account Settings | Read | You do not set `CLOUDFLARE_ACCOUNT_ID`, so the script has to look the account up |
| Access: Organizations, Identity Providers, and Groups | Read | You want the up-front check that a login method exists; without it that step is skipped with a note |

Under **Account Resources**, scope the token to the single account you deploy
into rather than "All accounts".

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...   # drop the Account Settings:Read scope by setting this
```

The account also needs a login method enabled at **Zero Trust › Settings ›
Authentication › Login methods**. One-time PIN needs no configuration. The script
warns if none is present rather than silently creating a lock nobody can open.

## Running it

Paths below are relative to this skill's own folder — run them from there, or
prefix with wherever the skill is installed.

```bash
# a named handful — the right choice for anything confidential
./deploy.sh \
  --dir ./site --project tm-tool-2026 \
  --emails "ana@corp.com,ben@corp.com"

# a single self-contained page, staged as index.html
./deploy.sh \
  --dir ./report.html --project q3-review-x9 \
  --emails "ana@corp.com" --session 8h

# everyone at the company — fine for a handbook, wrong for payroll
./deploy.sh \
  --dir ./site --project team-handbook \
  --email-domain corp.com
```

| Flag | Default | Notes |
|---|---|---|
| `--dir` | — | A folder containing `index.html` (assets by relative path), or a single `.html` file, which is staged into a temporary folder as `index.html`. |
| `--project` | — | Lowercase letters, digits, hyphens. Becomes the hostname. |
| `--emails` | — | Comma-separated. Exact addresses only. |
| `--email-domain` | — | Everyone with an address at this domain. |
| `--session` | `24h` | `8h` for shared or hot-desk machines. |
| `--branch` | `main` | Production branch name. |

Re-running is the way to do everything else:

- **Publish an update** — same command, same project. The lock is left alone.
- **Change who is allowed** — same command with a different `--emails`. The
  existing policy is updated in place, not duplicated. Add `--skip-upload` to
  change the guest list alone, leaving the published content untouched; `--dir`
  is not needed then.

Removing someone takes effect when their session expires. To cut access
immediately, re-run with them removed *and* a short `--session`, then restore it.

## Gotchas this handles for you

- **The `*` subdomain trap.** In the dashboard, the Pages "Enable access policy"
  toggle protects only preview deployments; the live URL stays open until you
  delete the wildcard from the app's Subdomain field. The script sets both
  destinations explicitly, so the trap does not apply.
- **Duplicate policies.** Matching is by policy name and by destination hostname,
  so re-runs update rather than pile up.

## Not handled

- **Custom domains.** Add the domain to the project *first*, then create a
  separate Access application for it — Cloudflare refuses to attach a domain to a
  project that already carries a policy, and a domain added in the wrong order
  renders a login screen that does not actually protect anything. Do that part in
  the dashboard.
- **Security headers.** Drop a `_headers` file in the folder before deploying:

  ```
  /*
    Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
  ```

  `connect-src 'none'` is the line that earns its keep: it stops the page sending
  data anywhere, whatever else goes wrong inside it.

## Limits

Pages serves files up to 25 MB each and does not charge for traffic. Cloudflare's
free Zero Trust plan covers a small team — check the current seat count before
adding a large group. A login is an access control, not a substitute for whatever
data-protection assessment the data inside the page requires.
