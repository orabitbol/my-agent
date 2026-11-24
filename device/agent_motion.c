/* my-agent: the character feels the device being moved.
 *
 * The device has a small motion sensor inside (ICM-42607). This watches it:
 * shake the device and the character gets dizzy; lift or tilt it and it looks
 * surprised. It all happens on the device itself, at once; nothing is sent
 * anywhere. It shows only while the character is on the device's screen.
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "driver/i2c_master.h"
#include "esp_board_manager.h"
#include "agent_parts.h"

#define TAG "AGENT_MOTION"

/* The sensor, as Espressif's own driver for it uses it. */
#define SENSOR_ADDRESS   0x68
#define SENSOR_ADDRESS_2 0x69
#define REG_POWER        0x1F  /* 0x03: measuring acceleration */
#define REG_SETTINGS     0x21  /* range and how often it measures */
#define REG_DATA         0x0B  /* six bytes: x, y, z, high byte first */
#define SETTINGS_4G_50HZ 0x4A
#define COUNTS_PER_G     8192.0f

/* The numbers to tune. Acceleration is in g: lying still, the device feels 1 g, straight down. */
#define SHAKE_JOLT       0.9f  /* a change this large between two looks is a jolt... */
#define SHAKE_JOLTS      3     /* ...and this many jolts within a second is a shake */
#define TILT_DEGREES     35.0f /* leaning this far from how it stood is being lifted or tilted */

void agent_face_react(int kind); /* 1: shaken (dizzy). 2: lifted or tilted (surprised). */

static i2c_master_dev_handle_t sensor;

static bool write_register(uint8_t reg, uint8_t value)
{
    uint8_t message[2] = {reg, value};
    return i2c_master_transmit(sensor, message, sizeof(message), 100) == ESP_OK;
}

static bool read_g(float *x, float *y, float *z)
{
    uint8_t reg = REG_DATA, raw[6];
    if (i2c_master_transmit_receive(sensor, &reg, 1, raw, sizeof(raw), 100) != ESP_OK) {
        return false;
    }
    *x = (int16_t)((raw[0] << 8) | raw[1]) / COUNTS_PER_G;
    *y = (int16_t)((raw[2] << 8) | raw[3]) / COUNTS_PER_G;
    *z = (int16_t)((raw[4] << 8) | raw[5]) / COUNTS_PER_G;
    return true;
}

static void motion_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(2500)); /* after the screen, the touch sensor and the sound are up */
    i2c_master_bus_handle_t bus = NULL;
    if (esp_board_manager_get_periph_handle("i2c_master", (void **)&bus) != ESP_OK || bus == NULL) {
        ESP_LOGE(TAG, "Could not reach the motion sensor's wiring");
        agent_park();
    }
    uint16_t address = i2c_master_probe(bus, SENSOR_ADDRESS, 100) == ESP_OK ? SENSOR_ADDRESS : SENSOR_ADDRESS_2;
    i2c_device_config_t device_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = address,
        .scl_speed_hz = 100000,
    };
    float x, y, z;
    if (i2c_master_bus_add_device(bus, &device_cfg, &sensor) != ESP_OK ||
        !write_register(REG_SETTINGS, SETTINGS_4G_50HZ) || !write_register(REG_POWER, 0x03)) {
        ESP_LOGE(TAG, "The motion sensor did not start");
        agent_park();
    }
    vTaskDelay(pdMS_TO_TICKS(100));
    if (!read_g(&x, &y, &z)) {
        ESP_LOGE(TAG, "The motion sensor does not answer");
        agent_park();
    }
    ESP_LOGI(TAG, "Motion sensor is ready");

    float last_x = x, last_y = y, last_z = z;  /* the look before this one */
    float rest_x = x, rest_y = y, rest_z = z;  /* how it stands when left alone (follows slowly) */
    int jolts = 0, since_jolt = 100, quiet_for = 0;
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(50));
        if (!read_g(&x, &y, &z)) {
            continue;
        }
        float jolt = sqrtf((x - last_x) * (x - last_x) + (y - last_y) * (y - last_y) + (z - last_z) * (z - last_z));
        last_x = x, last_y = y, last_z = z;
        if (quiet_for > 0) {
            quiet_for--; /* it just reacted: let it finish */
            rest_x = x, rest_y = y, rest_z = z;
            continue;
        }

        /* A shake: several jolts close together. */
        since_jolt++;
        if (jolt > SHAKE_JOLT) {
            jolts = since_jolt < 20 ? jolts + 1 : 1;
            since_jolt = 0;
            if (jolts >= SHAKE_JOLTS) {
                ESP_LOGI(TAG, "Shaken");
                agent_face_react(1);
                jolts = 0;
                quiet_for = 50;
                continue;
            }
        }

        /* Lifted or tilted: "down" points somewhere else than when it stood still. */
        float now = sqrtf(x * x + y * y + z * z), rest = sqrtf(rest_x * rest_x + rest_y * rest_y + rest_z * rest_z);
        if (now > 0.5f && rest > 0.5f) {
            float cosine = (x * rest_x + y * rest_y + z * rest_z) / (now * rest);
            if (cosine < cosf(TILT_DEGREES * 3.14159f / 180.0f)) {
                ESP_LOGI(TAG, "Lifted or tilted");
                agent_face_react(2);
                quiet_for = 40;
                continue;
            }
        }
        /* Left alone, "how it stands" slowly follows where it is now, so a new resting place is not a tilt forever. */
        rest_x += (x - rest_x) * 0.02f, rest_y += (y - rest_y) * 0.02f, rest_z += (z - rest_z) * 0.02f;
    }
}

void agent_motion_start(void)
{
    agent_task(motion_task, "agent_motion", 6 * 1024, 3);
}
