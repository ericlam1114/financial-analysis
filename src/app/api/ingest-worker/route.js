import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { openai } from "@ai-sdk/openai"; // Import provider function directly
import { embed } from 'ai'; // Import embed function
import Papa from 'papaparse'; // For CSV parsing
import ExcelJS from 'exceljs'; // For XLSX parsing
import { Readable } from 'stream'; // Node.js stream


// Initialize Supabase client with Service Role Key for admin access
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { persistSession: false } }
);

// Initialize OpenAI Embedding Model (ensure OPENAI_API_KEY is set in env)
const embeddingModel = openai.embedding('text-embedding-3-small');

console.log("Initialized Supabase Admin Client & OpenAI Embedding Model for Ingest Worker.");

const BATCH_SIZE = 100; // Process rows in batches of this size (Reduced from 250)

// Helper function to update job status, progress, and error message
// Modified to accept progress data
async function updateJobProgress(jobId, status, progress = {}, errorMessage = null) {
    const { processed_row_count, total_row_count } = progress;
    console.log(
        `Updating job ${jobId} status to ${status}` +
        `${processed_row_count !== undefined ? ` (processed: ${processed_row_count})` : ''}` +
        `${total_row_count !== undefined ? ` (total: ${total_row_count})` : ''}` +
        `${errorMessage ? ` with error: ${String(errorMessage).substring(0, 100)}...` : ''}`
    );
    
    const updateData = {
        status: status,
        updated_at: new Date().toISOString(),
    };
    // Only include progress fields if they are provided and are numbers
    if (typeof processed_row_count === 'number') {
        updateData.processed_row_count = processed_row_count;
    }
    if (typeof total_row_count === 'number') {
        updateData.total_row_count = total_row_count;
    }
    if (errorMessage !== null) {
        updateData.error_message = String(errorMessage).substring(0, 500);
    }

    const { error } = await supabaseAdmin
        .from('processing_queue')
        .update(updateData)
        .eq('id', jobId);

    if (error) {
        console.error(`Failed to update progress for job ${jobId} to ${status}:`, error);
    }
    return { error };
}


// --- Core Processing Function ---
async function processFile(jobDetails) {
    const { id: jobId, storage_path, file_id, catalog, doc_type } = jobDetails;
    console.log(`Starting file processing for job ${jobId}, path: ${storage_path}`);

    let processedRowCount = 0;
    let totalRowCount = 0; 

    const bucketName = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'royalty-files'; 
    console.log(`Attempting download from bucket: ${bucketName}`);

    try {
        // 1. Download file from Storage
        console.log(`Downloading file: ${storage_path}`);
        const { data: blob, error: downloadError } = await supabaseAdmin.storage
            .from(bucketName)
            .download(storage_path);

        if (downloadError) {
            console.error(`Storage download error details for path ${storage_path} in bucket ${bucketName}:`, downloadError);
            throw new Error(`Storage download failed: ${downloadError.message || 'Unknown storage error'}`);
        } 
        if (!blob) {
            console.error(`Storage download returned null blob for path ${storage_path} in bucket ${bucketName}. Does the file exist?`);
            throw new Error('Downloaded file is empty or null. Check if file exists at the specified path.');
        }
        console.log(`File downloaded successfully (${(blob.size / 1024).toFixed(2)} KB).`);

        // --- Update Total Row Count --- 
        const fileExtension = storage_path.split('.').pop()?.toLowerCase();
        if (fileExtension === 'csv') {
            const csvText = await blob.text(); // Need text for count and parsing
            totalRowCount = (csvText.match(/\n/g) || []).length; // Estimate
            // Now parse using the text we already fetched
            await parseCsv(csvText, jobId, file_id, catalog, doc_type, (count) => { processedRowCount = count; });
        } else if (fileExtension === 'xlsx') {
            const buffer = await blob.arrayBuffer(); // Need buffer for exceljs
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(buffer);
            const worksheet = workbook.worksheets[0]; 
            totalRowCount = worksheet ? worksheet.rowCount -1 : 0; // Get count from worksheet
            await updateJobProgress(jobId, 'processing', { total_row_count: totalRowCount }); // Update total count early
            await parseXlsx(workbook, jobId, file_id, catalog, doc_type, (count) => { processedRowCount = count; });
        } else if (fileExtension === 'pdf') {
             console.warn(`PDF processing for job ${jobId} is not implemented yet. Skipping.`);
             await updateJobProgress(jobId, 'completed', { processed_row_count: 0, total_row_count: 0 }); // Mark as complete with 0 rows
             return; // Exit processing early for PDF
        } else {
            throw new Error(`Unsupported file type: ${fileExtension}`);
        }
        
        // Update total count for CSV after parsing starts
        if (fileExtension === 'csv') {
           await updateJobProgress(jobId, 'processing', { total_row_count: totalRowCount }); 
        }

        console.log(`Successfully processed ${processedRowCount} rows for job ${jobId}.`);

    } catch (error) {
        console.error(`Error during file processing for job ${jobId}:`, error);
        throw error; // Re-throw to be caught by the main POST handler
    }
}

