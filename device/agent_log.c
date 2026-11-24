/* my-agent: the device's log, sent to the computer.
 *
 * Everything the device prints normally goes only to the USB cable, where a
 * terminal has to be open to read it. This also sends the lines that matter
 * (our own parts, and every warning and error) to the agent, which shows them
 * in the app under "לוגים". Lines printed before the network is up wait in a
 * small queue and are sent once it is.
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "settings.h"
#include "agent_parts.h"

#define LINE_BYTES 128
#define LINES_KEPT 48
#define BATCH_BYTES 1400

static QueueHandle_t waiting;
static vprintf_like_t printed_before;

/* Every printed line passes through here on its way to the cable. */
static int also_keep(const char *format, va_list args)
{
    char line[LINE_BYTES];
    va_list copy;
    va_copy(copy, args);
    int length = vsnprintf(line, sizeof(line), format, copy);
    va_end(copy);
    if (length > 0 && waiting) {
        const char *text = line;
        if (text[0] == '\033') { /* skip the color code in front */
            const char *end = strchr(text, 'm');
            text = end ? end + 1 : text;
        }
        bool ours = strstr(text, "AGENT_") != NULL;
        bool trouble = (text[0] == 'E' || text[0] == 'W') && text[1] == ' ';
        /* Not the lines about sending itself: when the computer is away they would feed on themselves. */
        bool about_sending = strstr(text, "HTTP_CLIENT") || strstr(text, "esp-tls") || strstr(text, "transport_base");
        if ((ours || trouble) && !about_sending) {
            xQueueSend(waiting, line, 0); /* full queue: the line is dropped, nothing waits */
        }
    }
    return printed_before ? printed_before(format, args) : vprintf(format, args);
}

static bool send_lines(const char *text, int length)
{
    esp_http_client_config_t cfg = {
        .url = AGENT_LOG_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) {
        return false;
    }
    esp_http_client_set_header(client, "Authorization", "Bearer " AGENT_DEVICE_KEY);
    esp_http_client_set_post_field(client, text, length);
    bool sent = esp_http_client_perform(client) == ESP_OK && esp_http_client_get_status_code(client) == 204;
    esp_http_client_cleanup(client);
    return sent;
}

static void log_task(void *arg)
{
    static char batch[BATCH_BYTES];
    char line[LINE_BYTES];
    while (1) {
        /* Wait for a line, then gather the ones right behind it into one message. */
        if (xQueueReceive(waiting, line, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        int used = 0;
        do {
            line[LINE_BYTES - 1] = 0;
            int length = strlen(line);
            if (used + length + 1 >= BATCH_BYTES) {
                break;
            }
            memcpy(batch + used, line, length);
            used += length;
            if (length == 0 || line[length - 1] != '\n') {
                batch[used++] = '\n';
            }
        } while (xQueueReceive(waiting, line, pdMS_TO_TICKS(200)) == pdTRUE);

        while (!agent_online() || !send_lines(batch, used)) {
            vTaskDelay(pdMS_TO_TICKS(2000)); /* the computer is not there yet: keep this message and try again */
        }
    }
}

void agent_log_start(void)
{
    waiting = xQueueCreateWithCaps(LINES_KEPT, LINE_BYTES, MALLOC_CAP_SPIRAM);
    if (waiting == NULL) {
        return;
    }
    printed_before = esp_log_set_vprintf(also_keep);
    agent_task(log_task, "agent_log", 6 * 1024, 2);
}
