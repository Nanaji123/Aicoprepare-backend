import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/**
 * Service-role Supabase client — has full admin access.
 * Used for server-side DB operations (insert, update, select).
 * NEVER expose this to the client.
 */
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/**
 * Anon-key Supabase client — used for JWT verification.
 * When we pass a user's JWT to getUser(), Supabase validates it
 * against the project's JWT secret.
 */
export const supabaseAuth = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
