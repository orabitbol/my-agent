/* my-agent: the character's face on the device's small screen.
 *
 * The same character that floats on the computer: a round body, two eyes and a
 * mouth. The computer decides what it is doing (resting, listening, thinking,
 * speaking) and whether it is here at all; this file only draws it.
 *
 * It is on ONE screen at a time. When it leaves the computer it grows out of a
 * point here; when it goes back it shrinks into a point and the screen goes dark.
 *
 * The drawing part (everything above "the screen itself") is plain arithmetic,
 * so it can also be built on a computer to look at the frames.
 *
 * connect-to-agent.sh copies this file into the demo's "main" folder.
 */
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define SCREEN_W 320
#define SCREEN_H 240
/* The part of the screen the character can reach. Only this part is redrawn. */
#define AREA_X 64
#define AREA_Y 24
#define AREA_W 192
#define AREA_H 192
#define STRIP_ROWS 16 /* AREA_W * STRIP_ROWS * 2 bytes must fit one transfer (6400) */

#define CENTER_X 160.0f
#define CENTER_Y 120.0f
#define BODY_HALF_W 58.0f
#define BODY_HALF_H 54.0f
#define BODY_ROUND 40.0f
#define GLOW_REACH 26.0f
#define EYE_APART 21.0f
#define EYE_HALF_W 7.0f
#define EYE_HALF_H 13.0f
#define MOUTH_HALF_W 10.0f
#define ARRIVE_MS 520
#define LEAVE_MS 380

typedef enum { FACE_RESTING, FACE_READY, FACE_LISTENING, FACE_HEARING, FACE_THINKING, FACE_SPEAKING, FACE_APPROVAL } face_state_t;

typedef struct { float r, g, b; } color_t;

/* The same colors as the character on the computer (tokens.css). */
static const color_t ACCENT = {0, 122, 255}, GREEN = {52, 199, 89}, PURPLE = {175, 82, 222}, ORANGE = {255, 149, 0}, GRAY = {142, 142, 147};

/* Everything one frame needs. */
typedef struct {
    float   scale;     /* 0: not here. 1: full size */
    color_t mood;      /* the body's color */
    float   glow;      /* how strong the light around it is, 0 to 1 */
    float   eye_open;  /* 1 is normal, 0 is shut */
    float   look_x;    /* where the eyes look, in pixels */
    float   look_y;
    float   mouth;     /* 0: no mouth. Otherwise how far it is open, in pixels */
    float   lift;      /* the whole body floats up and down a little */
} face_frame_t;

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static color_t mix(color_t a, color_t b, float t) { return (color_t){a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t}; }

/* How far a point is from the edge of a rounded box: negative inside, positive outside. */
static float box_distance(float x, float y, float half_w, float half_h, float round)
{
    float qx = fabsf(x) - (half_w - round);
    float qy = fabsf(y) - (half_h - round);
    float ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
    float inside = qx > qy ? qx : qy;
    return sqrtf(ox * ox + oy * oy) + (inside < 0 ? inside : 0) - round;
}

static color_t pixel(float x, float y, const face_frame_t *f)
{
    const color_t black = {0, 0, 0}, white = {255, 255, 255};
    if (f->scale <= 0.01f) {
        return black;
    }
    float s = f->scale;
    float px = (x - CENTER_X) / s, py = (y - (CENTER_Y + f->lift)) / s; /* in the body's own size */
    float d = box_distance(px, py, BODY_HALF_W, BODY_HALF_H, BODY_ROUND) * s;

    /* The light around the body. */
    color_t out = black;
    if (d < GLOW_REACH) {
        float fade = 1.0f - clampf(d / GLOW_REACH, 0, 1);
        out = mix(black, f->mood, 0.55f * f->glow * fade * fade);
    }
    if (d > 0.5f) {
        return out;
    }

    /* The body: lighter at the top, like something lit from above. */
    float height = clampf((py + BODY_HALF_H) / (2 * BODY_HALF_H), 0, 1);
    color_t body = mix(mix(f->mood, white, 0.35f), f->mood, clampf(height * 1.4f, 0, 1));

    /* The eyes. */
    float eye_h = EYE_HALF_H * f->eye_open;
    if (eye_h < 2.0f) {
        eye_h = 2.0f;
    }
    float ex = fabsf(px - f->look_x) - EYE_APART;
    float eye = box_distance(ex, py + 6.0f - f->look_y, EYE_HALF_W, eye_h, eye_h < EYE_HALF_W ? eye_h : EYE_HALF_W) * s;
    body = mix(body, white, clampf(0.5f - eye, 0, 1));

    /* The mouth, only while it speaks. */
    if (f->mouth > 0.5f) {
        float half_h = f->mouth / 2;
        float mouth = box_distance(px - f->look_x * 0.5f, py - 27.0f, MOUTH_HALF_W, half_h, half_h < 5.0f ? half_h : 5.0f) * s;
        body = mix(body, white, clampf(0.5f - mouth, 0, 1) * 0.95f);
    }
    return mix(body, out, clampf(d + 0.5f, 0, 1)); /* a soft edge */
}

