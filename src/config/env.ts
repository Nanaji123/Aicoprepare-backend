import "dotenv/config";

/**
 * Centralised, validated environment configuration.
 * The server fails fast at startup if any required variable is missing.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`❌ Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  /** Server */
  PORT: parseInt(optionalEnv("PORT", "3001"), 10),
  NODE_ENV: optionalEnv("NODE_ENV", "development"),

  /** Supabase */
  SUPABASE_URL: requireEnv("SUPABASE_URL"),
  SUPABASE_ANON_KEY: requireEnv("SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),

  /** OpenAI */
  OPENAI_API_KEY: requireEnv("OPENAI_API_KEY"),

  /** Deepgram */
  DEEPGRAM_API_KEY: requireEnv("DEEPGRAM_API_KEY"),

  /** CORS */
  CORS_ORIGINS: optionalEnv("CORS_ORIGINS", "http://localhost:5173").split(","),
} as const;
