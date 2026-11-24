#!/bin/bash
# Points Espressif's OpenAI demo at OUR agent instead of straight at OpenAI.
#
# After this, the device no longer holds an OpenAI key and no longer decides
# anything. It only carries sound. To start a call it asks the agent on this
# Mac, showing its own key; the agent opens the call with its instructions,
# memory and tools, and runs the tools itself.
#
# Run it from anywhere:   bash ~/Desktop/"my agent"/device/connect-to-agent.sh
# It is safe to run again (for example after the Mac's address changed).
set -euo pipefail

AGENT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${DEMO:-$HOME/esp/esp-webrtc-solution/solutions/openai_demo}"
[ -f "$DEMO/main/webrtc.c" ] || { echo "Cannot find the demo at: $DEMO"; exit 1; }
[ -f "$AGENT/.env" ] || { echo "Cannot find the agent's .env at: $AGENT/.env"; exit 1; }

# The device's key: made once, kept in the agent's .env, never printed.
if ! grep -q '^DEVICE_KEY=.\{32,\}' "$AGENT/.env"; then
  printf '\n# The desk device shows this key when it asks to start a voice call.\nDEVICE_KEY=%s\n' "$(openssl rand -hex 32)" >> "$AGENT/.env"
  echo "Made a new key for the device (saved in the agent's .env)."
fi
KEY="$(grep '^DEVICE_KEY=' "$AGENT/.env" | tail -1 | cut -d= -f2)"
PORT="$(grep '^DEVICE_PORT=' "$AGENT/.env" | tail -1 | cut -d= -f2 || true)"; PORT="${PORT:-8787}"

# This Mac's address on the home network (Wi-Fi first, then cable).
IP="${AGENT_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
[ -n "$IP" ] || { echo "Could not find this Mac's network address. Is Wi-Fi on?"; exit 1; }

# The part of the device that asks the agent for its settings (volume, mute).
cp "$AGENT/device/agent_settings.c" "$DEMO/main/agent_settings.c"
# The part that draws the character's face on the device's screen.
cp "$AGENT/device/agent_face.c" "$DEMO/main/agent_face.c"
# The part that tells the agent when the screen is touched.
cp "$AGENT/device/agent_touch.c" "$DEMO/main/agent_touch.c"
# What the parts share.
cp "$AGENT/device/agent_parts.h" "$DEMO/main/agent_parts.h"
# The two-claps part was taken out again: it was unreliable, and it competed with the call for the microphone.
rm -f "$DEMO/main/agent_claps.c"
# The part that sends the device's log to the app.
cp "$AGENT/device/agent_log.c" "$DEMO/main/agent_log.c"
# The part that reads the base's temperature sensor.
cp "$AGENT/device/agent_sensors.c" "$DEMO/main/agent_sensors.c"
# The part that feels the device being shaken or lifted.
cp "$AGENT/device/agent_motion.c" "$DEMO/main/agent_motion.c"
# The part that reports the device's own mute button.
cp "$AGENT/device/agent_mute.c" "$DEMO/main/agent_mute.c"

DEMO="$DEMO" KEY="$KEY" URL="http://$IP:$PORT/device/voice" SETTINGS_URL="http://$IP:$PORT/device/settings" TOUCH_URL="http://$IP:$PORT/device/touch" WAKE_URL="http://$IP:$PORT/device/wake" python3 - <<'PY'
import os, re
demo, key, url, settings_url, touch_url = os.environ["DEMO"], os.environ["KEY"], os.environ["URL"], os.environ["SETTINGS_URL"], os.environ["TOUCH_URL"]
wake_url = os.environ["WAKE_URL"]
log_url = url.rsplit("/", 1)[0] + "/log"
sense_url = url.rsplit("/", 1)[0] + "/sense"
mute_url = url.rsplit("/", 1)[0] + "/mute"
def edit(name, fn):
    path = os.path.join(demo, name)
    old = open(path).read()
    new = fn(old)
    if new != old:
        open(path, "w").write(new)
        print("changed", name)
def once(text, old, new, name):
    if new in text: return text            # already done
    if old not in text: raise SystemExit(f"{name}: the demo's code is not what this script expects ({old[:50]!r}). Nothing more was changed.")
    return text.replace(old, new, 1)