/* Draws rows [y0, y0 + rows) of the character's area into `out`, as the screen wants them. */
static void render_strip(uint16_t *out, int y0, int rows, const face_frame_t *f, bool swap_bytes)
{
    for (int row = 0; row < rows; row++) {
        for (int col = 0; col < AREA_W; col++) {
            color_t c = pixel(AREA_X + col + 0.5f, y0 + row + 0.5f, f);
            uint16_t v = (uint16_t)(((int)c.r >> 3) << 11 | ((int)c.g >> 2) << 5 | ((int)c.b >> 3));
            *out++ = swap_bytes ? (uint16_t)(v << 8 | v >> 8) : v;
        }
    }
}

static float ease_out_back(float t) { float u = t - 1; return 1 + 2.2f * u * u * u + 1.2f * u * u; }

/* What the face looks like `now_ms` into its life. `since_ms` is how long ago it arrived or began to leave. */
static face_frame_t frame_at(face_state_t state, bool here, uint32_t now_ms, uint32_t since_ms)
{
    face_frame_t f = {.scale = 1, .mood = ACCENT, .glow = 0.6f, .eye_open = 1};
    float t = now_ms / 1000.0f;

    if (here) {
        f.scale = since_ms >= ARRIVE_MS ? 1 : clampf(ease_out_back((float)since_ms / ARRIVE_MS), 0, 1.2f);
    } else {
        float gone = clampf((float)since_ms / LEAVE_MS, 0, 1);
        f.scale = 1 - gone * gone;
    }
    f.scale *= 1 + 0.015f * sinf(t * 1.96f);  /* breathing */
    f.lift = 3.0f * sinf(t * 1.96f);

    switch (state) {
        case FACE_RESTING:   f.mood = mix(ACCENT, GRAY, 0.55f); f.glow = 0.3f; break;
        case FACE_READY:     break;
        case FACE_LISTENING: f.eye_open = 1.15f; break;
        case FACE_HEARING:   f.mood = GREEN; f.eye_open = 1.25f; f.glow = 0.7f + 0.3f * sinf(t * 7.8f); break;
        case FACE_THINKING:  f.mood = PURPLE; f.eye_open = 0.75f; f.look_x = 5.0f * sinf(t * 2.9f); f.look_y = -4; break;
        case FACE_SPEAKING:  f.mouth = 4 + 9 * fabsf(sinf(t * 9.0f) * sinf(t * 2.3f + 1)); f.glow = 0.8f; break;
        case FACE_APPROVAL:  f.mood = ORANGE; f.eye_open = 1.15f; f.lift -= 6.0f * fabsf(sinf(t * 3.9f)); break;
    }
    /* A blink, every few seconds. */
    uint32_t in_cycle = now_ms % 4300;
    if (in_cycle < 130) {
        f.eye_open *= 0.12f;
    }
    return f;
}

#ifndef FACE_PREVIEW
/* ------------------------------ the screen itself ------------------------------ */
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_ops.h"
#include "driver/ledc.h"
#include "esp_board_manager.h"
#include "esp_board_device.h"
#include "esp_board_manager_includes.h"

#define TAG "AGENT_FACE"
#define LCD_NAME "display_lcd"
#define LIGHT_NAME "lcd_brightness"

static volatile bool screen_started; /* the screen has been through its reset (or failed to start) */
static volatile bool want_here;

/* The touch sensor shares the screen's reset line, so it can only be looked for after this. */
bool agent_face_started(void)
{
    return screen_started;
}
static volatile face_state_t want_state = FACE_RESTING;

/* Called when the computer says where the character is and what it is doing. */
void agent_face_set(bool here, const char *face)
{
    static const char *names[] = {"resting", "ready", "listening", "hearing", "thinking", "speaking", "approval"};
    for (int i = 0; i < 7; i++) {
        if (face && strcmp(face, names[i]) == 0) {
            want_state = (face_state_t)i;
        }
    }
    want_here = here;
}

