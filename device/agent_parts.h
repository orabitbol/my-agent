/* my-agent: what the agent's parts on the device share.
 *
 * The device has little fast memory (about 200 KB) and the voice call needs
 * most of it. So everything the agent adds lives in the large, slower memory
 * (16 MB): each part's task gets its stack there.
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#pragma once
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include "esp_heap_caps.h"
#include "esp_log.h"

/* Starts one of the agent's parts, with its stack in the large memory. */
static inline void agent_task(TaskFunction_t run, const char *name, int stack_bytes, int priority)
{
    if (xTaskCreatePinnedToCoreWithCaps(run, name, stack_bytes, NULL, priority, NULL, 0, MALLOC_CAP_SPIRAM) != pdPASS) {
        ESP_LOGE("AGENT", "No memory to start %s", name);
    }
}

/* A part that cannot go on stays here. (A task whose stack is in the large memory must not end itself.) */
static inline void agent_park(void)
{
    while (1) {
        vTaskDelay(portMAX_DELAY);
    }
}

/* True once the device is on the network (agent_settings.c knows). */
bool agent_online(void);
