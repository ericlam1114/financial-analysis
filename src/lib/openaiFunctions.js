// lib/openaiFunctions.js
import { z } from 'zod';
import { tool } from 'ai'; 
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabaseClient'; // Corrected import name

// Schema for the database aggregation function
const calculationSchema = z.object({
    catalog_filter: z.string().describe("The specific catalog name to filter the calculation by (e.g., '100047_202312E')."),
    metric_filter: z.string().optional().default('royalty_line').describe("The specific metric to aggregate (defaults to 'royalty_line')."),
    period_pattern: z.string().optional().default('%').describe("An SQL LIKE pattern to filter periods (e.g., '2023%' for all of 2023, '202307%' for July 2023, '%' for all periods). Defaults to '%'."),
    aggregation_type: z.enum(['SUM', 'AVG']).optional().default('SUM').describe("The type of aggregation to perform ('SUM' or 'AVG'). Defaults to 'SUM'."),
});

// Existing Valuation Function Schemas (wrapped with 'tool')
const dcfSchema = z.object({
    cashFlows: z.array(z.number()).min(1).describe('An array of net cash flows for consecutive periods (e.g., years). Requires at least one value.'),
    discountRate: z.number().min(0).max(1).describe('The annual discount rate as a decimal (e.g., 0.1 for 10%). Must be between 0 and 1.'),
    terminalGrowthRate: z.number().optional().default(0).describe('The perpetual growth rate after the explicit forecast period (as decimal, e.g., 0.02 for 2%). Defaults to 0.'),
});

const projectionSchema = z.object({
    currentYearValue: z.number().describe('The value (e.g., royalty income) for the most recent known year or period.'),
    growthRate: z.number().describe('The expected annual growth rate as a decimal (e.g., 0.05 for 5%, -0.1 for -10%).'),
});

const multipleSchema = z.object({
    metricValue: z.number().describe('The financial metric value to apply the multiple to (e.g., annual revenue, average annual cash flow).'),
    multiple: z.number().gt(0).describe('The valuation multiple (e.g., 10 for a 10x multiple). Must be greater than 0.'),
});

// Import the valuation functions that will be used for execution
import { calcDcf, projectNextYear, applyMultiple } from "@/lib/math/valuation.js";

// Initialize Supabase client for the tool implementation
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { persistSession: false } } 
);
console.log("Initialized Supabase Client in openaiFunctions:", typeof supabase);

// === Schema Definitions ===
const calculationParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    metric_filter: z.string().describe("The specific metric column to aggregate (e.g., 'amount_collected', 'royalty_payable', 'units', 'value')."),
    period_pattern: z.string().describe("A SQL LIKE pattern for the period (e.g., '2023%' for year, '202312%' for month, '%' for all).")
});

const topNParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    metric_filter: z.string().describe("The specific metric name to sort by (e.g., 'amount_collected', 'royalty_payable')."),
    period_pattern: z.string().describe("A SQL LIKE pattern for the period (e.g., '2023%' for year, '202312%' for month, '%' for all)."),
    n: z.number().int().positive().describe("The number of top rows to retrieve.")
});

const topSongsParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    period_pattern: z.string().describe("A SQL LIKE pattern for the period (e.g., '2023%' for year, '202312%' for month, '%' for all)."),
    n: z.number().int().positive().describe("The number of top songs to retrieve based on summed collected amount.")
});

// Schema for getting earnings for a specific song
const songEarningsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    song_title: z.string().describe("The title of the song to get earnings for."),
    period_pattern: z.string().optional().default('%').describe("A SQL LIKE pattern for the period (e.g., '2023%' for year, '202312%' for month, '%' for all).")
});

// Zod schema for quarterly summary
const quarterlySummaryParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    metric_filter: z.string().optional().default('amount_collected').describe("The metric column to summarize quarterly (e.g., 'amount_collected', 'royalty_payable'). Defaults to 'amount_collected'.")
});