static void backlight(int percent)
{
    periph_ledc_handle_t *light = NULL;
    dev_ledc_ctrl_config_t *light_cfg = NULL;
    periph_ledc_config_t *ledc_cfg = NULL;
    if (esp_board_manager_get_device_handle(LIGHT_NAME, (void **)&light) != ESP_OK || light == NULL ||
        esp_board_manager_get_device_config(LIGHT_NAME, (void **)&light_cfg) != ESP_OK || light_cfg == NULL ||
        esp_board_manager_get_periph_config(light_cfg->ledc_name, (void **)&ledc_cfg) != ESP_OK || ledc_cfg == NULL) {
        return;
    }
    uint32_t duty = ((uint32_t)percent * ((1u << (uint32_t)ledc_cfg->duty_resolution) - 1)) / 100;
    ledc_set_duty(light->speed_mode, light->channel, duty);
    ledc_update_duty(light->speed_mode, light->channel);
}

static void face_task(void *arg)
{
    int lcd_started = esp_board_device_init(LCD_NAME);
    screen_started = true;
    if (lcd_started != ESP_OK) {
        ESP_LOGE(TAG, "The screen did not start");
        vTaskDelete(NULL);
        return;
    }
    if (esp_board_device_init(LIGHT_NAME) != ESP_OK) {
        ESP_LOGW(TAG, "The screen's light did not start");
    }
    dev_display_lcd_handles_t *lcd = NULL;
    dev_display_lcd_config_t *lcd_cfg = NULL;
    if (esp_board_manager_get_device_handle(LCD_NAME, (void **)&lcd) != ESP_OK || lcd == NULL || lcd->panel_handle == NULL) {
        ESP_LOGE(TAG, "No screen to draw on");
        vTaskDelete(NULL);
        return;
    }
    bool swap = true;
    if (esp_board_manager_get_device_config(LCD_NAME, (void **)&lcd_cfg) == ESP_OK && lcd_cfg != NULL) {
        swap = lcd_cfg->frame_format != DEV_DISPLAY_LCD_FRAME_FORMAT_RGB565_LE;
    }
    esp_lcd_panel_handle_t panel = lcd->panel_handle;

    /* Two small buffers, used in turns: while one is on its way to the screen, the next strip is drawn into the other. */
    const size_t bytes = SCREEN_W * 10 * 2;
    uint16_t *buffers[2] = {
        heap_caps_malloc(bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL),
        heap_caps_malloc(bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL),
    };
    if (buffers[0] == NULL || buffers[1] == NULL) {
        ESP_LOGE(TAG, "No memory for the screen");
        vTaskDelete(NULL);
        return;
    }
    int turn = 0;

    /* Start dark and black. */
    backlight(0);
    for (int y = 0; y < SCREEN_H; y += 8) {
        memset(buffers[turn], 0, SCREEN_W * 8 * 2);
        esp_lcd_panel_draw_bitmap(panel, 0, y, SCREEN_W, y + 8, buffers[turn]);
        turn ^= 1;
    }
    ESP_LOGI(TAG, "The screen is ready");

    bool here = false;      /* what is being shown now */
    bool lit = false;
    uint32_t changed_at = 0;
    while (1) {
        uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        if (want_here != here) {
            here = want_here;
            changed_at = now;
            ESP_LOGI(TAG, "The character %s", here ? "arrives" : "leaves");
        }
        uint32_t since = now - changed_at;
        if (!here && since > LEAVE_MS + 200) {
            if (lit) {
                backlight(0);
                lit = false;
            }
            vTaskDelay(pdMS_TO_TICKS(100)); /* not here: nothing to draw */
            continue;
        }
        face_frame_t frame = frame_at(want_state, here, now, since);
        for (int y = AREA_Y; y < AREA_Y + AREA_H; y += STRIP_ROWS) {
            render_strip(buffers[turn], y, STRIP_ROWS, &frame, swap);
            esp_lcd_panel_draw_bitmap(panel, AREA_X, y, AREA_X + AREA_W, y + STRIP_ROWS, buffers[turn]);
            turn ^= 1;
        }
        if (!lit) {
            backlight(80);
            lit = true;
        }
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

void agent_face_start(void)
{
    xTaskCreatePinnedToCore(face_task, "agent_face", 6 * 1024, NULL, 3, NULL, 0);
}
#endif /* FACE_PREVIEW */
