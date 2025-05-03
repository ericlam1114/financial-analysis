import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// --- Client-side Client (for public access - BUT use Deno env vars here too) ---
// In Edge functions, there's no distinction like NEXT_PUBLIC_, use Deno.env for all
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY"); // Edge functions usually use service_key, but anon might be set too

if (!supabaseUrl) {
  throw new Error("Missing SUPABASE_URL environment variable for Edge Function.");
}
if (!supabaseAnonKey) {
  // If using only service key, this might be optional for the *public* client
  console.warn("Missing SUPABASE_ANON_KEY environment variable for Edge Function. Public client might be limited.");
  // Depending on usage, you might throw an error or allow it to be null
}

// Public client might have limited use inside Edge Functions if only service key is needed
export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

// --- Server-side Admin Client (for privileged operations) ---
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Create a singleton instance of the admin client
let supabaseAdmin = null;
if (supabaseUrl && supabaseServiceRoleKey) {
    console.log("Creating Supabase Admin client (using Deno.env)..." );
    supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
         auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
        // Ensure correct headers if using service role key
        global: { headers: { Authorization: `Bearer ${supabaseServiceRoleKey}` } }
    });
} else {
    console.warn(
        "Supabase Admin client could not be initialized. " +
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables for Edge Function."
    );
}

export { supabaseAdmin }; // Export the admin client instance 