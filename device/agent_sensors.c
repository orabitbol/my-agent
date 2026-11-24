/* my-agent: the room's temperature and humidity.
 *
 * The blue base under the device (ESP32-S3-BOX-3-SENSOR) has a temperature and
 * humidity sensor. This reads it and tells the agent twice a minute, so the
 * agent can answer "how warm is it here?". Without the base this does nothing.
 *
 * (The base also has a radar that notices movement. It is not used.)
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "settings.h"
#include "agent_parts.h"

#define TAG "AGENT_SENSORS"

/* How the base is wired (from Espressif's own code for it). */
#define BASE_SCL        GPIO_NUM_40
#define BASE_SDA        GPIO_NUM_41
#define CLIMATE_ADDRESS 0x38          /* AHT20 */
#define REPORT_EVERY_MS 30000

static i2c_master_dev_handle_t climate;

/* Reads the temperature (in tenths of a degree) and the humidity (in percent). */
static bool read_climate(int *tenths, int *percent)
{
    const uint8_t measure[3] = {0xAC, 0x33, 0x00};
    uint8_t answer[6] = {0};
    if (i2c_master_transmit(climate, measure, sizeof(measure), 100) != ESP_OK) {
        return false;
    }
    vTaskDelay(pdMS_TO_TICKS(90));
    if (i2c_master_receive(climate, answer, sizeof(answer), 100) != ESP_OK || (answer[0] & 0x80)) {
        return false; /* no answer, or still measuring */
    }
    uint32_t raw_humidity = ((uint32_t)answer[1] << 12) | ((uint32_t)answer[2] << 4) | (answer[3] >> 4);
    uint32_t raw_temperature = ((uint32_t)(answer[3] & 0x0F) << 16) | ((uint32_t)answer[4] << 8) | answer[5];
    *percent = (int)((uint64_t)raw_humidity * 100 / 1048576);
    *tenths = (int)((uint64_t)raw_temperature * 2000 / 1048576) - 500;
    return true;
}

static void tell_agent(const char *body)
{
    esp_http_client_config_t cfg = {
        .url = AGENT_SENSE_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) {
        return;
    }
    esp_http_client_set_header(client, "Authorization", "Bearer " AGENT_DEVICE_KEY);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, strlen(body));
    esp_http_client_perform(client);
    esp_http_client_cleanup(client);
}

static void sensors_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(1500)); /* let the rest of the device start first */
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = -1, /* any port the device is not using */
        .sda_io_num = BASE_SDA,
        .scl_io_num = BASE_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus = NULL;
    if (i2c_new_master_bus(&bus_cfg, &bus) != ESP_OK) {
        ESP_LOGE(TAG, "Could not reach the base's sensors");
        agent_park();
    }
    if (i2c_master_probe(bus, CLIMATE_ADDRESS, 100) != ESP_OK) {
        ESP_LOGW(TAG, "No sensor base under the device");
        i2c_del_master_bus(bus);
        agent_park();
    }
    i2c_device_config_t device_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = CLIMATE_ADDRESS,
        .scl_speed_hz = 100000,
    };
    if (i2c_master_bus_add_device(bus, &device_cfg, &climate) != ESP_OK) {
        ESP_LOGE(TAG, "Could not reach the temperature sensor");
        agent_park();
    }
    ESP_LOGI(TAG, "Temperature and humidity: ready");

    char body[64];
    while (1) {
        int tenths = 0, percent = 0;
        if (agent_online() && read_climate(&tenths, &percent)) {
            snprintf(body, sizeof(body), "{\"temp\":%d.%d,\"humidity\":%d}", tenths / 10, abs(tenths % 10), percent);
            tell_agent(body);
        }
        vTaskDelay(pdMS_TO_TICKS(REPORT_EVERY_MS));
    }
}

void agent_sensors_start(void)
{
    agent_task(sensors_task, "agent_sensors", 6 * 1024, 3);
}
