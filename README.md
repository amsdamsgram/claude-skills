# claude-skills

Claude skills, installable as a marketplace.

## Install

**Claude Code**

```bash
/plugin marketplace add amsdamsgram/claude-skills
/plugin install cloudflare-deploy
```

**Claude / Cowork**

Customize → Plugins → Add from a repository →
`https://github.com/amsdamsgram/claude-skills` → install **cloudflare-deploy**.

## Skills

### cloudflare-deploy

Publishes a folder of static files — or a single `.html` file — to Cloudflare
Pages, with a Cloudflare Access email login in front of it. Only the addresses
you name can open the page. Visitors sign in with a six-digit code emailed to
them; there is no password to hand out.

The lock is created *before* the files are uploaded, so the content is never
briefly public, and the skill fetches the finished URL anonymously to prove the
redirect to the login works before reporting success.

Needs a Cloudflare API token in the environment:

```bash
export CLOUDFLARE_API_TOKEN=...   # Account scope: Pages:Edit, Access: Apps and Policies:Edit
export CLOUDFLARE_ACCOUNT_ID=...
```

Full setup, flags and gotchas: [SKILL.md](plugins/cloudflare-deploy/skills/cloudflare-deploy/SKILL.md).

> **Claude / Cowork note:** the sandbox is destroyed at the end of every session,
> so there is nowhere to keep that token — it would have to be pasted into the
> conversation each time. If that is your situation, use the connector instead
> [mcp/cloudflare-deploy](mcp/cloudflare-deploy), which keeps the credential server-side.

## Connector

[mcp/cloudflare-deploy](mcp/cloudflare-deploy) is the same capability as a remote
MCP server, for people who should never handle a Cloudflare token — the credential
stays in the Worker and users sign in through Cloudflare Access.

## Desktop extension

[extension/](extension) packages the same capability as a local MCP server for
Claude Desktop (Team and Enterprise plans). The Cloudflare token goes in your OS
keychain instead of a conversation, each person supplies their own, and because
the server reads files from disk there is no size limit on what you publish.
