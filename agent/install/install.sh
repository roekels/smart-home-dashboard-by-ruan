#!/bin/bash
# Installs edge-agent for the current user: a LaunchAgent on a Mac, a systemd user service on Linux.
# No root and no extra privacy permissions.
#
#   ./install.sh [path/to/edge-agent]   copy the binary, write the service, start it if this computer is enrolled
#   ./install.sh --remove               stop and remove the service and the binary (keeps the key and settings)
set -euo pipefail

LABEL="local.edge-agent"
if [[ "$(uname)" == "Darwin" ]]; then
  DIR="$HOME/Library/Application Support/edge-agent"
  UNIT="$HOME/Library/LaunchAgents/$LABEL.plist"
  DOMAIN="gui/$(id -u)"
else
  DIR="$HOME/.local/state/edge-agent"
  UNIT="$HOME/.config/systemd/user/edge-agent.service"
fi
BIN="$DIR/bin/edge-agent"

stop() {
  if [[ "$(uname)" == "Darwin" ]]; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  else systemctl --user disable --now edge-agent.service 2>/dev/null || true; fi
}

if [[ "${1:-}" == "--remove" ]]; then
  stop
  rm -f "$UNIT" "$BIN"
  echo "Removed the service and the binary. The key and settings stay in: $DIR"
  echo "To forget this computer too: delete that folder, and revoke it under Settings > Edge agents."
  exit 0
fi

SRC="${1:-$(dirname "$0")/../dist/edge-agent}"
[[ -f "$SRC" ]] || { echo "binary not found: $SRC (build it first: ./build.sh)" >&2; exit 1; }
mkdir -p "$DIR/bin" "$(dirname "$UNIT")"
chmod 700 "$DIR"
install -m 755 "$SRC" "$BIN.new"
if [[ "$(uname)" == "Darwin" ]]; then
  xattr -d com.apple.quarantine "$BIN.new" 2>/dev/null || true
  # an ad-hoc signature: enough for a program you built yourself on this Mac
  codesign --force --sign - "$BIN.new"
fi
mv -f "$BIN.new" "$BIN"

if [[ "$(uname)" == "Darwin" ]]; then
  cat > "$UNIT" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$DIR/agent.err.log</string>
</dict>
</plist>
PL
  chmod 644 "$UNIT"
else
  cat > "$UNIT" <<UN
[Unit]
Description=Home dashboard edge agent (outbound HTTPS only)
After=network-online.target

[Service]
ExecStart="$BIN" run
Restart=always
RestartSec=30
NoNewPrivileges=true

[Install]
WantedBy=default.target
UN
fi

if [[ ! -f "$DIR/agent.json" ]]; then
  echo "Installed $BIN"
  echo "Next: add this computer in the dashboard (Settings > Edge agents), then run:"
  echo "  \"$BIN\" enrol --server https://<your dashboard> --id ag_<name> --code <code>"
  echo "and run this script again to start it."
  exit 0
fi
stop
if [[ "$(uname)" == "Darwin" ]]; then launchctl bootstrap "$DOMAIN" "$UNIT"
else systemctl --user daemon-reload && systemctl --user enable --now edge-agent.service; fi
echo "Started. Check it with: \"$BIN\" status"
