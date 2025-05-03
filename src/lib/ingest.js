// Placeholder for src/lib/ingest.js
// This file will handle:
// 1. Receiving an uploaded file (CSV, XLSX, PDF)
// 2. Parsing the file content (using papaparse, exceljs, pdf-parse)
// 3. Generating embeddings for relevant data rows
// 4. Upserting the data and embeddings into the Supabase 'rows' table

import { supabase, supabaseAdmin } from '@/lib/supabaseClient';
import { embedDocuments } from '@/lib/embeddings';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import pdf from 'pdf-parse';
import { Buffer } from "buffer";

/**
 * Processes a file buffer for ingestion.
 * Called by Edge Functions or server-side processes.
 * 
 * @param {ArrayBuffer} fileBuffer - The file content as an ArrayBuffer.
 * @param {string} fileName - The original name of the file.
 * @param {string} fileType - The MIME type of the file.
 * @param {string} storagePath - The path where the file is stored in Supabase Storage.
 * @param {string} docType - 'evaluation' or 'reference'. // Added docType parameter
 * @returns {Promise<{success: boolean, message: string, rowCount?: number}>}
 */
export async function ingestBuffer(fileBuffer, fileName, fileType, storagePath, docType = 'reference') {
  console.log(`Ingesting buffer for file: ${fileName} from ${storagePath}`);
  console.log(`Document type: ${docType}`);
  let parsedRows = [];
  const buffer = Buffer.from(fileBuffer); // Convert ArrayBuffer to Node.js Buffer if needed by parsers

  try {
    // Re-use parsing logic, but operate on the buffer
    if (fileType === 'text/csv' || fileName.toLowerCase().endsWith('.csv')) {
      console.log('Parsing CSV buffer...');
      const fileContent = buffer.toString('utf-8'); // Decode buffer
      const result = Papa.parse(fileContent, {
        header: true, 
        skipEmptyLines: true,
        dynamicTyping: true, 
      });
      if (result.errors.length > 0) {
          console.error('CSV parsing errors:', result.errors);
      }
      parsedRows = result.data;
      console.log(`Parsed ${parsedRows.length} rows from CSV.`);
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || fileName.toLowerCase().endsWith('.xlsx')) {
      console.log('Parsing XLSX buffer...');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const worksheet = workbook.worksheets[0]; 
      if (!worksheet) {
          throw new Error('No worksheets found in the XLSX file.');
      }
      const headers = [];
      worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
          headers[colNumber - 1] = cell.value ? cell.value.toString() : `Column_${colNumber}`;
      });
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowNumber > 1) {
              const rowData = {};
              row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                  let value = cell.value;
                  if (value && typeof value === 'object') {
                      if (value.result !== undefined) { value = value.result; }
                      else if (value.richText) { value = value.richText.map(rt => rt.text).join(''); }
                      else if (value instanceof Date) { /* Keep as Date */ }
                  }
                  rowData[headers[colNumber - 1]] = value;
              });
              parsedRows.push(rowData);
          }
      });
      console.log(`Parsed ${parsedRows.length} rows from XLSX.`);
    } else if (fileType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
      console.log('Parsing PDF buffer...');
      const pdfData = await pdf(buffer); 
      console.log(`Parsed PDF: ${pdfData.numpages} pages, ${pdfData.info?.Title || 'No Title'}.`);
      const lines = pdfData.text.split(/\r?\n/).filter(line => line.trim() !== '');
      console.log(`Extracted ${lines.length} lines from PDF text.`);
      parsedRows = lines.map((line, index) => ({
          pdf_line_number: index + 1,
          text_content: line,
      }));
      console.log(`Created ${parsedRows.length} placeholder rows from PDF lines.`);
    } else {
      throw new Error(`Unsupported file type: ${fileType || 'unknown'}`);
    }
  } catch (parseError) {
      console.error('Error parsing file buffer:', parseError);
      return { success: false, message: `Failed to parse file buffer: ${parseError.message}` };
  }

  if (!parsedRows || parsedRows.length === 0) {
      console.warn('No rows parsed from file buffer.');
      return { success: false, message: 'Could not parse file buffer or file is empty.' };
  }

  // --- Database Insertion Logic (remains largely the same) ---
  const documentsToEmbed = [];
  const rowsToInsert = parsedRows.map((row, index) => {
      // --- Log the first row object for inspection --- 
      if (index === 0) {
          console.log("Inspecting parsed row object keys:", Object.keys(row));
          // Optionally log the full first row, but keys are usually enough and safer
          // console.log("Inspecting first parsed row object:", JSON.stringify(row)); 
      }

      // --- Prepare the Content String (for embedding / fallback) --- 
      const content = Object.entries(row)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', '); 
      documentsToEmbed.push(content);

      // --- Map CSV Headers to DB Columns --- 
      const valueOrNull = (val) => (val !== undefined && val !== null && val !== '') ? String(val).trim() : null;
      
      // Fix numOrNull: Only remove common non-numeric chars like $, ,, keeping .
      const numOrNull = (val) => {
          if (val === undefined || val === null || val === '') return null;
          const cleanedVal = String(val).replace(/[$,]+/g, ''); // Removes $ and ,
          const num = parseFloat(cleanedVal);
          return !isNaN(num) ? num : null;
      };
      
      // Fix intOrNull: Remove non-digits (keeps hyphen for potential negatives)
      const intOrNull = (val) => {
          if (val === undefined || val === null || val === '') return null;
          const cleanedVal = String(val).replace(/[^0-9-]+/g, ''); 
          const num = parseInt(cleanedVal, 10);
          return !isNaN(num) ? num : null;
      }

      // Basic cleanup for period
      let formattedPeriod = valueOrNull(row['Income Period']); 
      if (formattedPeriod) {
          formattedPeriod = formattedPeriod.replace(/[^0-9]/g, '');
          if (!(formattedPeriod.length === 6 || formattedPeriod.length === 8)) {
              console.warn(`Unexpected period format: ${row['Income Period']}, setting to null.`);
              formattedPeriod = null;
          } else if (formattedPeriod.length === 8) {
             // Optional: Reformat YYYYMMDD to YYYY-MM-DD if desired for consistency
             // formattedPeriod = `${formattedPeriod.substring(0,4)}-${formattedPeriod.substring(4,6)}-${formattedPeriod.substring(6,8)}`;
             // Keep as YYYYMMDD for now based on previous usage
          } 
      }
      
      return {
          // Existing mappings using actual headers
          catalog: valueOrNull(row['Client Code']), 
          period: formattedPeriod,
          metric: valueOrNull(row['Income Type Name']), // Default metric
          value: numOrNull(row['Amount Collected']), // Default value column

          // New Column Mappings using actual headers
          song_title: valueOrNull(row['Song Title']),
          artist: valueOrNull(row['Artist']),
          composers: valueOrNull(row['Composers']),
          source_name: valueOrNull(row['Source Name']),
          income_type: valueOrNull(row['Income Type Name']), 
          units: numOrNull(row['Units']), // Using numOrNull, change to intOrNull if strictly integers
          amount_collected: numOrNull(row['Amount Collected']), 
          royalty_payable: numOrNull(row['Royalty Payable']),
          isrc: valueOrNull(row['ISRC']),

          // Technical/Helper Columns
          content: content, // Store the generated content string
          // file_id: Pass this in if available from the upload process
          metadata: JSON.stringify({ ...row, source: storagePath, docType: docType }), 
      };
  });

  console.log(`Generating batch embeddings for ${documentsToEmbed.length} documents...`);

  try {
    const embeddings = await embedDocuments(documentsToEmbed);

    if (embeddings.length !== rowsToInsert.length) {
        throw new Error('Mismatch between number of rows and generated embeddings.');
    }

    const rowsWithEmbeddings = rowsToInsert.map((row, index) => ({
        ...row,
        embedding: embeddings[index],
        // Ensure metadata is stringified or handled correctly if it's a JSONB column
        metadata: typeof row.metadata === 'object' ? JSON.stringify(row.metadata) : row.metadata 
    }));

    console.log(`Upserting ${rowsWithEmbeddings.length} rows with embeddings to Supabase...`);
 
    // Use the ADMIN client here for upserting from server-side context
    // Make sure supabaseAdmin is correctly initialized in this scope 
    // (might need to import it or ensure it's passed)
    const currentClient = supabaseAdmin || supabase; // Fallback to default if admin isn't available?
    
    const { error: upsertError } = await currentClient
        .from('rows') // Ensure this table name is correct
        .upsert(rowsWithEmbeddings, {
             // onConflict: 'id' // Define conflict resolution based on your primary key if needed
             // ignoreDuplicates: false, 
        });

    if (upsertError) {
        console.error('Supabase batch upsert error:', upsertError);
        throw new Error(`Database upsert failed: ${upsertError.message}`);
    }

    console.log(`Successfully ingested and embedded ${rowsWithEmbeddings.length} rows from ${fileName}`);
    return { success: true, message: `Ingested ${rowsWithEmbeddings.length} rows.`, rowCount: rowsWithEmbeddings.length };

  } catch (error) {
    console.error('Error during embedding or upserting:', error);
    return { success: false, message: error.message || 'Embedding or database operation failed.' };
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