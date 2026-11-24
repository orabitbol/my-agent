/* my-agent: the device's settings live on the computer.
 *
 * The device keeps one question open with the agent: "has anything changed?".
 * The agent answers the moment something does (or after a few seconds, with
 * the same answer), and the device asks again. The answer says how the device
 * should be set (speaker volume, microphone muted or not), what the
 * character on its screen is doing, and whether a voice call should be
 * running. The device never starts a call by itself. The asking is also how the agent knows
 * the device is switched on.
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <string.h>
#include <stdlib.h>
#include <stdbool.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_codec_dev.h"
#include "esp_board_manager_defs.h"
#include "esp_board_manager_includes.h"
#include "media_lib_os.h"
#include "settings.h"
#include "agent_parts.h"

#define TAG "AGENT_SETTINGS"

int start_webrtc(void);
int stop_webrtc(void);

/* Starting and stopping a call takes a moment, so it runs beside this task, as the demo itself does. */
static void call_job(void *arg)
{
    if (arg) {
        start_webrtc();
    } else {
        stop_webrtc();
    }
    media_lib_thread_destroy(NULL);
}

static void set_call(bool on)
{
    ESP_LOGI(TAG, "The agent says: %s", on ? "start a call" : "end the call");
    media_lib_thread_create_from_scheduler(NULL, on ? "start" : "stop", call_job, on ? (void *)1 : NULL);
}

static volatile bool online;

void agent_face_set(bool here, const char *face);

void agent_settings_set_online(bool on)
{
    online = on;
}

bool agent_online(void)
{
    return online;
}

static esp_codec_dev_handle_t codec(const char *name)
{
    dev_audio_codec_handles_t *handles = NULL;
    if (esp_board_device_get_handle(name, (void **)&handles) != ESP_OK || handles == NULL) {
        return NULL;
    }
    return handles->codec_dev;
}

/* Reads the agent's answer, for example {"v":7,"volume":90,"muted":false,"here":true,"call":true,"face":"speaking"}.
 * `seen` is the version of the last answer: the agent waits until it has a newer one. */
static bool ask_agent(char *body, int size, int seen)
{
    char url[160];
    snprintf(url, sizeof(url), "%s?v=%d", AGENT_SETTINGS_URL, seen);
    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = 9000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) {
        return false;
    }
    bool ok = false;
    esp_http_client_set_header(client, "Authorization", "Bearer " AGENT_DEVICE_KEY);
    if (esp_http_client_open(client, 0) == ESP_OK) {
        esp_http_client_fetch_headers(client);
        int got = esp_http_client_read_response(client, body, size - 1);
        if (got > 0 && esp_http_client_get_status_code(client) == 200) {
            body[got] = 0;
            ok = true;
        }
    }
    esp_http_client_cleanup(client);
    return ok;
}

static void settings_task(void *arg)
{
    static char body[192];
    int volume = -1;
    int muted = -1;
    int seen = 0;
    bool calling = false;
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(100));
        if (!online || !ask_agent(body, sizeof(body), seen)) {
            /* The computer is out of reach: the character is not here either. */
            agent_face_set(false, NULL);
            if (calling) {
                calling = false;
                set_call(false);
            }
            seen = 0;
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }
        const char *version = strstr(body, "\"v\":");
        seen = version ? atoi(version + strlen("\"v\":")) : 0;

        char face[16] = "";
        const char *named = strstr(body, "\"face\":\"");
        if (named) {
            named += strlen("\"face\":\"");
            for (int i = 0; i < (int)sizeof(face) - 1 && named[i] && named[i] != '"'; i++) {
                face[i] = named[i];
                face[i + 1] = 0;
            }
        }
        agent_face_set(strstr(body, "\"here\":true") != NULL, face);

        bool want_call = strstr(body, "\"call\":true") != NULL;
        if (want_call != calling) {
            calling = want_call;
            set_call(want_call);
        }

        const char *at = strstr(body, "\"volume\":");
        int want_volume = at ? atoi(at + strlen("\"volume\":")) : -1;
        int want_muted = strstr(body, "\"muted\":true") ? 1 : 0;

        if (want_volume >= 0 && want_volume <= 100 && want_volume != volume) {
            esp_codec_dev_handle_t speaker = codec(ESP_BOARD_DEVICE_NAME_AUDIO_DAC);
            if (speaker && esp_codec_dev_set_out_vol(speaker, want_volume) == ESP_CODEC_DEV_OK) {
                volume = want_volume;
                ESP_LOGI(TAG, "Volume is now %d", volume);
            }
        }
        if (want_muted != muted) {
            esp_codec_dev_handle_t microphone = codec(ESP_BOARD_DEVICE_NAME_AUDIO_ADC);
            if (microphone && esp_codec_dev_set_in_mute(microphone, want_muted == 1) == ESP_CODEC_DEV_OK) {
                muted = want_muted;
                ESP_LOGI(TAG, "Microphone is now %s", muted ? "muted" : "on");
            }
        }
    }
}

void agent_settings_start(void)
{
    agent_task(settings_task, "agent_settings", 6 * 1024, 5);
}
