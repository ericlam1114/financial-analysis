import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseClient'; // Use the admin client

// Increase max duration if needed, signed URL generation should be fast though
// export const maxDuration = 30; 

export async function POST(request) {
  // Ensure admin client is initialized
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: 'Supabase admin client not initialized. Missing server environment variables.' },
      { status: 500 }
    );
  }

  try {
    // Expect filename AND file_id from the client request
    const { filename, file_id } = await request.json(); 
    if (!filename || !file_id) {
      return NextResponse.json({ error: 'Filename and file_id are required' }, { status: 400 });
    }

    // Basic validation for file_id format (optional but good practice)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(file_id)) {
        return NextResponse.json({ error: 'Invalid file_id format' }, { status: 400 });
    }

    const bucketName = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'royalty-files'; 
    // Basic sanitization: remove leading/trailing slashes and potentially harmful characters
    const sanitizedFilename = filename.replace(/^\/+|\/+$|\.\.\//g, ''); 
    // Use file_id in the path for better organization and uniqueness guarantee
    const filePath = `${file_id}/${sanitizedFilename}`; 

    console.log(`Generating signed upload URL for path: ${filePath}`);
    console.log(`Will associate with file_id: ${file_id}`);

    // Options for createSignedUploadUrl - include custom metadata
    const uploadOptions = {
        upsert: false, // Set to true if you want to allow overwriting (usually false)
        // Define custom metadata to store with the object
        metadata: {
            file_id: file_id, // Pass the validated file_id here
            // You could add other relevant info if needed, e.g., original_filename: filename
        }
    };

    const { data, error } = await supabaseAdmin.storage
      .from(bucketName)
      .createSignedUploadUrl(filePath, uploadOptions); // Pass options here

    if (error) {
      console.error('Error creating signed upload URL:', error);
      return NextResponse.json({ error: `Failed to create signed URL: ${error.message}` }, { status: 500 });
    }

    console.log('Signed URL generated successfully with file_id metadata instruction.');
    // Return the signed URL and the final path.
    // The client already has the file_id.
    return NextResponse.json({ signedUrl: data.signedUrl, path: data.path });

  } catch (e) {
    console.error('API Error in signed-url:', e);
    return NextResponse.json({ error: e.message || 'An unexpected error occurred.' }, { status: 500 });
  }
} 