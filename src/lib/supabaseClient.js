import { createClient } from '@supabase/supabase-js';

// --- Client-side Client (for public access) ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("Missing env.NEXT_PUBLIC_SUPABASE_URL");
}
if (!supabaseAnonKey) {
  throw new Error("Missing env.NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// --- Server-side Admin Client (for privileged operations) ---
// Ensure these are NOT prefixed with NEXT_PUBLIC_ so they are not exposed to the client
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Create a singleton instance of the admin client
let supabaseAdmin = null;
if (supabaseUrl && supabaseServiceRoleKey) {
    console.log("Creating Supabase Admin client...");
    supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
         auth: {
            // Required for server-side operations like creating signed URLs
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        }
    });
} else {
    console.warn(
        "Supabase Admin client not initialized. " +
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
    );
}

export { supabaseAdmin }; // Export the admin client instance 