// Zod schema for yearly summary
const yearlySummaryParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    metric_filter: z.string().optional().default('amount_collected').describe("The metric column to summarize yearly (e.g., 'amount_collected', 'royalty_payable'). Defaults to 'amount_collected'.")
});

// Zod schema for monthly summary
const monthlySummaryParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    metric_filter: z.string().optional().default('amount_collected').describe("The metric column to summarize monthly (e.g., 'amount_collected', 'royalty_payable'). Defaults to 'amount_collected'."),
    year_filter: z.string().optional().describe("Optional year (YYYY) to filter the monthly summary by. If omitted, includes all years.")
});

// === New Schema Definitions ===
const topIncomeTypesParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    period_pattern: z.string().optional().default('%').describe("A SQL LIKE pattern for the period (e.g., '2023%', '%'). Defaults to '%' for all periods."),
    n: z.number().int().positive().optional().default(10).describe("The number of top income types to retrieve. Defaults to 10.")
});

const topSourcesParamsSchema = z.object({
    catalog_filter: z.string().describe("The catalog identifier to filter data by."),
    period_pattern: z.string().optional().default('%').describe("A SQL LIKE pattern for the period (e.g., '2023%', '%'). Defaults to '%' for all periods."),
    n: z.number().int().positive().optional().default(10).describe("The number of top sources (e.g., streaming services) to retrieve. Defaults to 10.")
});

// === Backend Data Fetching Functions ===

/**
 * Calculates the sum, average, and count for a specific metric 
 * using the aggregate_metric_structured RPC function.
 */
