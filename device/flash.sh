#!/bin/bash
# One command for the whole device round, from any terminal:
#   bash ~/Desktop/"my agent"/device/flash.sh
# It loads Espressif's tools, points the demo at the agent, builds, writes the
# device and opens its log. Leave the log with Ctrl+].
set -euo pipefail

AGENT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${DEMO:-$HOME/esp/esp-webrtc-solution/solutions/openai_demo}"
IDF="${IDF:-$HOME/esp/esp-idf-v5.4}"
[ -f "$IDF/export.sh" ] || { echo "Cannot find ESP-IDF at: $IDF"; exit 1; }

# An older ESP-IDF on this computer must not leak in.
unset IDF_PYTHON_ENV_PATH IDF_PATH
set +u
. "$IDF/export.sh" >/dev/null
set -u

bash "$AGENT/device/connect-to-agent.sh"

# The device's port: the first USB one, unless PORT says otherwise.
PORT="${PORT:-$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)}"
[ -n "$PORT" ] || { echo "The device is not connected by USB (no /dev/cu.usbmodem*)."; exit 1; }

cd "$DEMO"
exec idf.py -p "$PORT" flash monitor