# settings.h: where the agent is, and the device's key.
def settings(t):
    t = re.sub(r'\n/\* my-agent \*/\n(?:#define AGENT_\w+ .*\n)+', "", t)
    block = f'\n/* my-agent */\n#define AGENT_VOICE_URL "{url}"\n#define AGENT_SETTINGS_URL "{settings_url}"\n#define AGENT_TOUCH_URL "{touch_url}"\n#define AGENT_WAKE_URL "{wake_url}"\n#define AGENT_LOG_URL "{log_url}"\n#define AGENT_SENSE_URL "{sense_url}"\n#define AGENT_MUTE_URL "{mute_url}"\n#define AGENT_DEVICE_KEY "{key}"\n'
    return once(t, "\n#ifdef __cplusplus\n}\n#endif", block + "\n#ifdef __cplusplus\n}\n#endif", "settings.h")
edit("main/settings.h", settings)

# The signaling: send the offer to the agent, with the device's key. No OpenAI token.
def signaling(t):
    t = once(t, '#define OPENAI_REALTIME_CALLS_URL "https://api.openai.com/v1/realtime/calls"', '#define OPENAI_REALTIME_CALLS_URL AGENT_VOICE_URL', "openai_signaling.c")
    t = once(t, "    if (fetch_ephemeral_token(sig) != 0) {", "    (void)fetch_ephemeral_token; /* my-agent: the agent's server holds the OpenAI key */\n    if (0) {", "openai_signaling.c")
    t = once(t, 'int len = strlen("Authorization: Bearer ") + strlen(sig->ephemeral_token) + 1;', 'int len = strlen("Authorization: Bearer ") + strlen(sig->api_key) + 1;', "openai_signaling.c")
    t = once(t, 'snprintf(auth, len, "Authorization: Bearer %s", sig->ephemeral_token);', 'snprintf(auth, len, "Authorization: Bearer %s", sig->api_key);', "openai_signaling.c")
    return t
edit("main/openai_signaling.c", signaling)

# The call itself: the device sets no tools and answers no tool requests. The agent does.
def webrtc(t):
    t = once(t, "    process_json((const char *)data);\n", "    (void)process_json; /* my-agent: tools run on the agent's server */\n", "webrtc.c")
    t = once(t, '        send_function_desc();\n        send_response("Greet the user briefly and say: How can I help?");\n', "        (void)send_function_desc; (void)send_response; /* my-agent: the agent's server sets the session */\n", "webrtc.c")
    t = once(t, "        .token = OPENAI_API_KEY,", "        .token = AGENT_DEVICE_KEY,", "webrtc.c")
    return t
edit("main/webrtc.c", webrtc)

# The build no longer needs (or contains) the OpenAI key.
def cmake(t):
    t = re.sub(r'if\(NOT DEFINED ENV\{OPENAI_API_KEY\}\)\n\s*message\(FATAL_ERROR "Env variable OPENAI_API_KEY must be set"\)\nendif\(\)\n', "", t)
    t = t.replace('add_compile_definitions(OPENAI_API_KEY="$ENV{OPENAI_API_KEY}")', "# my-agent: no OpenAI key is compiled into the device")
    # One of Espressif's ready-made parts has a harmless mistake in a log line that
    # stops the build. Let it pass as a warning.
    relax = 'idf_build_set_property(COMPILE_OPTIONS "-Wno-error=format" APPEND)\n'
    return t if relax in t else once(t, "project(openai_demo)", relax + "project(openai_demo)", "CMakeLists.txt")
edit("CMakeLists.txt", cmake)

