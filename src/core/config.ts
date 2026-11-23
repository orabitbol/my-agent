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
  model: required("OPENAI_MODEL"),
};