// --- CSV Parsing Function ---
async function parseCsv(csvText, jobId, file_id, catalog, doc_type, updateProcessedCount) {
    let currentProcessed = 0;
    let rowsBatch = [];
    const totalRowCount = (csvText.match(/\n/g) || []).length;
    await updateJobProgress(jobId, 'processing', { total_row_count: totalRowCount }); // Update total count
    console.log(`Parsing CSV, estimated rows: ${totalRowCount}`);

    return new Promise((resolve, reject) => {
        Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            step: async (results, parser) => {
                parser.pause();
                try {
                    rowsBatch.push(results.data);
                    currentProcessed++;
                    if (rowsBatch.length >= BATCH_SIZE) {
                        console.log(`Processing batch of ${rowsBatch.length} CSV rows (total processed: ${currentProcessed})...`);
                        await processBatch(rowsBatch, file_id, catalog, doc_type);
                        await updateJobProgress(jobId, 'processing', { processed_row_count: currentProcessed });
                        rowsBatch = [];
                    }
                    updateProcessedCount(currentProcessed); // Update counter in parent scope
                } catch (batchError) {
                    console.error("Error processing batch:", batchError);
                    parser.abort();
                    reject(batchError);
                    return;
                } finally {
                    parser.resume();
                }
            },
            complete: async () => {
                console.log("CSV parsing complete.");
                try {
                    if (rowsBatch.length > 0) {
                        console.log(`Processing final batch of ${rowsBatch.length} CSV rows (total processed: ${currentProcessed})...`);
                        await processBatch(rowsBatch, file_id, catalog, doc_type);
                        await updateJobProgress(jobId, 'processing', { processed_row_count: currentProcessed });
                    }
                    updateProcessedCount(currentProcessed);
                    resolve();
                } catch (finalBatchError) {
                    console.error("Error processing final batch:", finalBatchError);
                    reject(finalBatchError);
                }
            },
            error: (error) => {
                console.error("Papaparse error:", error);
                reject(new Error(`CSV parsing failed: ${error.message}`));
            }
        });
    });
}

// --- XLSX Parsing Function ---
async function parseXlsx(workbook, jobId, file_id, catalog, doc_type, updateProcessedCount) {
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("XLSX file contains no worksheets.");

    console.log(`Processing XLSX Worksheet "${worksheet.name}"...`);
    let currentProcessed = 0;
    let rowsBatch = [];
    const headerRow = worksheet.getRow(1).values;
    const headers = Array.isArray(headerRow) ? headerRow.slice(1) : [];

    for (let i = 2; i <= worksheet.rowCount; i++) {
        const row = worksheet.getRow(i);
        const rowData = {};
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const headerName = headers[colNumber - 1] || `column_${colNumber}`;
            rowData[headerName] = cell.value;
        });

        rowsBatch.push(rowData);
        currentProcessed++;

        if (rowsBatch.length >= BATCH_SIZE || i === worksheet.rowCount) {
            console.log(`Processing batch of ${rowsBatch.length} XLSX rows (row ${i}, total processed: ${currentProcessed})...`);
            await processBatch(rowsBatch, file_id, catalog, doc_type);
            await updateJobProgress(jobId, 'processing', { processed_row_count: currentProcessed }); 
            rowsBatch = [];
        }
        updateProcessedCount(currentProcessed); // Update counter in parent scope
        await new Promise(resolve => setImmediate(resolve)); 
    }
    console.log("XLSX processing complete.");
}


