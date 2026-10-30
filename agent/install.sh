#!/usr/bin/env bash
# NextBuzz ServerDash agent installer
#
# Installeren:
#   curl -fsSL https://dash.example.nl/agent/install.sh | sudo bash -s -- --url https://dash.example.nl --token TOKEN
# Verwijderen:
#   curl -fsSL https://dash.example.nl/agent/install.sh | sudo bash -s -- --uninstall
set -euo pipefail

URL=""
TOKEN=""
INTERVAL=30
INSECURE=0
UNINSTALL=0

usage() {
  echo "Gebruik: install.sh --url <dashboard-url> --token <token> [--interval 30] [--insecure]"
  echo "         install.sh --uninstall"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-30}"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Onbekende optie: $1"; usage ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Dit script moet als root draaien (gebruik sudo)."
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now nb-agent 2>/dev/null || true
  rm -f /etc/systemd/system/nb-agent.service /etc/nb-agent.conf
  rm -rf /opt/nb-agent
  systemctl daemon-reload
  echo "ServerDash agent verwijderd."
  exit 0
fi

[ -n "$URL" ] && [ -n "$TOKEN" ] || usage
URL="${URL%/}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 installeren..."
  apt-get update -qq && apt-get install -y -qq python3
fi

CURL_OPTS="-fsSL"
[ "$INSECURE" -eq 1 ] && CURL_OPTS="-fsSLk"

mkdir -p /opt/nb-agent
curl $CURL_OPTS "$URL/agent/nb-agent.py" -o /opt/nb-agent/nb-agent.py.new
mv /opt/nb-agent/nb-agent.py.new /opt/nb-agent/nb-agent.py
chmod 755 /opt/nb-agent/nb-agent.py

( umask 077
  cat > /etc/nb-agent.conf <<EOF
# NextBuzz ServerDash agent
url=$URL
token=$TOKEN
interval=$INTERVAL
insecure=$INSECURE
EOF
)

cat > /etc/systemd/system/nb-agent.service <<'EOF'
[Unit]
Description=NextBuzz ServerDash monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/nb-agent/nb-agent.py
Restart=always
RestartSec=10
Nice=10
IOSchedulingClass=idle
MemoryMax=128M

[Install]
WantedBy=multi-user.target
EOF

echo "Verbinding testen..."
if ! python3 /opt/nb-agent/nb-agent.py --once; then
  echo "LET OP: testmeting mislukt. Controleer URL/token en of deze server het dashboard kan bereiken."
fi

systemctl daemon-reload
systemctl enable nb-agent >/dev/null 2>&1
systemctl restart nb-agent
echo "ServerDash agent geïnstalleerd en gestart. Status: systemctl status nb-agent"
