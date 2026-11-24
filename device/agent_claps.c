/* my-agent: two claps wake the character.
 *
 * While no call is running, the device listens to its own microphone for one
 * thing only: two short, sharp sounds, one right after the other. Nothing it
 * hears leaves the device; it only measures how loud each moment is. On two
 * claps it tells the agent "wake up", exactly like a touch on the screen.
 *
 * During a call the microphone belongs to the call, so this steps aside
 * (agent_claps_hold) and comes back when the call is over.
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_http_client.h"
#include "esp_codec_dev.h"
#include "esp_board_manager_defs.h"
#include "esp_board_manager_includes.h"
#include "settings.h"

#define TAG "AGENT_CLAPS"

/* The numbers to tune. Loudness runs from 0 to 32767. */
#define FRAME_MS        20     /* one look at the microphone */
#define LOUD_AT_LEAST   9000   /* a clap is at least this loud... */
#define LOUD_OVER_ROOM  5      /* ...and this many times louder than the room */
#define QUIET_BEFORE    4      /* looks of quiet before a clap (80 ms) */
#define CLAP_LASTS_MOST 6      /* a clap is over within this many looks (120 ms); speech is not */
#define GAP_MIN_MS      160    /* the second clap comes no sooner than this... */
#define GAP_MAX_MS      800    /* ...and no later than this */

#define RATE     16000
#define CHANNELS 2             /* the two microphones, as the call itself reads them */
#define SAMPLES  (RATE * FRAME_MS / 1000)

static volatile bool enabled;      /* the user's setting */
static volatile bool held;         /* a call has the microphone */
static volatile bool listening;    /* this task has the microphone open right now */
static volatile int64_t resume_at; /* not before this time (the call needs a moment to let go) */

void agent_claps_set(bool on)
{
    enabled = on;
}

/* true: step aside now, and return only once the microphone is free. false: come back in a moment. */
void agent_claps_hold(bool hold)
{
    held = hold;
    if (hold) {
        for (int i = 0; i < 40 && listening; i++) {
            vTaskDelay(pdMS_TO_TICKS(25));
        }
    } else {
        resume_at = esp_timer_get_time() + 2500 * 1000;
    }
}

static void tell_agent(void)
{
    esp_http_client_config_t cfg = {
        .url = AGENT_WAKE_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) {
        return;
    }
    esp_http_client_set_header(client, "Authorization", "Bearer " AGENT_DEVICE_KEY);
    if (esp_http_client_perform(client) != ESP_OK) {
        ESP_LOGW(TAG, "The agent did not hear the claps");
    }
    esp_http_client_cleanup(client);
}

static void claps_task(void *arg)
{
    static int16_t frame[SAMPLES * CHANNELS];
    dev_audio_codec_handles_t *handles = NULL;
    esp_codec_dev_handle_t mic = NULL;
    if (esp_board_device_get_handle(ESP_BOARD_DEVICE_NAME_AUDIO_ADC, (void **)&handles) == ESP_OK && handles) {
        mic = handles->codec_dev;
    }
    if (mic == NULL) {
        ESP_LOGE(TAG, "No microphone to listen with");
        vTaskDelete(NULL);
        return;
    }

    float room = 400;        /* how loud the room usually is */
    int quiet = 0;           /* looks of quiet in a row */
    int loud = 0;            /* looks the current sound has lasted; 0 when there is none */
    int64_t first_clap = 0;  /* when the first clap began, 0 when waiting for it */
    int64_t sound_began = 0;

    while (1) {
        if (!enabled || held || esp_timer_get_time() < resume_at) {
            if (listening) {
                esp_codec_dev_close(mic);
                listening = false;
                ESP_LOGI(TAG, "Stopped listening for claps");
            }
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        if (!listening) {
            esp_codec_dev_sample_info_t fs = {
                .sample_rate = RATE,
                .bits_per_sample = 16,
                .channel = 4,
                .channel_mask = 1 | 2,
            };
            if (esp_codec_dev_open(mic, &fs) != ESP_CODEC_DEV_OK) {
                ESP_LOGW(TAG, "The microphone is busy");
                vTaskDelay(pdMS_TO_TICKS(1000));
                continue;
            }
            listening = true;
            quiet = loud = 0;
            first_clap = 0;
            ESP_LOGI(TAG, "Listening for two claps");
        }
        if (esp_codec_dev_read(mic, frame, sizeof(frame)) != ESP_CODEC_DEV_OK) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        int peak = 0;
        for (int i = 0; i < SAMPLES * CHANNELS; i += CHANNELS) {
            int v = abs(frame[i]);
            if (v > peak) {
                peak = v;
            }
        }
        int64_t now = esp_timer_get_time();
        float limit = room * LOUD_OVER_ROOM > LOUD_AT_LEAST ? room * LOUD_OVER_ROOM : LOUD_AT_LEAST;

        if (first_clap && (now - first_clap) / 1000 > GAP_MAX_MS) {
            first_clap = 0; /* the second clap never came */
        }
        if (peak < limit / 3) {
            /* Quiet. A sound that just ended, and was short, was a clap. */
            if (loud > 0 && loud <= CLAP_LASTS_MOST) {
                int64_t gap = first_clap ? (sound_began - first_clap) / 1000 : 0;
                if (first_clap && gap >= GAP_MIN_MS) {
                    ESP_LOGI(TAG, "Second clap, %d ms after the first", (int)gap);
                    first_clap = 0;
                    esp_codec_dev_close(mic);
                    listening = false;
                    tell_agent();
                    resume_at = esp_timer_get_time() + 3000 * 1000;
                    continue;
                }
                if (!first_clap) {
                    ESP_LOGI(TAG, "First clap (loudness %d, room %d)", peak, (int)room);
                    first_clap = sound_began;
                }
            }
            loud = 0;
            quiet++;
            room = room * 0.98f + peak * 0.02f;
        } else if (peak >= limit) {
            if (loud == 0) {
                if (quiet < QUIET_BEFORE) {
                    loud = CLAP_LASTS_MOST + 1; /* it grew out of other sound: not a clap */
                } else {
                    loud = 1;
                    sound_began = now;
                }
            } else {
                loud++;
            }
            if (loud > CLAP_LASTS_MOST) {
                first_clap = 0; /* too long: talking, music, a chair */
            }
            quiet = 0;
        } else if (loud > 0) {
            loud++; /* in between: still the same sound */
        } else {
            quiet = 0;
        }
    }
}

void agent_claps_start(void)
{
    xTaskCreatePinnedToCore(claps_task, "agent_claps", 6 * 1024, NULL, 4, NULL, 0);
}
