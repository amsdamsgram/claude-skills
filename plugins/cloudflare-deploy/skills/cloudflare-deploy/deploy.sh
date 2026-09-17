#!/usr/bin/env bash
# Publish a static folder to Cloudflare Pages behind a Cloudflare Access login.
# Order matters: the project (and its hostname) is reserved and locked BEFORE any
# content is uploaded, so the page is never reachable without a login.
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
DIR="" PROJECT="" EMAILS="" EMAIL_DOMAIN="" SESSION="24h" BRANCH="main"

usage() {
  cat >&2 <<'USAGE'
usage: deploy.sh --dir <folder|page.html> --project <name>
                 (--emails a@x.com,b@x.com | --email-domain x.com)
                 [--session 24h] [--branch main]

env: CLOUDFLARE_API_TOKEN   (required)
     CLOUDFLARE_ACCOUNT_ID  (required only if the token sees several accounts)

token scopes (account-scoped): Cloudflare Pages:Edit, Access: Apps and Policies:Edit
optional:  Account Settings:Read (only without CLOUDFLARE_ACCOUNT_ID)
           Access: Organizations, Identity Providers, and Groups:Read (login-method check)
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          DIR="$2"; shift 2 ;;
    --project)      PROJECT="$2"; shift 2 ;;
    --emails)       EMAILS="$2"; shift 2 ;;
    --email-domain) EMAIL_DOMAIN="$2"; shift 2 ;;
    --session)      SESSION="$2"; shift 2 ;;
    --branch)       BRANCH="$2"; shift 2 ;;
    -h|--help)      usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$DIR" ] && [ -n "$PROJECT" ] || usage
[ -n "$EMAILS" ] || [ -n "$EMAIL_DOMAIN" ] || { echo "need --emails or --email-domain" >&2; usage; }
# A lone .html file is staged into a folder as index.html — the everyday case of
# "put this one page online". Nothing else from its directory comes along.
STAGED=""
cleanup() { if [ -n "$STAGED" ]; then rm -rf "$STAGED"; fi; }
trap cleanup EXIT

if [ -f "$DIR" ]; then
  case "$DIR" in
    *.html|*.htm) ;;
    *) echo "--dir takes a folder, or a single .html file — got: $DIR" >&2; exit 2 ;;
  esac
  STAGED=$(mktemp -d)
  cp "$DIR" "$STAGED/index.html"
  echo "staged $(basename "$DIR") as index.html"
  DIR="$STAGED"
fi

[ -d "$DIR" ] || { echo "not a folder or .html file: $DIR" >&2; exit 2; }
[ -f "$DIR/index.html" ] || { echo "no index.html in $DIR — Pages needs one to serve" >&2; exit 2; }

# Pages project names: lowercase letters, digits and hyphens.
case "$PROJECT" in
  *[!a-z0-9-]*) echo "project name must be lowercase letters, digits and hyphens only" >&2; exit 2 ;;
esac

# Environment last: the inputs above are worth checking even on a machine that
# has not been set up yet.
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "CLOUDFLARE_API_TOKEN is not set" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

api() { # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}" resp
  if [ -n "$body" ]; then
    resp=$(curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" --data "$body")
  else
    resp=$(curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
  fi
  if [ "$(jq -r '.success' <<<"$resp")" != "true" ]; then
    echo "API $method $path failed:" >&2
    jq -r '.errors[]? | "  [\(.code)] \(.message)"' <<<"$resp" >&2
    return 1
  fi
  printf '%s' "$resp"
}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- account id
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  ACCOUNT="$CLOUDFLARE_ACCOUNT_ID"
else
  # Needs the Account Settings:Read scope. Setting CLOUDFLARE_ACCOUNT_ID instead
  # lets the token skip that permission entirely.
  accounts=$(api GET "/accounts?per_page=50") || {
    echo "could not list accounts — either add the Account Settings:Read scope" >&2
    echo "to the token, or set CLOUDFLARE_ACCOUNT_ID and skip this lookup." >&2
    exit 2
  }
  n=$(jq '.result | length' <<<"$accounts")
  if [ "$n" -ne 1 ]; then
    echo "token sees $n accounts — set CLOUDFLARE_ACCOUNT_ID to pick one:" >&2
    jq -r '.result[] | "  \(.id)  \(.name)"' <<<"$accounts" >&2
    exit 2
  fi
  ACCOUNT=$(jq -r '.result[0].id' <<<"$accounts")
fi
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"
say "Account $ACCOUNT"

# ------------------------------------------------- 1. reserve the hostname
# A project with no deployment serves nothing, so this is safe to do first.
say "1/5  Pages project"
if api GET "/accounts/$ACCOUNT/pages/projects/$PROJECT" >/dev/null 2>&1; then
  echo "     '$PROJECT' already exists — reusing it"
else
  api POST "/accounts/$ACCOUNT/pages/projects" \
    "$(jq -nc --arg n "$PROJECT" --arg b "$BRANCH" '{name:$n, production_branch:$b}')" >/dev/null
  echo "     created '$PROJECT'"
fi
HOST="$PROJECT.pages.dev"

# ------------------------------------------------- 2. one-time PIN sanity check
say "2/5  Login method"
# Advisory only. Needs the Access: Organizations, Identity Providers, and Groups
# :Read scope, which is not worth making mandatory — a token without it still
# deploys, it just cannot tell you in advance whether anyone can sign in.
if idps=$(api GET "/accounts/$ACCOUNT/access/identity_providers" 2>/dev/null); then
  if [ "$(jq '[.result[] | select(.type=="onetimepin")] | length' <<<"$idps")" -eq 0 ]; then
    cat >&2 <<EOF
     WARNING: no one-time PIN login method on this account.
     Nobody will be able to sign in until you enable a login method at
     Zero Trust > Settings > Authentication > Login methods.
     Continuing — the lock will still be created.
EOF
  else
    echo "     one-time PIN is available"
  fi
else
  echo "     skipped (token cannot read identity providers) — confirm a login"
  echo "     method exists at Zero Trust > Settings > Authentication"
fi

# ------------------------------------------------- 3. who is allowed in
say "3/5  Access policy"
if [ -n "$EMAILS" ]; then
  INCLUDE=$(jq -nc --arg csv "$EMAILS" \
    '$csv | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length>0)) | map({email:{email:.}})')
  WHO=$(jq -r 'map(.email.email) | join(", ")' <<<"$INCLUDE")
else
  INCLUDE=$(jq -nc --arg d "${EMAIL_DOMAIN#@}" '[{email_domain:{domain:$d}}]')
  WHO="anyone @${EMAIL_DOMAIN#@}"
fi
[ "$(jq 'length' <<<"$INCLUDE")" -gt 0 ] || { echo "no valid email rules parsed" >&2; exit 2; }

POLICY_NAME="$PROJECT — allowed"
existing=$(api GET "/accounts/$ACCOUNT/access/policies?per_page=200")
POLICY_ID=$(jq -r --arg n "$POLICY_NAME" 'first(.result[] | select(.name==$n) | .id) // empty' <<<"$existing")

POLICY_BODY=$(jq -nc --arg n "$POLICY_NAME" --argjson inc "$INCLUDE" \
  '{name:$n, decision:"allow", include:$inc}')

if [ -n "$POLICY_ID" ]; then
  api PUT "/accounts/$ACCOUNT/access/policies/$POLICY_ID" "$POLICY_BODY" >/dev/null
  echo "     updated policy — $WHO"
else
  POLICY_ID=$(api POST "/accounts/$ACCOUNT/access/policies" "$POLICY_BODY" | jq -r '.result.id')
  echo "     created policy — $WHO"
fi

# ------------------------------------------------- 4. the lock itself
# Both destinations in one app: the live site and every preview deployment.
say "4/5  Access application"
APP_BODY=$(jq -nc \
  --arg name "$PROJECT" --arg host "$HOST" --arg sess "$SESSION" --arg pid "$POLICY_ID" \
  '{
     name: $name,
     type: "self_hosted",
     destinations: [ {type:"public", uri:$host}, {type:"public", uri:("*." + $host)} ],
     session_duration: $sess,
     app_launcher_visible: false,
     auto_redirect_to_identity: false,
     policies: [ {id:$pid, precedence:1} ]
   }')

apps=$(api GET "/accounts/$ACCOUNT/access/apps?per_page=200")
APP_ID=$(jq -r --arg h "$HOST" \
  'first(.result[] | select((.destinations // []) | any(.uri == $h)) | .id) // empty' <<<"$apps")

if [ -n "$APP_ID" ]; then
  api PUT "/accounts/$ACCOUNT/access/apps/$APP_ID" "$APP_BODY" >/dev/null
  echo "     updated lock on $HOST and *.$HOST"
else
  APP_ID=$(api POST "/accounts/$ACCOUNT/access/apps" "$APP_BODY" | jq -r '.result.id')
  echo "     locked $HOST and *.$HOST"
fi

# ------------------------------------------------- 5. now the content
say "5/5  Uploading $DIR"
npx -y wrangler@latest pages deploy "$DIR" \
  --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty true

# ------------------------------------------------- verify the door is shut
say "Verifying"
sleep 5
code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-redirs 5 "https://$HOST/")
final=$(curl -s -o /dev/null -w '%{url_effective}' -L --max-redirs 5 "https://$HOST/")

if [[ "$final" == *cloudflareaccess.com* ]]; then
  printf '\n\033[32m  PROTECTED\033[0m  https://%s\n' "$HOST"
  echo   "  Anonymous visitors land on the login screen."
  echo   "  Allowed: $WHO"
  echo   "  Session: $SESSION"
  echo
  echo   "  Test it yourself in a private window before sharing the link."
else
  printf '\n\033[31m  NOT PROTECTED — an anonymous request reached %s (HTTP %s)\033[0m\n' "$final" "$code"
  echo   "  DNS or the Access rule may still be propagating. Re-run this check in a minute:"
  echo   "    curl -sI -o /dev/null -w '%{url_effective}\\n' -L https://$HOST/"
  echo   "  If it still is not redirecting to cloudflareaccess.com, do NOT share the link."
  exit 1
fi