// --- Batch Processing Function (Embed + Upsert) ---
async function processBatch(batch, file_id, catalog, doc_type) {
    if (!batch || batch.length === 0) return;

    // *** Log the keys of the FIRST row in the batch ***
    if (batch[0]) {
        console.log("--- Worker: Inspecting keys of first row in batch ---", Object.keys(batch[0]));
        // Optionally log the full first row object for detailed inspection
        // console.log("Worker: First row object:", JSON.stringify(batch[0])); 
    }
    // ******************************************************

    const valueOrNull = (val) => (val !== undefined && val !== null && val !== '') ? String(val).trim() : null;
    const numOrNull = (val) => {
        if (val === undefined || val === null || val === '') return null;
        const cleanedVal = String(val).replace(/[$,]+/g, '');
        const num = parseFloat(cleanedVal);
        return !isNaN(num) ? num : null;
    };
    const intOrNull = (val) => {
        if (val === undefined || val === null || val === '') return null;
        const cleanedVal = String(val).replace(/[^0-9-]+/g, ''); 
        const num = parseInt(cleanedVal, 10);
        return !isNaN(num) ? num : null;
    };

    const contentToEmbed = [];
    const rowsToUpsert = [];

    for (const rowData of batch) {
        // Prepare content string (using keys directly from rowData)
        const contentString = Object.entries(rowData)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');
        contentToEmbed.push(contentString);

        // --- Period Formatting (Handle Ranges more robustly) --- 
        let formattedPeriod = null;
        const originalPeriod = valueOrNull(rowData['Income Period']); 
        if (originalPeriod) {
            const cleanedPeriod = originalPeriod.replace(/[^0-9]/g, '');
            if (cleanedPeriod.length === 6 && /^(19|20)\d{2}(0[1-9]|1[0-2])$/.test(cleanedPeriod)) { // Valid YYYYMM
                formattedPeriod = cleanedPeriod;
            } else if (cleanedPeriod.length === 8 && /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(cleanedPeriod)) { // Valid YYYYMMDD
                formattedPeriod = cleanedPeriod.substring(0, 6); // Truncate to YYYYMM
            } else if (cleanedPeriod.length >= 12) { // Likely YYYYMMYYYYMM or longer range
                 const potentialStartPeriod = cleanedPeriod.substring(0, 6);
                 if (/^(19|20)\d{2}(0[1-9]|1[0-2])$/.test(potentialStartPeriod)) {
                     formattedPeriod = potentialStartPeriod;
                     // console.log(`Extracted start period ${formattedPeriod} from range ${originalPeriod}`); // Keep commented unless debugging
                 } else {
                     console.warn(`Could not extract valid start period (YYYYMM) from range: ${originalPeriod}, setting DB period to null.`);
                     formattedPeriod = null;
                 }
            } else {
                console.warn(`Unexpected period format: ${originalPeriod}, setting DB period to null.`);
                formattedPeriod = null;
            }
        }
        
        // --- Prepare Row for Upsert --- 
        rowsToUpsert.push({
            file_id: file_id,
            catalog: valueOrNull(rowData['Client Code']), // Catalog ID
            client_name: valueOrNull(rowData['Client Name']), // <<< ADDED CLIENT NAME MAPPING
            period: formattedPeriod, // Use the refined period
            metric: valueOrNull(rowData['Income Type Name']), 
            value: numOrNull(rowData['Amount Collected']),   
            content: contentString,
            song_title: valueOrNull(rowData['Song Title']),
            artist: valueOrNull(rowData['Artist']),
            composers: valueOrNull(rowData['Composers']),
            source_name: valueOrNull(rowData['Source Name']),
            income_type: valueOrNull(rowData['Income Type Name']), 
            units: numOrNull(rowData['Units']),             
            amount_collected: numOrNull(rowData['Amount Collected']),
            royalty_payable: numOrNull(rowData['Royalty Payable']), 
            isrc: valueOrNull(rowData['ISRC']),
            // embedding will be added later
        });
    }

    console.log(`Generating ${contentToEmbed.length} embeddings...`);
    let embeddings = [];
    try {
        const embeddingPromises = contentToEmbed.map(text => embed({ model: embeddingModel, value: text }));
        const results = await Promise.all(embeddingPromises);
        embeddings = results.map(result => result.embedding);
        console.log(`Generated ${embeddings.length} embeddings.`);
        if (embeddings.length !== rowsToUpsert.length) {
             throw new Error(`Mismatch between rows to upsert (${rowsToUpsert.length}) and generated embeddings (${embeddings.length})`);
        }
        for (let i = 0; i < rowsToUpsert.length; i++) {
            rowsToUpsert[i].embedding = embeddings[i];
        }
    } catch (embeddingError) {
        console.error("Embedding generation failed:", embeddingError);
        throw new Error(`Embedding generation failed: ${embeddingError.message}`);
    }

    console.log(`Upserting ${rowsToUpsert.length} rows into Supabase...`);
    const { error: upsertError } = await supabaseAdmin
        .from('rows')
        .upsert(rowsToUpsert);

    if (upsertError) {
        console.error("Supabase upsert failed:", upsertError);
        throw new Error(`Database upsert failed: ${upsertError.message}`);
    }
    console.log("Batch upsert successful.");
}


