#!/usr/bin/env bash
# Bewaakt het ServerDash-dashboard vanaf een ándere server.
# Meldt via ntfy, e-mail en/of webhook als /api/health niet OK is, en één keer als het weer werkt.
#
# Installatie (bijv. op de nameserver), elke 2 minuten via cron:
#   */2 * * * * DASH_URL=https://monitor.nextbuzz.nl NTFY_URL=https://ntfy.sh/nextbuzz-alerts-x7k2 /usr/local/bin/serverdash-watchdog.sh
#
# Variabelen:
#   DASH_URL     (verplicht) basis-URL van het dashboard
#   NTFY_URL     ntfy-topic voor pushmeldingen
#   MAIL_TO      e-mailadres (vereist een werkende `mail`-opdracht, bijv. mailutils)
#   WEBHOOK_URL  Slack/Mattermost/Discord-webhook
#   FAILS        aantal opeenvolgende fouten voordat er gemeld wordt (standaard 2)
set -u

DASH_URL="${DASH_URL:?Zet DASH_URL, bijv. https://monitor.nextbuzz.nl}"
FAILS="${FAILS:-2}"
STATE="${STATE_FILE:-/var/tmp/serverdash-watchdog.state}"

count=0
alerted=0
[ -f "$STATE" ] && read -r count alerted < "$STATE"

body="$(curl -fsS --max-time 20 "${DASH_URL%/}/api/health" 2>&1)"
rc=$?

notify() {
  local title="$1" msg="$2" prio="$3"
  [ -n "${NTFY_URL:-}" ] && curl -fsS --max-time 15 -H "Title: $title" -H "Priority: $prio" -d "$msg" "$NTFY_URL" >/dev/null
  [ -n "${MAIL_TO:-}" ] && command -v mail >/dev/null && printf '%s\n' "$msg" | mail -s "$title" "$MAIL_TO"
  [ -n "${WEBHOOK_URL:-}" ] && curl -fsS --max-time 15 -H 'Content-Type: application/json' \
    -d "{\"text\":\"$title: $msg\",\"content\":\"$title: $msg\"}" "$WEBHOOK_URL" >/dev/null
  return 0
}

if [ $rc -eq 0 ] && printf '%s' "$body" | grep -q '"ok":true'; then
  if [ "$alerted" = "1" ]; then
    notify "ServerDash weer bereikbaar" "Het dashboard op $DASH_URL werkt weer." 3
  fi
  echo "0 0" > "$STATE"
  exit 0
fi

count=$((count + 1))
if [ "$count" -ge "$FAILS" ] && [ "$alerted" = "0" ]; then
  notify "ServerDash werkt niet" "Health-check van $DASH_URL mislukt ($count keer): ${body:0:300}" 5
  alerted=1
fi
echo "$count $alerted" > "$STATE"
exit 1
