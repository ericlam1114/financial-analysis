// supabase/functions/_shared/cors.ts
// Standard CORS headers for allowing requests (adjust origins as needed for production)

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // Allow all origins (restrict in production)
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' // Specify allowed methods
}; 