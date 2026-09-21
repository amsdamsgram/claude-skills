# cloudflare-deploy desktop extension

The same capability as the skill, as a local MCP server — so the Cloudflare token
lives in your OS keychain instead of a conversation, and each person supplies
their own once instead of everyone sharing yours.

Requires a **Team or Enterprise plan** with Claude Desktop.

## Why this and not the skill

|  | Skill | This extension |
|---|---|---|
| Where the token lives | an env var in a sandbox wiped each session | your OS keychain, set once |
| Who has to hold it | everyone using the skill | each person their own |
| Ever pasted into chat | yes, every session | no |
| Page size limit | none | none — it reads from disk, not through the model |
| Change the guest list | republishes the content | `set_page_access`, content untouched |

The credential is declared in `manifest.json` as `sensitive`, so Claude collects
it in a masked field, stores it in the keychain, and injects it as an environment
variable when it launches the server. It is never sent to the model.

## Tools

- **`deploy_private_page`** — publish a folder or a single `.html` file behind a
  Cloudflare Access email login. The lock is created before anything is uploaded,
  and the result says whether an anonymous request really lands on the login.
- **`set_page_access`** — add or remove people on an already-published page
  without republishing it. The policy is updated in place, not duplicated.

Adding another verb is a few lines: one entry in `TOOLS`, one function. The
surface is deliberately small — a connector that forwards arbitrary Cloudflare
calls would just be the API token with extra steps.

Every Cloudflare call is still made by `deploy.sh`, which this shells out to.
There is one implementation of the lock-before-upload order, not two.

## Build

```bash
./build.sh
```

Copies `deploy.sh` in from the skill, runs the tests, and packs
`cloudflare-deploy.mcpb`. Install it by double-clicking, or from Claude Desktop
under **Settings → Extensions**.

On first run Claude asks for two values:

- **Cloudflare API token** — account-scoped custom token, exactly two
  permissions: Cloudflare Pages → Edit, and Access: Apps and Policies → Edit.
  Under Account Resources pin it to the single account you publish into.
- **Cloudflare account ID** — from the dashboard sidebar. Supplying it lets the
  token drop the Account Settings: Read permission entirely.

## Using it from Cowork

Claude Desktop bridges local MCP servers into the Cowork VM, so the tools are
available in Cowork tasks and not only in chat.

One consequence worth knowing: the server runs on your machine, not in the
sandbox. Give it the real path on disk — `/Users/you/Downloads/index.html` — not
the path of a file you attached to the task.

## Check it still works

```bash
node test.mjs
```

Drives the server over stdio against a fake `deploy.sh`. No network. Fails if the
arguments it builds are wrong, if changing the guest list starts republishing
content, or if it stops refusing an empty guest list, a bad project name or a
missing file.
