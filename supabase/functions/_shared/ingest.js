// Placeholder for src/lib/ingest.js
// This file will handle:
// 1. Receiving an uploaded file (CSV, XLSX, PDF)
// 2. Parsing the file content (using papaparse, exceljs, pdf-parse)
// 3. Generating embeddings for relevant data rows
// 4. Upserting the data and embeddings into the Supabase 'rows' table

import { supabase, supabaseAdmin } from "../_shared/supabaseClient.js";
// import { embedDocuments } from "../_shared/embeddings.deno.js"; // <-- Commented out broken import
import ExcelJS from 'exceljs';
// import pdf from 'pdf-parse'; // Temporarily commented out due to Deno incompatibility
import { Buffer } from "buffer";

/**
 * Processes an XLSX file buffer for ingestion, creating embeddings.
 * @param {ArrayBuffer} fileBuffer - The file content as an ArrayBuffer.
 * @param {string} fileName - The original name of the file.
 * @param {string} storagePath - The path where the file is stored in Supabase Storage.
 * @param {string} catalogName - The catalog name (e.g., derived from filename).
 * @param {string} docType - 'evaluation' or 'reference'. 
 * @returns {Promise<{success: boolean, message: string, rowCount?: number}>}
 */
export async function ingestXlsxBuffer(fileBuffer, fileName, storagePath, catalogName, docType = 'evaluation') {
  console.log(`Ingesting XLSX buffer for file: ${fileName} as Catalog: ${catalogName}`);
  console.log(`Document type: ${docType}`);
  
  const wb = new ExcelJS.Workbook();
  const buffer = Buffer.from(fileBuffer);
  
  try {
    await wb.xlsx.load(buffer);
    const sheet = wb.worksheets[0]; // assume first sheet
    if (!sheet) {
        throw new Error('No worksheet found in the XLSX file.');
    }

    const rowsToProcess = [];
    const textsToEmbed = [];

    sheet.eachRow((row, i) => {
      if (i === 1) return; // skip header
      try {
          // --- Adapt column mapping --- 
          const cellA = row.getCell(1).value;
          const cellB = row.getCell(2).value;

          // Attempt to convert Excel date serial number or string to Date
          let period = null;
          if (typeof cellA === 'number') { // Excel serial date
             period = ExcelJS.DateUtils.excelToJsDate(cellA);
          } else if (typeof cellA === 'string') {
             period = new Date(cellA); // Attempt direct parsing
          } else if (cellA instanceof Date) {
              period = cellA; // Already a date
          }

          // Skip row if period is invalid
          if (!period || isNaN(period.getTime())) { 
              console.warn(`Skipping row ${i}: Invalid date value in Col A:`, cellA);
              return; 
          }

          const metric = "Royalty Income"; // Fixed metric as per module logic
          const value = cellB !== null && cellB !== undefined ? parseFloat(cellB) : null;
          
          // Skip row if value is invalid number
          if (value === null || isNaN(value)) {
              console.warn(`Skipping row ${i}: Invalid numeric value in Col B:`, cellB);
              return; 
          }

          // Create the text string for embedding
          const text = `${catalogName} | ${period.toISOString()} | ${metric}: ${value}`;
          textsToEmbed.push(text);

          // Prepare row for DB insertion (matches schema)
          rowsToProcess.push({
            catalog: catalogName,
            period: period.toISOString().split('T')[0], // Format as YYYY-MM-DD
            metric: metric,
            value: value,
            content: text, // Store the text we embed
            // file_id: null, // Link later if needed
            // embedding: null // Add after batch embedding
          });
      } catch (cellError) {
          console.error(`Error processing row ${i}:`, cellError, `Row data: ${JSON.stringify(row.values)}`);
          // Optionally skip row on error
      }
    });

    if (rowsToProcess.length === 0) {
      console.warn('No valid rows found to process in the sheet.');
      return { success: true, message: 'No valid rows found.', rowCount: 0 };
    }

    console.log(`Parsed ${rowsToProcess.length} valid rows from XLSX.`);
    console.log(`Generating batch embeddings for ${textsToEmbed.length} text snippets...`);

    // Generate embeddings in batch (using Deno-specific function)
    const embeddings = await embedDocuments(textsToEmbed);

    if (embeddings.length !== rowsToProcess.length) {
        throw new Error('Mismatch between number of rows and generated embeddings.');
    }

    // Add embeddings to the rows
    const rowsWithEmbeddings = rowsToProcess.map((row, index) => ({
        ...row,
        embedding: embeddings[index],
        // Add metadata here if needed (and if column exists)
        // metadata: JSON.stringify({ source: storagePath, docType: docType })
    }));

    console.log(`Upserting ${rowsWithEmbeddings.length} rows with embeddings to Supabase...`);
 
    // Use the ADMIN client for upserting
    const currentClient = supabaseAdmin || supabase; // Use admin if available
    const { error: upsertError } = await currentClient
        .from('rows')
        .upsert(rowsWithEmbeddings);

    if (upsertError) {
        console.error('Supabase batch upsert error:', upsertError);
        throw new Error(`Database upsert failed: ${upsertError.message}`);
    }

    console.log(`Successfully ingested and embedded ${rowsWithEmbeddings.length} rows from ${fileName}`);
    return { success: true, message: `Ingested ${rowsWithEmbeddings.length} rows.`, rowCount: rowsWithEmbeddings.length };

  } catch (error) {
    console.error('Error during XLSX ingestion:', error);
    return { success: false, message: error.message || 'XLSX Ingestion failed.' };
  }
}

// Keep original ingestFile for potential future use or client-side checks?
// Or remove if it's definitely replaced by the Edge Function workflow.
/*
export async function ingestFile(file, storagePath, docType = 'reference') {
  // ... (original code largely based on browser File object) ...
  // This might now primarily convert the File to ArrayBuffer and call ingestBuffer
  console.log("Original ingestFile called - consider using ingestBuffer flow.");
  try {
    const fileBuffer = await file.arrayBuffer();
    return await ingestBuffer(fileBuffer, file.name, file.type, storagePath, docType);
  } catch (error) {
    console.error('Error in ingestFile wrapper:', error);
    return { success: false, message: error.message || 'Failed to process file.' };
  }
}
*/ 