# The settings part: build it, start it, and tell it when the network is up.
edit("main/CMakeLists.txt", lambda t: t if "agent_settings.c" in t else once(t, '"openai_signaling.c"', '"openai_signaling.c" "agent_settings.c"', "main/CMakeLists.txt"))
edit("main/CMakeLists.txt", lambda t: t if "agent_face.c" in t else once(t, '"agent_settings.c"', '"agent_settings.c" "agent_face.c"', "main/CMakeLists.txt"))
edit("main/CMakeLists.txt", lambda t: t if "agent_touch.c" in t else once(t, '"agent_face.c"', '"agent_face.c" "agent_touch.c"', "main/CMakeLists.txt"))
edit("main/CMakeLists.txt", lambda t: t.replace(' "agent_claps.c"', ""))
edit("main/CMakeLists.txt", lambda t: t if "agent_log.c" in t else once(t, '"agent_touch.c"', '"agent_touch.c" "agent_log.c"', "main/CMakeLists.txt"))
edit("main/CMakeLists.txt", lambda t: t if "agent_sensors.c" in t else once(t, '"agent_log.c"', '"agent_log.c" "agent_sensors.c"', "main/CMakeLists.txt"))
edit("main/CMakeLists.txt", lambda t: t if "agent_mute.c" in t else once(t, '"agent_sensors.c"', '"agent_sensors.c" "agent_mute.c"', "main/CMakeLists.txt"))
edit("main/CMakeLists.txt", lambda t: t if "agent_motion.c" in t else once(t, '"agent_mute.c"', '"agent_mute.c" "agent_motion.c"', "main/CMakeLists.txt"))
def main_c(t):
    if "agent_settings_set_online(connected);" not in t:
        t = once(t, "static int network_event_handler(bool connected)\n{\n", "void agent_settings_start(void);\nvoid agent_settings_set_online(bool on);\n\nstatic int network_event_handler(bool connected)\n{\n    agent_settings_set_online(connected);\n", "main.c")
    if "    agent_settings_start();" not in t:
        t = once(t, "    network_init(WIFI_SSID,", "    agent_settings_start();\n    network_init(WIFI_SSID,", "main.c")
    if "agent_face_start" not in t:
        t = once(t, "void agent_settings_start(void);\n", "void agent_settings_start(void);\nvoid agent_face_start(void);\n", "main.c")
        t = once(t, "    agent_settings_start();\n", "    agent_face_start();\n    agent_settings_start();\n", "main.c")
    if "agent_touch_start" not in t:
        t = once(t, "void agent_face_start(void);\n", "void agent_face_start(void);\nvoid agent_touch_start(void);\n", "main.c")
        t = once(t, "    agent_face_start();\n", "    agent_face_start();\n    agent_touch_start();\n", "main.c")
    t = t.replace("void agent_claps_start(void);\n", "").replace("    agent_claps_start();\n", "")
    if "agent_log_start" not in t:
        t = once(t, "void agent_touch_start(void);\n", "void agent_touch_start(void);\nvoid agent_log_start(void);\n", "main.c")
        t = once(t, "    init_board();\n", "    agent_log_start();\n    init_board();\n", "main.c")
    if "agent_sensors_start" not in t:
        t = once(t, "void agent_log_start(void);\n", "void agent_log_start(void);\nvoid agent_sensors_start(void);\n", "main.c")
        t = once(t, "    agent_touch_start();\n", "    agent_touch_start();\n    agent_sensors_start();\n", "main.c")
    if "agent_mute_start" not in t:
        t = once(t, "void agent_sensors_start(void);\n", "void agent_sensors_start(void);\nvoid agent_mute_start(void);\n", "main.c")
        t = once(t, "    agent_sensors_start();\n", "    agent_sensors_start();\n    agent_mute_start();\n", "main.c")
    if "agent_motion_start" not in t:
        t = once(t, "void agent_mute_start(void);\n", "void agent_mute_start(void);\nvoid agent_motion_start(void);\n", "main.c")
        t = once(t, "    agent_mute_start();\n", "    agent_mute_start();\n    agent_motion_start();\n", "main.c")
    # The device no longer starts a call when it gets on the network: the agent says when.
    t = t.replace("        RUN_ASYNC(start, { start_webrtc(); });\n", "        (void)0; /* my-agent: a call starts when the agent says so (see agent_settings.c) */\n")
    return t
edit("main/main.c", main_c)

# The box has 16MB of storage, but the demo is set up for 4MB with a 3MB slot for the
# program - too small once the box's screen and sound parts are built in.
edit("partitions.csv", lambda t: re.sub(r"(factory,\s*app,\s*factory,\s*0x10000,\s*)3M", r"\g<1>8M", t))
def flash(t):
    t = t.replace("CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y", "CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y")
    t = t.replace("# CONFIG_ESPTOOLPY_FLASHSIZE_16MB is not set\n", "")
    return t.replace('CONFIG_ESPTOOLPY_FLASHSIZE="4MB"', 'CONFIG_ESPTOOLPY_FLASHSIZE="16MB"')
edit("sdkconfig.defaults.esp32s3", flash)
if os.path.exists(os.path.join(demo, "sdkconfig")):
    edit("sdkconfig", flash)
PY

echo
echo "Done. The device will call the agent at: http://$IP:$PORT/device/voice"
echo "Next:  1) restart the agent (npm start)   2) cd \"$DEMO\" && idf.py flash monitor"
