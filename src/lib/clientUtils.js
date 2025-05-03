// Placeholder for src/lib/clientUtils.js
// Contains client-side helper functions, e.g., for file uploads

// import { supabase } from './supabaseClient'; // No longer using client-side storage upload
// import { ingestFile } from './ingest'; // ingestFile likely runs server-side or in an Edge Function

/**
 * Uploads a file to Supabase Storage using a server-generated signed URL.
 * @param {File} file - The file object to upload.
 * @returns {Promise<{success: boolean, message: string, path?: string}>}
 */
export async function uploadFile(file) {
  if (!file) {
    return { success: false, message: 'No file provided.' };
  }

  try {
    // 1. Get the signed URL from our API route
    console.log(`Requesting signed URL for: ${file.name}`);
    const signedUrlResponse = await fetch('/api/storage/signed-url', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filename: file.name }),
    });

    if (!signedUrlResponse.ok) {
        const errorData = await signedUrlResponse.json();
        throw new Error(`Failed to get signed URL: ${errorData.error || signedUrlResponse.statusText}`);
    }

    const { signedUrl, path } = await signedUrlResponse.json();
    console.log(`Received signed URL for path: ${path}`);

    // 2. Upload the file directly to the signed URL using fetch PUT
    console.log(`Uploading ${file.name} directly to signed URL...`);
    const uploadResponse = await fetch(signedUrl, {
        method: 'PUT',
        body: file,
        headers: {
            // Supabase signed URLs might require the correct content-type
            'Content-Type': file.type || 'application/octet-stream', 
        },
    });

    if (!uploadResponse.ok) {
        // Attempt to get error message from Supabase/storage provider if available
        let errorDetail = uploadResponse.statusText;
        try {
            const xmlError = await uploadResponse.text(); // Storage errors often return XML
            console.error('Direct upload failed response:', xmlError);
            // Basic XML parsing attempt
            const messageMatch = xmlError.match(/<Message>(.*?)<\/Message>/);
            if (messageMatch && messageMatch[1]) {
                errorDetail = messageMatch[1];
            }
        } catch (parseError) { /* Ignore if response is not XML or parsing fails */ }
        throw new Error(`Direct file upload failed: ${uploadResponse.status} ${errorDetail}`);
    }

    console.log('File uploaded successfully via signed URL.');

    // --- Ingestion Trigger --- 
    // Now that the file is uploaded, trigger ingestion (passing the final 'path')
    // Option 1: Call a dedicated Edge Function to handle ingestion (Recommended)
    // const { data: functionData, error: functionError } = await supabase.functions.invoke('start-ingestion', {
    //   body: { storagePath: path }, // Use the path returned from signed URL API
    // });
    // if (functionError) throw new Error(`Ingestion function failed: ${functionError.message}`);
    // console.log('Ingestion function invoked:', functionData);

    // Option 2: Call ingestFile directly (ONLY if running in a server-side context where it's defined)
    // This won't work directly from the client unless ingestFile is exposed via an API route.
    // const ingestResult = await ingestFile(file, path); 
    // if (!ingestResult.success) throw new Error(ingestResult.message);

    // For now, just return success after upload
    return { success: true, message: 'File uploaded successfully.', path: path }; // Return the final path

  } catch (error) {
    console.error('Error during file upload or ingestion trigger:', error);
    return { success: false, message: error.message || 'Upload process failed.' };
  }
}

// Add other client-side utilities here (e.g., formatting, data fetching helpers) 