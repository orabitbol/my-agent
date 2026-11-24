/* my-agent: the device's own mute button.
 *
 * The button on top of the device switches its microphones off in the
 * hardware itself and lights the red light. The device only reports which
 * way the switch is (GPIO 1: low means muted), so the app can show it and the
 * character's face can show that it cannot hear.
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <stdbool.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "driver/gpio.h"
#include "settings.h"
#include "agent_parts.h"

#define TAG "AGENT_MUTE"
#define MUTE_PIN GPIO_NUM_1 /* from Espressif's own code for this board */

void agent_face_set_deaf(bool deaf);

static bool tell_agent(bool muted)
{
    const char *body = muted ? "{\"muted\":true}" : "{\"muted\":false}";
    esp_http_client_config_t cfg = {
        .url = AGENT_MUTE_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) {
        return false;
    }
    esp_http_client_set_header(client, "Authorization", "Bearer " AGENT_DEVICE_KEY);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, strlen(body));
    bool told = esp_http_client_perform(client) == ESP_OK;
    esp_http_client_cleanup(client);
    return told;
}

static void mute_task(void *arg)
{
    gpio_config_t pin = {
        .pin_bit_mask = 1ULL << MUTE_PIN,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&pin);

    int shown = -1;     /* what the face shows */
    int reported = -1;  /* what the agent was told */
    int waited = 0;
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(100));
        int muted = gpio_get_level(MUTE_PIN) == 0 ? 1 : 0;
        if (muted != shown) {
            shown = muted;
            agent_face_set_deaf(muted == 1);
            ESP_LOGI(TAG, "The microphone is %s (the button on the device)", muted ? "switched off" : "on");
        }
        /* Tell the agent on a change, and again every half minute in case it missed it or restarted. */
        waited += 100;
        if (agent_online() && (muted != reported || waited >= 30000)) {
            waited = 0;
            reported = tell_agent(muted == 1) ? muted : -1;
            if (reported == -1) {
                vTaskDelay(pdMS_TO_TICKS(2000));
            }
        }
    }
}

void agent_mute_start(void)
{
    agent_task(mute_task, "agent_mute", 6 * 1024, 3);
}
