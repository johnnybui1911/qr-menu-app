#!/usr/bin/env bash
# Prompts for the five Console auth secrets (C11: BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
# INITIAL_OWNER_EMAIL, INVITATION_HMAC_SECRET), trims whitespace/newlines from each value (a stray trailing "\n"
# in INITIAL_OWNER_EMAIL is an easy mistake when pasting), validates the two HMAC secrets' length, and loads them
# with exactly five `wrangler secret put` calls (decision #3 of phase-06). This script contains no secret value.
set -euo pipefail

MIN_SECRET_LENGTH=32

read_trimmed() {
  local prompt="$1"
  local value
  read -r -s -p "$prompt: " value
  echo >&2
  printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

put_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | npx wrangler secret put "$name"
}

better_auth_secret="$(read_trimmed 'BETTER_AUTH_SECRET (>= 32 characters)')"
if [ "${#better_auth_secret}" -lt "$MIN_SECRET_LENGTH" ]; then
  echo "BETTER_AUTH_SECRET must be at least $MIN_SECRET_LENGTH characters (got ${#better_auth_secret})." >&2
  exit 1
fi

google_client_id="$(read_trimmed 'GOOGLE_CLIENT_ID')"
google_client_secret="$(read_trimmed 'GOOGLE_CLIENT_SECRET')"
initial_owner_email="$(read_trimmed 'INITIAL_OWNER_EMAIL (verified Google account for the first Owner)')"
invitation_hmac_secret="$(read_trimmed 'INVITATION_HMAC_SECRET (>= 32 characters, must differ from BETTER_AUTH_SECRET)')"

if [ "${#invitation_hmac_secret}" -lt "$MIN_SECRET_LENGTH" ]; then
  echo "INVITATION_HMAC_SECRET must be at least $MIN_SECRET_LENGTH characters (got ${#invitation_hmac_secret})." >&2
  exit 1
fi
if [ "$invitation_hmac_secret" = "$better_auth_secret" ]; then
  echo 'INVITATION_HMAC_SECRET must not equal BETTER_AUTH_SECRET (C11): rotating one must never silently kill every pending invitation.' >&2
  exit 1
fi

put_secret BETTER_AUTH_SECRET "$better_auth_secret"
put_secret GOOGLE_CLIENT_ID "$google_client_id"
put_secret GOOGLE_CLIENT_SECRET "$google_client_secret"
put_secret INITIAL_OWNER_EMAIL "$initial_owner_email"
put_secret INVITATION_HMAC_SECRET "$invitation_hmac_secret"

echo 'All five Console auth secrets are set. Verify with: npx wrangler secret list'
