/* my-agent: a touch on the device's screen calls the character over.
 *
 * Touch the screen and the character leaves the computer, appears here and
 * listens. Touch again and it goes back. The device does not decide that by
 * itself: it only tells the agent "I was touched", and the agent moves the
 * character (see agent_settings.c for how the answer comes back).
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <stdbool.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_lcd_touch.h"
#include "esp_board_manager.h"
#include "esp_board_device.h"
#include "esp_board_manager_includes.h"
#include "settings.h"

#define TAG "AGENT_TOUCH"
#define TOUCH_NAME "lcd_touch"

bool agent_face_started(void);

static void tell_agent(void)
{
    esp_http_client_config_t cfg = {
        .url = AGENT_TOUCH_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) {
        return;
    }
    esp_http_client_set_header(client, "Authorization", "Bearer " AGENT_DEVICE_KEY);
    if (esp_http_client_perform(client) != ESP_OK) {
        ESP_LOGW(TAG, "The agent did not hear the touch");
    }
    esp_http_client_cleanup(client);
}

static void touch_task(void *arg)
{
    /* The touch sensor is held in reset together with the screen. Looking for it
     * before the screen is up finds nothing, so wait for the screen, give the
     * sensor a moment to wake, and try a few times. */
    while (!agent_face_started()) {
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    dev_lcd_touch_handles_t *handles = NULL;
    for (int attempt = 1; attempt <= 8; attempt++) {
        vTaskDelay(pdMS_TO_TICKS(500));
        if (esp_board_device_init(TOUCH_NAME) == ESP_OK &&
            esp_board_manager_get_device_handle(TOUCH_NAME, (void **)&handles) == ESP_OK &&
            handles != NULL && handles->touch_handle != NULL) {
            break;
        }
        handles = NULL;
        ESP_LOGW(TAG, "No touch sensor yet (try %d of 8)", attempt);
    }
    if (handles == NULL) {
        ESP_LOGE(TAG, "The touch sensor did not start");
        vTaskDelete(NULL);
        return;
    }
    esp_lcd_touch_handle_t touch = handles->touch_handle;
    ESP_LOGI(TAG, "Touch is ready");

    int down_for = 0;    /* how many looks in a row found a finger */
    bool told = false;   /* this touch was already reported */
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(40));
        esp_lcd_touch_point_data_t points[CONFIG_ESP_LCD_TOUCH_MAX_POINTS] = {0};
        uint8_t count = 0;
        if (esp_lcd_touch_read_data(touch) != ESP_OK ||
            esp_lcd_touch_get_data(touch, points, &count, CONFIG_ESP_LCD_TOUCH_MAX_POINTS) != ESP_OK) {
            count = 0;
        }
        if (count == 0) {
            down_for = 0;
            told = false;
            continue;
        }
        /* Two looks in a row, so a flicker is not a touch. One report per touch. */
        if (++down_for >= 2 && !told) {
            told = true;
            ESP_LOGI(TAG, "Touched");
            tell_agent();
            vTaskDelay(pdMS_TO_TICKS(600));
        }
    }
}

void agent_touch_start(void)
{
    xTaskCreatePinnedToCore(touch_task, "agent_touch", 6 * 1024, NULL, 4, NULL, 0);
}
