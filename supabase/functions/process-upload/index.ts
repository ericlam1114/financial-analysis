// supabase/functions/process-upload/index.ts
// Triggered when a file is uploaded to the storage bucket.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts' // Use a specific std version
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts' // Assuming you have CORS headers defined

console.log("Process Upload Edge Function Initializing (v2 - Queue Job)")

// Define the structure of the webhook payload from Supabase Storage trigger
// Adjust based on actual payload if needed
interface StorageWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string; // Should be 'objects' for storage triggers
  schema: string; // Should be 'storage'
  record: {
    id: string; // Storage Object ID (UUID)
    bucket_id: string; // e.g., 'uploads'
    name: string; // Object name/key, e.g., 'user_uuid/file_uuid/filename.csv'
    owner?: string; // User ID if available
    metadata?: Record<string, any>; // Any metadata set during upload
    // ... other storage object properties
  } | null;
  old_record: any | null;
}

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Initialize Supabase Admin Client (uses Service Role Key)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      // Use options suitable for Deno Edge Functions and Service Role
      { 
        auth: { 
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false 
        },
        global: { 
            // Ensure Authorization header is passed if needed, though SERVICE_KEY bypasses RLS
            // headers: { 'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` } 
        } 
      }
    )
    console.log("Supabase Admin client initialized in Edge Function (v2).");

    // 2. Parse the incoming webhook payload
    const payload: StorageWebhookPayload = await req.json()
    console.log("Received storage webhook payload (v2):", JSON.stringify(payload, null, 2));

    // Ensure it's an INSERT event for a storage object
    if (payload.type !== 'INSERT' || payload.table !== 'objects' || payload.schema !== 'storage' || !payload.record || !payload.record.name) {
        console.warn("Ignoring event: Not a storage object insertion or missing record data.", payload.type, payload.table);
        return new Response(JSON.stringify({ message: 'Ignoring non-insert storage event or incomplete data' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200, // Acknowledge receipt, but don't treat as error
        })
    }

    const storagePath = payload.record.name // e.g., 'user_uuid/file_uuid/filename.csv'
    const bucketName = payload.record.bucket_id

    // Optional: Check bucket if needed
    // const TARGET_BUCKET_NAME = Deno.env.get("SUPABASE_STORAGE_BUCKET_NAME") || "uploads"; 
    // if (bucketName !== TARGET_BUCKET_NAME) { ... return ... }

    console.log(`Processing storage event for path: ${bucketName}/${storagePath}`);

    // 3. Extract file_id from the storage path OR from metadata
    //    Attempt 1: Look for file_id in storage object metadata (set during upload)
    let fileId = payload.record.metadata?.file_id; 
    
    //    Attempt 2: Fallback to parsing from path (if metadata not set)
    //    ASSUMPTION: Path structured like 'user_uuid/file_id/filename.ext' OR 'file_id/filename.ext'
    if (!fileId) {
        console.log("No file_id found in metadata, attempting to parse from path...");
        const pathParts = storagePath.split('/');
        // If path is 'file_id/filename.ext', file_id is the first part
        // If path is 'user_id/file_id/filename.ext', file_id is the second part
        const potentialFileIdSegment = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : null; 

        if (!potentialFileIdSegment) {
            console.error("Could not extract file_id segment from storage path:", storagePath);
            throw new Error(`Invalid storage path format for file_id extraction: ${storagePath}`);
        }
        // Basic UUID check regex
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(potentialFileIdSegment)) {
            console.error(`Extracted segment "${potentialFileIdSegment}" from path does not appear to be a valid UUID.`);
            throw new Error(`Extracted segment from path is not a valid UUID: ${potentialFileIdSegment}`);
        }
        fileId = potentialFileIdSegment;
        console.log("Extracted file_id from path:", fileId);
    } else {
        console.log("Extracted file_id from metadata:", fileId);
    }
    
    if (!fileId) {
         throw new Error(`Could not determine file_id for storage object: ${storagePath}`);
    }

    // 4. Fetch related file metadata (catalog, doc_type) from the 'files' table
    console.log(`Fetching metadata for file_id ${fileId} from 'files' table...`);
    const { data: fileData, error: fileError } = await supabaseAdmin
      .from('files')
      .select('catalog, doc_type') // Select only needed columns
      .eq('id', fileId)
      .maybeSingle(); // Use maybeSingle to handle potential null without error

    if (fileError) {
      // Log the error but don't necessarily throw, maybe queue job with defaults?
      console.error(`Error fetching file metadata for ${fileId}:`, fileError);
      // Decide how to handle: throw error, or queue with null/default catalog/doc_type?
      // For now, we'll throw, as catalog/doc_type seem important.
      throw new Error(`Failed to fetch file metadata: ${fileError.message}`);
    }

    if (!fileData) {
      // Log the error but don't necessarily throw, maybe queue job with defaults?
      console.error(`No file record found in 'files' table for file_id ${fileId}. Check if record was created before upload completed.`);
      // Decide how to handle: throw error, or queue with null/default catalog/doc_type?
      // For now, we'll throw.
       throw new Error(`File record not found for id ${fileId}`);
    }
    console.log("Found file metadata:", fileData);

    // 5. Insert job into the 'processing_queue' table
    const jobData = {
      file_id: fileId,
      storage_path: storagePath, // Store the full path within the bucket
      catalog: fileData.catalog || 'unknown', // Use fetched or default
      doc_type: fileData.doc_type || 'unknown', // Use fetched or default
      status: 'pending',
      attempts: 0,
    };
    console.log("Inserting job into processing_queue:", jobData);

    const { error: insertError } = await supabaseAdmin
      .from('processing_queue')
      .insert(jobData);

    if (insertError) {
      console.error("Error inserting job into processing_queue:", insertError);
      throw new Error(`Failed to insert processing job: ${insertError.message}`);
    }

    console.log(`Successfully queued job for file_id ${fileId}`);

    // 6. Return success response
    return new Response(JSON.stringify({ message: 'File processing job queued successfully' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error("Error in process-upload function (v2):", error);
    // Log error to Supabase table?
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})

/*
To Deploy:
1. Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Edge Function secrets.
2. Ensure _shared/cors.ts exists or remove the import if not needed.
3. Deploy using Supabase CLI: `supabase functions deploy process-upload --no-verify-jwt`
*/ 