// This function handles the POST request triggered by the Supabase webhook
export async function POST(req) {
    let jobId = null;

    try {
        const payload = await req.json();
        console.log("Ingest Worker received payload:", JSON.stringify(payload, null, 2));

        if (payload.type === 'broadcast' && payload.event === 'test') {
             console.log("Received Supabase Realtime test message. Ignoring.");
             return NextResponse.json({ message: "Test payload received" }, { status: 200 });
        }
        if (payload.type !== 'INSERT' || payload.table !== 'processing_queue') {
            console.warn("Ingest Worker: Received non-INSERT event or unexpected table. Payload:", payload);
             return NextResponse.json({ error: "Invalid webhook payload type or table" }, { status: 400 });
        }

        jobId = payload?.record?.id;
        if (!jobId) {
            console.error("Ingest Worker Error: Missing job ID (payload.record.id) in webhook payload.");
            return NextResponse.json({ error: "Missing job ID in request payload" }, { status: 400 });
        }
        console.log(`Ingest Worker started for job ID: ${jobId}`);

        const { data: jobDetails, error: fetchError } = await supabaseAdmin
            .from('processing_queue')
            .select('*')
            .eq('id', jobId)
            .single();

        if (fetchError) throw new Error(`Failed to fetch job ${jobId}: ${fetchError.message}`);
        if (!jobDetails) throw new Error(`Job ${jobId} not found.`);
        if (jobDetails.status !== 'pending') {
            console.warn(`Ingest Worker: Job ${jobId} is not in pending state (current: ${jobDetails.status}). Skipping.`);
            return NextResponse.json({ message: `Job already processed or in progress: ${jobDetails.status}` }, { status: 200 });
        }

        console.log(`Incrementing attempts for job ${jobId}`);
        const { data: attempts, error: incrementError } = await supabaseAdmin.rpc('increment_job_attempts', { job_id_param: jobId });
        if (incrementError) {
             console.error(`Ingest Worker Warning: Failed to increment attempts for job ${jobId}`, incrementError);
        } else {
            console.log(`Job ${jobId} is now attempt number ${attempts}.`);
        }

        // Update status to 'processing' - Use the new progress function
        await updateJobProgress(jobId, 'processing', { processed_row_count: 0, total_row_count: 0 }); // Initial update

        // --- Execute Core Processing ---
        await processFile(jobDetails);
        // --- Core Processing Done ---

        // If processFile completes without throwing, update status to 'completed'
        // Fetch the final counts to ensure accuracy if needed, or use the counts from processFile scope
        const { data: finalJobData } = await supabaseAdmin.from('processing_queue').select('processed_row_count, total_row_count').eq('id', jobId).single();
        await updateJobProgress(jobId, 'completed', { 
            processed_row_count: finalJobData?.processed_row_count ?? 0,
            total_row_count: finalJobData?.total_row_count ?? 0
        });
        console.log(`Ingest Worker: Successfully processed and updated job ${jobId} status to 'completed'.`);

        return NextResponse.json({ message: `Successfully processed job ${jobId}` }, { status: 200 });

    } catch (error) {
        console.error(`Ingest Worker Error: Unhandled exception for job ${jobId || 'unknown'}`, error);
        if (jobId) {
            // Use new progress function to mark as failed
            await updateJobProgress(jobId, 'failed', {}, error.message || 'Unknown error occurred');
        }
        return NextResponse.json({ error: error.message || "An unknown error occurred" }, { status: 500 });
    }
}

// Ensure Vercel doesn't time out standard serverless functions too quickly
// (Default is 10s on Hobby, up to 60s on Pro, 900s on Enterprise)
// You might need to adjust Vercel plan/settings if processing takes longer.
export const maxDuration = 60; // Extend max duration to 60 seconds (Pro plan) / 10s (Hobby)

// IMPORTANT: Make sure the required environment variables are set in Vercel:
// - NEXT_PUBLIC_SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - OPENAI_API_KEY
