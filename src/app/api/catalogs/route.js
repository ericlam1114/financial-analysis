import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Use createClient from supabase-js for route handlers
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing Supabase environment variables for API route");
}

const supabase = createClient(supabaseUrl ?? '', supabaseServiceKey ?? '', {
    auth: { persistSession: false }
});

export const runtime = 'edge'; // Optional: Use edge runtime if preferred

export async function GET() {
    try {
        console.log("Attempting to call RPC: get_distinct_catalogs_with_names");
        // *** IMPORTANT: Ensure the RPC function 'get_distinct_catalogs_with_names' exists in your Supabase project ***
        const { data, error } = await supabase.rpc('get_distinct_catalogs_with_names');

        if (error) {
            console.error('Supabase RPC error fetching catalogs:', error);
            // Provide a more specific error message if possible
            const errorMessage = error.message.includes("function public.get_distinct_catalogs_with_names() does not exist")
                ? "Database function 'get_distinct_catalogs_with_names' not found. Please ensure it has been created in the Supabase SQL editor."
                : `Database error: ${error.message}`;
            return NextResponse.json({ error: errorMessage }, { status: 500 });
        }

        console.log("Successfully fetched distinct catalogs:", data);
        return NextResponse.json(data);

    } catch (e) {
        console.error('API error fetching catalogs:', e);
        const message = e instanceof Error ? e.message : "An unknown error occurred";
        return NextResponse.json({ error: `API Error: ${message}` }, { status: 500 });
    }
}

/*
SQL for the RPC function (run in Supabase SQL Editor):

CREATE OR REPLACE FUNCTION get_distinct_catalogs_with_names()
RETURNS TABLE(catalog TEXT, client_name TEXT)
LANGUAGE sql STABLE
AS $$
  SELECT DISTINCT ON (catalog)
    catalog,
    content->>'Client Name' as client_name
  FROM public.rows
  WHERE content->>'Client Name' IS NOT NULL -- Only include rows where Client Name exists
  ORDER BY catalog; -- Order ensures DISTINCT ON picks consistently (optional, but good practice)
$$;

*/ 