export async function calculateMetricSummary(params) {
    try {
        console.log("calculateMetricSummary called with params:", params);
        const validatedParams = calculationParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);

        // Map metric_filter to the actual column name, providing a safe list
        let dbColumnName;
        const filterLower = validatedParams.metric_filter.toLowerCase();
        if ([ 'amount_collected', 'collected', 'gross' ].includes(filterLower)) {
            dbColumnName = 'amount_collected';
        } else if ([ 'royalty_payable', 'payable', 'net', 'royalty_line' ].includes(filterLower)) {
            dbColumnName = 'royalty_payable';
        } else if ([ 'units' ].includes(filterLower)) {
            dbColumnName = 'units';
        } else if ([ 'value', 'metric_value' ].includes(filterLower)) {
             dbColumnName = 'value'; // Use the default 'value' column if specified
        } else {
            console.warn(`Unsupported metric_filter: ${validatedParams.metric_filter}. Defaulting to amount_collected.`);
            dbColumnName = 'amount_collected'; // Default if unsure
            // Alternatively: throw new Error(`Unsupported metric: ${validatedParams.metric_filter}`);
        }
        
        console.log(`Calling RPC aggregate_metric_structured for column: ${dbColumnName}`);

        // Call the new RPC function
        const { data, error } = await supabase.rpc('aggregate_metric_structured', {
            catalog_filter_param: validatedParams.catalog_filter,
            metric_column_name: dbColumnName, // Pass the validated column name
            period_pattern_param: validatedParams.period_pattern
        });

        if (error) {
            console.error("Error calling aggregate_metric_structured RPC:", error);
            return { success: false, error: error.message };
        }

        // RPC returns an array with one object like [{ total_sum: ..., average: ..., total_count: ... }]
        const resultData = data && data.length > 0 ? data[0] : { total_sum: 0, average: 0, total_count: 0 };

        const finalResult = {
            sum: parseFloat(Number(resultData.total_sum || 0).toFixed(2)),
            avg: parseFloat(Number(resultData.average || 0).toFixed(2)),
            count: Number(resultData.total_count || 0)
        };

        console.log("RPC Metric summary result:", finalResult);
        return { success: true, result: finalResult };

    } catch (error) {
        console.error("Error in calculateMetricSummary:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves the top N rows based on a specific metric value 
 * within a given catalog and period pattern using the new structured columns.
 */
export async function getTopNRows(params) {
    try {
        console.log("getTopNRows called with params:", params);
        const validatedParams = topNParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);

        // Determine the column to sort by
        let columnToSortBy;
         switch (validatedParams.metric_filter.toLowerCase()) {
            case 'royalty_line':
            case 'royalty_payable':
                columnToSortBy = 'royalty_payable';
                break;
            case 'amount_collected':
                columnToSortBy = 'amount_collected';
                break;
             case 'units':
                 columnToSortBy = 'units';
                 break;
            default:
                console.warn(`Unknown metric_filter for sorting: ${validatedParams.metric_filter}. Defaulting to amount_collected.`);
                columnToSortBy = 'amount_collected';
                // Alternatively: return { success: false, error: `Unknown metric for sorting: ${validatedParams.metric_filter}` };
        }
        console.log(`Sorting top N rows by: ${columnToSortBy}`);

        const { data, error } = await supabase
            .from('rows')
            // Select relevant columns to display
            .select('period, song_title, artist, amount_collected, royalty_payable, units') 
            .eq('catalog', validatedParams.catalog_filter)
            .like('period', validatedParams.period_pattern)
            .not(columnToSortBy, 'is', null) // Ensure the sort column is not null
            .order(columnToSortBy, { ascending: false })
            .limit(validatedParams.n);

        if (error) {
            console.error("Error calling getTopNRows query:", error);
            return { success: false, error: error.message };
        }

        console.log("Top N rows result:", data);
        return { success: true, result: data }; // Return the array of rows

    } catch (error) {
        console.error("Error in getTopNRows:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves the top N songs based on the sum of their 'amount_collected'
 * within a given catalog and period pattern using an RPC call.
 */
export async function getTopSongs(params) {
    try {
        console.log("getTopSongs called with params:", params);
        const validatedParams = topSongsParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);

        // Call the new RPC function
        const { data, error } = await supabase.rpc('get_top_songs_aggregate', {
            catalog_filter_param: validatedParams.catalog_filter,
            period_pattern_param: validatedParams.period_pattern,
            limit_param: validatedParams.n
        });

        if (error) {
            console.error("Error calling get_top_songs_aggregate RPC:", error);
            return { success: false, error: error.message };
        }

        console.log("Top Songs RPC result:", data);
        // Ensure total_collected is a number
        const result = data?.map(song => ({ 
            ...song, 
            total_collected: Number(song.total_collected) || 0
        })) || [];

        return { success: true, result: result }; 

    } catch (error) {
        console.error("Error in getTopSongs:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves the total earnings for a specific song within a given catalog.
 * Uses the new structured columns.
 */
export async function getSongEarnings(params) {
    try {
        console.log("getSongEarnings called with params:", params);
        const validatedParams = songEarningsSchema.parse(params);
        console.log("Validated params:", validatedParams);

        // Query the specific columns from the 'rows' table
        const { data, error } = await supabase
            .from('rows')
            .select('amount_collected') // Select the numeric column directly
            .eq('catalog', validatedParams.catalog_filter)
            .ilike('song_title', validatedParams.song_title) // Query the specific song_title column, case-insensitive
            .like('period', validatedParams.period_pattern); // Filter by period

        if (error) {
            console.error("Error querying song earnings:", error);
            return { success: false, error: error.message };
        }

        if (!data || data.length === 0) {
             console.log(`No rows found for song "${validatedParams.song_title}" in catalog ${validatedParams.catalog_filter}`);
             // Return success but with zero earnings
             return { success: true, result: { song_title: validatedParams.song_title, total_earnings: 0, matching_rows: 0 } };
        }

        // Calculate the total earnings by summing the numeric column
        const totalEarnings = data.reduce((sum, row) => {
            return sum + (Number(row.amount_collected) || 0); // Ensure conversion to number
        }, 0);

        const finalTotalEarnings = parseFloat(totalEarnings.toFixed(2));

        console.log(`Song earnings for "${validatedParams.song_title}":`, finalTotalEarnings);
        return { 
            success: true, 
            result: {
                song_title: validatedParams.song_title,
                total_earnings: finalTotalEarnings,
                matching_rows: data.length
            }
        };

    } catch (error) {
        console.error("Error in getSongEarnings:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves quarterly summary for a specific metric using an RPC call.
 */
export async function getQuarterlySummary(params) {
    try {
        console.log("getQuarterlySummary called with params:", params);
        const validatedParams = quarterlySummaryParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);

        // Map metric_filter to the actual column name
        let dbColumnName;
        const filterLower = validatedParams.metric_filter.toLowerCase();
         if ([ 'amount_collected', 'collected', 'gross', 'earnings' ].includes(filterLower)) {
            dbColumnName = 'amount_collected';
        } else if ([ 'royalty_payable', 'payable', 'net', 'royalty_line' ].includes(filterLower)) {
            dbColumnName = 'royalty_payable';
        } else if ([ 'units' ].includes(filterLower)) {
            dbColumnName = 'units';
        } else if ([ 'value', 'metric_value' ].includes(filterLower)) {
             dbColumnName = 'value';
        } else {
            console.warn(`Unsupported metric_filter for quarterly: ${validatedParams.metric_filter}. Defaulting to amount_collected.`);
            dbColumnName = 'amount_collected';
        }

        console.log(`Calling RPC get_quarterly_summary for column: ${dbColumnName}`);
        // Use the standard supabase client, not supabaseAdmin
        const { data, error } = await supabase.rpc('get_quarterly_summary', {
            catalog_filter_param: validatedParams.catalog_filter,
            metric_column_name: dbColumnName
        });

        if (error) {
            console.error("Error calling get_quarterly_summary RPC:", error);
            return { success: false, error: error.message };
        }

        console.log("Quarterly Summary RPC result:", data);
         const result = data?.map(q => ({ 
            ...q, 
            total_sum: parseFloat(Number(q.total_sum || 0).toFixed(2))
        })) || [];
        return { success: true, result: result }; 

    } catch (error) {
        console.error("Error in getQuarterlySummary:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves yearly summary for a specific metric using an RPC call.
 */
export async function getYearlySummary(params) {
    try {
        console.log("getYearlySummary called with params:", params);
        const validatedParams = yearlySummaryParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);
        
        let dbColumnName = mapMetricFilterToColumn(validatedParams.metric_filter, 'amount_collected');
        console.log(`Calling RPC get_yearly_summary for column: ${dbColumnName}`);
        
        // Use the standard supabase client, not supabaseAdmin
        const { data, error } = await supabase.rpc('get_yearly_summary', {
            catalog_filter_param: validatedParams.catalog_filter,
            metric_column_name: dbColumnName
        });

        if (error) {
            console.error("Error calling get_yearly_summary RPC:", error);
            return { success: false, error: error.message };
        }
        console.log("Yearly Summary RPC result:", data);
        
        const currentYear = new Date().getFullYear();
        const currentDateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

        const result = data?.map(y => {
            const year = y.year; // Assuming the RPC result has a 'year' field
            const isCurrentYear = year === currentYear;
            const period_type = isCurrentYear ? 'YTD' : 'FullYear';
            const start_date = `${year}-01-01`;
            // For simplicity, use current date as end for YTD, otherwise year-end
            const end_date = isCurrentYear ? currentDateStr : `${year}-12-31`; 
            
            return { 
                ...y, 
                total_sum: parseFloat(Number(y.total_sum || 0).toFixed(2)),
                period_type: period_type,
                start_date: start_date,
                end_date: end_date,
                // Ensure year is included if not already part of 'y' spread
                year: year 
            };
        }) || [];
        
        console.log("Processed Yearly Summary:", result);
        return { success: true, result: result };

    } catch (error) {
        console.error("Error in getYearlySummary:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves monthly summary for a specific metric, optionally filtered by year, using an RPC call.
 */
export async function getMonthlySummary(params) {
    try {
        console.log("getMonthlySummary called with params:", params);
        const validatedParams = monthlySummaryParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);
        
        let dbColumnName = mapMetricFilterToColumn(validatedParams.metric_filter, 'amount_collected');
        console.log(`Calling RPC get_monthly_summary for column: ${dbColumnName}`);
        
        // Use the standard supabase client, not supabaseAdmin
        const { data, error } = await supabase.rpc('get_monthly_summary', {
            catalog_filter_param: validatedParams.catalog_filter,
            metric_column_name: dbColumnName,
            year_filter_param: validatedParams.year_filter || null 
        });

        if (error) {
            console.error("Error calling get_monthly_summary RPC:", error);
            return { success: false, error: error.message };
        }
        console.log("Monthly Summary RPC result:", data);
        const result = data?.map(m => ({ ...m, total_sum: parseFloat(Number(m.total_sum || 0).toFixed(2)) })) || [];
        return { success: true, result: result };

    } catch (error) {
        console.error("Error in getMonthlySummary:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves the top N income types based on the sum of their 'amount_collected'
 * within a given catalog and period pattern using an RPC call.
 */
export async function getTopIncomeTypes(params) {
    try {
        console.log("getTopIncomeTypes called with params:", params);
        const validatedParams = topIncomeTypesParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);

        const { data, error } = await supabase.rpc('get_top_income_types_aggregate', {
            catalog_filter_param: validatedParams.catalog_filter,
            period_pattern_param: validatedParams.period_pattern,
            limit_param: validatedParams.n
        });

        if (error) {
            console.error("Error calling get_top_income_types_aggregate RPC:", error);
            return { success: false, error: error.message };
        }

        console.log("Top Income Types RPC result:", data);
        const result = data?.map(item => ({ 
            ...item, 
            total_collected: Number(item.total_collected) || 0
        })) || [];

        return { success: true, result: result }; 

    } catch (error) {
        console.error("Error in getTopIncomeTypes:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

/**
 * Retrieves the top N sources (e.g., streaming services) based on the sum of their 'amount_collected'
 * within a given catalog and period pattern using an RPC call.
 */
export async function getTopSources(params) {
    try {
        console.log("getTopSources called with params:", params);
        const validatedParams = topSourcesParamsSchema.parse(params);
        console.log("Validated params:", validatedParams);

        const { data, error } = await supabase.rpc('get_top_sources_aggregate', {
            catalog_filter_param: validatedParams.catalog_filter,
            period_pattern_param: validatedParams.period_pattern,
            limit_param: validatedParams.n
        });

        if (error) {
            console.error("Error calling get_top_sources_aggregate RPC:", error);
            return { success: false, error: error.message };
        }

        console.log("Top Sources RPC result:", data);
        const result = data?.map(item => ({ 
            ...item, 
            total_collected: Number(item.total_collected) || 0
        })) || [];

        return { success: true, result: result }; 

    } catch (error) {
        console.error("Error in getTopSources:", error);
        const message = error instanceof z.ZodError ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: message };
    }
}

// Helper function to map metric filter to column name (extracted for reuse)
function mapMetricFilterToColumn(metric_filter, defaultColumn) {
    const filterLower = metric_filter?.toLowerCase() || defaultColumn;
    if ([ 'amount_collected', 'collected', 'gross', 'earnings' ].includes(filterLower)) {
        return 'amount_collected';
    } else if ([ 'royalty_payable', 'payable', 'net', 'royalty_line' ].includes(filterLower)) {
        return 'royalty_payable';
    } else if ([ 'units' ].includes(filterLower)) {
        return 'units';
    } else if ([ 'value', 'metric_value' ].includes(filterLower)) {
         return 'value';
    } else {
        console.warn(`Unsupported metric_filter: ${metric_filter}. Defaulting to ${defaultColumn}.`);
        return defaultColumn;
    }
}

// --- Tool Definition for getComposersFromContent ---
const getComposersFromContentTool = tool({
    description: `Retrieves a list of unique composers/songwriters associated with a specific catalog by parsing the 'content' field from the database. Use this when asked about co-writers or composers for a catalog.`,
    parameters: z.object({
        catalog_filter: z.string().describe("The catalog ID to filter by (e.g., '100047'). REQUIRED."),
        limit: z.number().optional().default(20).describe("Maximum number of database rows to check for composer info. Defaults to 20."),
    }),
    execute: async ({ catalog_filter, limit }) => {
        console.log(`getComposersFromContent called with params:`, { catalog_filter, limit });
        if (!supabaseAdmin) {
            console.error("Supabase admin client not initialized in getComposersFromContent.");
            return { success: false, error: "Database connection error." };
        }
        if (!catalog_filter) {
            return { success: false, error: "Missing required parameter: catalog_filter." };
        }

        try {
            // Fetch rows for the specific catalog, selecting only the content field
            const { data, error } = await supabaseAdmin
                .from('rows')
                .select('content')
                .eq('catalog', catalog_filter)
                .limit(limit);

            if (error) {
                console.error("Error fetching rows for composers:", error);
                return { success: false, error: `Database query failed: ${error.message}` };
            }

            if (!data || data.length === 0) {
                return { success: true, composers: [], message: `No rows found for catalog ${catalog_filter} within the first ${limit} checked.` };
            }

            // --- Extract Composers ---
            const allComposers = new Set(); // Use a Set for automatic uniqueness

            for (const row of data) {
                if (row.content && typeof row.content === 'string') {
                    // Find the "Composers:" section
                    const composerPrefix = 'Composers:';
                    const composerIndex = row.content.indexOf(composerPrefix);

                    if (composerIndex !== -1) {
                        // Extract the text after "Composers:"
                        let composerString = row.content.substring(composerIndex + composerPrefix.length).trim();

                        // Sometimes there's extra info after composers, try to isolate the names
                        // Find the end of the composer list (e.g., before next field like "Song Title:")
                        // This is heuristic, might need refinement based on actual data variations
                        const potentialEndMarkers = ['\n', 'Song Title:', 'Client Code:']; // Add more if needed
                        let endIdx = composerString.length;
                        for(const marker of potentialEndMarkers) {
                            const markerIdx = composerString.indexOf(marker);
                            if (markerIdx !== -1) {
                                endIdx = Math.min(endIdx, markerIdx);
                            }
                        }
                        composerString = composerString.substring(0, endIdx).trim();

                        // Split by '/' and clean up names
                        const names = composerString.split('/')
                                        .map(name => name.trim())
                                        .filter(name => name.length > 0); // Remove empty strings

                        names.forEach(name => allComposers.add(name));
                    }
                }
            }

             const uniqueComposers = Array.from(allComposers);
             console.log(`Found composers for catalog ${catalog_filter}:`, uniqueComposers);

             if (uniqueComposers.length === 0) {
                return { success: true, composers: [], message: `Found rows for catalog ${catalog_filter} but couldn't extract composer names from the 'content' field within the first ${limit} rows checked.` };
            }

            return {
                success: true,
                composers: uniqueComposers,
                rows_checked: data.length,
                limit_used: limit
            };

        } catch (e) {
            console.error("Unexpected error in getComposersFromContent:", e);
            return { success: false, error: `An unexpected error occurred: ${e.message}` };
        }
    }
});

// Export all tools combined in the correct format
export const functionTools = [
  tool({
    description: 'Calculates OVERALL summary statistics (total sum, average, count) for a specific metric (e.g., amount_collected, royalty_payable, units) across periods matching a pattern (e.g., a specific year YYYY%, specific month YYYYMM%, or all periods %). Does NOT group results by period, song, type, or source. Use only for getting total/average/count across many rows.',
    name: 'calculateMetricSummary',
    parameters: calculationParamsSchema,
    execute: async (params) => {
      const result = await calculateMetricSummary(params);
      if (!result.success) {
        throw new Error(result.error || 'Failed to calculate metric summary.');
      }
      return result.result;
    }
  }),
  tool({
    description: 'Retrieves individual raw rows with the highest metric values (e.g., highest amount_collected). Does NOT aggregate or group data. Use ONLY if the user explicitly asks for individual top earning *rows* or raw data examples, NOT for summarized top lists.',
    name: 'getTopNRows',
    parameters: topNParamsSchema, 
    execute: async (params) => {
      const result = await getTopNRows(params);
      if (!result.success) {
        throw new Error(result.error || 'Failed to get top N rows.');
      }
      return result.result;
    }
  }),
  tool({
    description: 'Calculates and retrieves a ranked list of the top N songs based on the SUM of their collected amount within a given catalog and period. Use this specifically when asked for top *songs*.',
    name: 'getTopSongs',
    parameters: topSongsParamsSchema,
    execute: async (params) => {
      const result = await getTopSongs(params);
       if (!result.success) {
        throw new Error(result.error || 'Failed to get top songs.');
      }
      return result.result;
    }
  }),
  tool({
      description: 'Retrieves the total earnings for a *single*, specific song title within a given catalog and period.',
      name: 'getSongEarnings',
      parameters: songEarningsSchema,
      execute: async (params) => {
        const result = await getSongEarnings(params);
        if (!result.success) {
          throw new Error(result.error || 'Failed to get song earnings.');
        }
        return result.result;
      }
  }),
  tool({
    description: 'Retrieves a summary of earnings (or other metrics like units, royalty_payable) AGGREGATED and GROUPED by YEAR and QUARTER for a specific catalog. Use this ONLY when the user explicitly asks for a quarterly breakdown.',
    name: 'getQuarterlySummary',
    parameters: quarterlySummaryParamsSchema,
    execute: async (params) => {
      const result = await getQuarterlySummary(params);
      if (!result.success) {
        throw new Error(result.error || 'Failed to get quarterly summary.');
      }
      return result.result;
    }
  }),
  tool({
    description: 'Fetches actual yearly earnings data. This tool MUST be used before answering any questions about maturity, growth trends, evergreen status, or revenue cliffs. NEVER guess trends before calling this.',
    name: 'getYearlySummary',
    parameters: yearlySummaryParamsSchema,
    execute: async (params) => {
     const result = await getYearlySummary(params);
      if (!result.success) throw new Error(result.error || 'Failed to get yearly summary.');
      return result.result;
    }
  }),
  tool({
    description: 'Retrieves a summary of earnings (or other metrics like units, royalty_payable) AGGREGATED and GROUPED by MONTH (YYYYMM) for a specific catalog. Can be optionally filtered by a specific year. Use this ONLY when the user explicitly asks for a monthly breakdown.',
    name: 'getMonthlySummary',
    parameters: monthlySummaryParamsSchema,
    execute: async (params) => {
      const result = await getMonthlySummary(params);
      if (!result.success) throw new Error(result.error || 'Failed to get monthly summary.');
      return result.result;
    }
  }),
  tool({
    description: 'Retrieves the top N income types (e.g., Streaming Mechanical, Performance) ranked by the SUM of amount collected. It GROUPS rows by the \'income_type\' field. Use this to answer questions about which *income types* generate the most revenue.',
    name: 'getTopIncomeTypes',
    parameters: topIncomeTypesParamsSchema,
    execute: async (params) => {
      const result = await getTopIncomeTypes(params);
       if (!result.success) {
        throw new Error(result.error || 'Failed to get top income types.');
      }
      return result.result;
    }
  }),
  tool({
    description: 'Retrieves the top N sources (e.g., Spotify, Apple Music, YouTube, specific PROs like ASCAP/BMI) ranked by the SUM of amount collected. It GROUPS rows by the \'source_name\' field. Use this to answer questions about which *platforms, services, or organizations* generate the most revenue.',
    name: 'getTopSources',
    parameters: topSourcesParamsSchema,
    execute: async (params) => {
      const result = await getTopSources(params);
       if (!result.success) {
        throw new Error(result.error || 'Failed to get top sources.');
      }
      return result.result;
    }
  }),
  getComposersFromContentTool,
]; 