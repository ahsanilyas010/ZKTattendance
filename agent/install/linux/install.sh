#!/usr/bin/env bash
# Installs the agent as a systemd service. Run from the agent/ folder as root:  sudo ./install/linux/install.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DEST=/opt/zkagent
[ -f agent.toml ] || { echo "Create agent.toml first (copy agent.toml.example and fill in cloud_url and api_key)."; exit 1; }
python3 -m venv "$DEST/venv"
"$DEST/venv/bin/pip" install --quiet .
install -m 600 agent.toml "$DEST/agent.toml"
echo "Checking the cloud connection and your terminal(s)..."
"$DEST/venv/bin/python" -m zkagent check -c "$DEST/agent.toml" || { echo "Fix the problems above, then run this again."; exit 1; }
install -m 644 install/linux/zkagent.service /etc/systemd/system/zkagent.service
systemctl daemon-reload
systemctl enable --now zkagent
echo "Done. Follow the log with:  journalctl -u zkagent -f"
