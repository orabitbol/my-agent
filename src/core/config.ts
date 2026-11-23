// Reads settings from the environment (.env). Fails early with a clear message.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const config = {
  openaiApiKey: required("OPENAI_API_KEY"),
  // The model that thinks in the text chat.
  model: required("OPENAI_MODEL"),
  // Voice. These have defaults, so an older .env keeps working.
  voiceModel: process.env.OPENAI_VOICE_MODEL || "gpt-realtime-2.1",
  voice: process.env.OPENAI_VOICE || "marin",
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe",
  // Background-noise filter for the microphone: "far_field" suits a laptop's own
  // microphone, "near_field" suits a headset. "off" turns it off.
  voiceNoise: process.env.OPENAI_VOICE_NOISE || "far_field",
};
