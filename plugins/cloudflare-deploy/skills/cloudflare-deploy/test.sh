#!/usr/bin/env bash
# Offline checks for deploy.sh — argument validation and the two JSON payload
# builders. Makes no network calls. Run after editing deploy.sh.
set -uo pipefail
cd "$(dirname "$0")"
fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n'  "$1"; fail=1; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1"; printf '        want: %s\n        got:  %s\n' "$3" "$2"; fi; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/site"; echo '<h1>hi</h1>' > "$tmp/site/index.html"
mkdir -p "$tmp/empty"
echo '<h1>one page</h1>' > "$tmp/report.html"
echo 'not html'          > "$tmp/notes.txt"

echo "argument validation (must refuse before touching the network)"

# each of these must exit non-zero with no API token set
run() { CLOUDFLARE_API_TOKEN="" ./deploy.sh "$@" >/dev/null 2>&1; echo $?; }
check "no args"                "$(run)"                                                   2
check "missing --emails"       "$(run --dir "$tmp/site" --project ok-name)"               2
check "folder without index"   "$(run --dir "$tmp/empty" --project ok-name --emails a@b.c)" 2
check "folder does not exist"  "$(run --dir "$tmp/nope" --project ok-name --emails a@b.c)"  2
check "uppercase project name" "$(run --dir "$tmp/site" --project Bad_Name --emails a@b.c)" 2
check "unknown flag"           "$(run --dir "$tmp/site" --project ok-name --wat 1)"        2
check "non-html single file"   "$(run --dir "$tmp/notes.txt" --project ok-name --emails a@b.c)" 2

# with valid args the only thing stopping it must be the absent token
out=$(CLOUDFLARE_API_TOKEN="" ./deploy.sh --dir "$tmp/site" --project ok-name --emails a@b.c 2>&1); rc=$?
check "valid args reach the token check" "$rc" 2
case "$out" in *CLOUDFLARE_API_TOKEN*) ok "and say so";; *) bad "and say so — got: $out";; esac

echo
echo "single .html file is staged as index.html"

# the token check sits after staging, so a valid single file must get past the
# .html gate and fail on the token instead
out=$(CLOUDFLARE_API_TOKEN="" ./deploy.sh --dir "$tmp/report.html" --project ok-name --emails a@b.c 2>&1); rc=$?
check "single .html accepted" "$rc" 2
case "$out" in *"staged report.html as index.html"*) ok "announces the staging";;
               *) bad "announces the staging — got: $out";; esac
case "$out" in *"no index.html"*) bad "must not complain about a missing index.html";;
               *) ok "no bogus index.html complaint";; esac

# the staging directory must not survive the run
before=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'tmp.*' 2>/dev/null | wc -l | tr -d ' ')
CLOUDFLARE_API_TOKEN="" ./deploy.sh --dir "$tmp/report.html" --project ok-name --emails a@b.c >/dev/null 2>&1 || true
after=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'tmp.*' 2>/dev/null | wc -l | tr -d ' ')
check "staging dir cleaned up on exit" "$after" "$before"

echo
echo "payload shapes (must match the Cloudflare Access schema)"

# --emails: trims whitespace, drops blanks, one {email:{email}} per address
inc=$(jq -nc --arg csv " ana@corp.com , ben@corp.com ,, " \
  '$csv | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length>0)) | map({email:{email:.}})')
check "include (emails)" "$inc" '[{"email":{"email":"ana@corp.com"}},{"email":{"email":"ben@corp.com"}}]'

# --email-domain: a leading @ is tolerated and stripped
d="@corp.com"
inc=$(jq -nc --arg d "${d#@}" '[{email_domain:{domain:$d}}]')
check "include (domain)" "$inc" '[{"email_domain":{"domain":"corp.com"}}]'

# the app must lock the live host AND every preview host, or previews stay open
app=$(jq -nc --arg name p --arg host p.pages.dev --arg sess 24h --arg pid PID \
  '{name:$name,type:"self_hosted",
    destinations:[{type:"public",uri:$host},{type:"public",uri:("*." + $host)}],
    session_duration:$sess,app_launcher_visible:false,auto_redirect_to_identity:false,
    policies:[{id:$pid,precedence:1}]}')
check "destinations" "$(jq -c '[.destinations[].uri]' <<<"$app")" '["p.pages.dev","*.p.pages.dev"]'
check "app type"     "$(jq -r '.type' <<<"$app")"                 'self_hosted'
check "policy link"  "$(jq -c '.policies' <<<"$app")"             '[{"id":"PID","precedence":1}]'

echo
[ $fail -eq 0 ] && echo "all checks passed" || echo "FAILURES — do not deploy"
exit $fail
