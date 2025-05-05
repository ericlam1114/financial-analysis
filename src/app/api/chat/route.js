// src/app/api/chat/route.js - Refactored with Intent Router
import { createClient } from '@supabase/supabase-js';
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai"; // Import streamText from the ai package
import { embed } from "ai"; // Import embed from the ai package
import { functionTools, getYearlySummary } from "@/lib/openaiFunctions.js"; // Import getYearlySummary too
// Embeddings will also use the Vercel adapter implicitly or via a separate call if needed

// IMPORTANT: Set the runtime to edge
export const runtime = 'edge';

// No need for a separate provider instance here
// const openaiProvider = new OpenAI({
//     apiKey: process.env.OPENAI_API_KEY, 
// });

// Create specific model instances directly from the imported provider function
const chatModel = openai('ft:gpt-4o-mini-2024-07-18:personal:music-catalog-valuation-v2-jsonl:BTX7QCKs');
const embeddingModel = openai.embedding('text-embedding-3-small'); // Use the correct method on the provider function

// Initialize Supabase client (use SERVICE key for server-side access)
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { persistSession: false } } 
);
console.log("Initialized TOP-LEVEL Supabase Client:", typeof supabase);

// Helper function to log prompt data to Supabase (non-blocking)
async function logPrompt(logData) {
    try {
        const { error } = await supabase.from('prompt_log').insert([logData]);
        if (error) {
            console.error('Supabase prompt logging error:', error);
        }
    } catch (e) {
        console.error('Error in logPrompt function:', e);
    }
}

// --- Main API Route ---
export async function POST(req) {
    const startTime = Date.now();
    let logEntry = { user_prompt: '', rows_used: [], fn_called: null, retrieved_data: null, total_tokens: null, latency_ms: null };

    try {
        const { messages, catalog, client_name } = await req.json();
        const latestMessage = messages[messages.length - 1];
        const userPrompt = latestMessage?.content;
        logEntry.user_prompt = userPrompt;

        if (!userPrompt) {
            return Response.json({ error: 'Missing message content' }, { status: 400 });
        }
        console.log(`API Route: Received message for catalog '${catalog || "N/A"}':`, userPrompt);

        let history = messages.map((msg) => ({ role: msg.role, content: msg.content }));

        // *** Define the base system prompt ***
        let systemPrompt = `You are a proactive financial analyst assistant specialized in music royalty data.
Your primary goal is to provide accurate, data-driven answers based *only* on the information retrieved by your available tools. Follow these rules strictly:
1.  **Use Catalog IDs**: When calling any tool that requires filtering by catalog (e.g., using a \`catalog_filter\` parameter), **always use the numerical Catalog ID** (like '100047'), not the descriptive name (like 'Davadi, Edward [Reach JV]'). The current catalog ID is available contextually.
2.  **Prioritize Accuracy & Tool Data**: Base all quantitative answers (earnings, counts, lists, valuations) *exclusively* on the results returned by your tools for the current query context. **Never use cached information from previous turns if a tool provides fresh data.** When asked about a specific year, prioritize fetching the complete total for that *entire year*. Avoid summing partial data if a full-year summary is available or can be computed by a tool.
3.  **State Period Context Clearly**: If the \`getYearlySummary\` tool returns data labelled as 'YTD' or 'PartialYear', you **must** explicitly state this context in your answer (e.g., "Earnings for 2024 YTD were $X..." or "Earnings for the partial year 2023 were $Y..."). If it returns 'FullYear', state that (e.g., "Full year earnings for 2023 were $Z..."). Use the 'total_sum', 'period_type', 'start_date', and 'end_date' provided by the tool.
4.  **Proactive & Silent Tool Use**: If a user query requires data you can fetch (earnings, growth, summaries, top items, valuations), **use the appropriate tool immediately without asking permission**. Integrate the tool's results directly into your response. **Do not say "I used a tool" or describe the tool process.** Only state the result (e.g., "Total earnings were **$X**").
5.  **Fact-Based Responses**: Only state specific totals, top earners (songs, sources, periods), or calculated values if a tool provided that exact information. If asked for something like "top 5 songs" and the relevant tool wasn't called or returned no results, state that you need to check the data (e.g., "I need to check the data to find the top songs for that period.") and then attempt to use the appropriate tool. Do not present conflicting data from different tool calls without explaining the discrepancy (e.g., partial vs. full period).
6.  **Default to Broad Scope**: If the user doesn't specify a date range or period, default to analyzing the **most complete available data range** for the current catalog. Only narrow the scope if the user explicitly asks for a specific year, quarter, or month.
7.  **Avoid Guessing**: If retrieved context is insufficient, call an appropriate aggregation tool instead of guessing.
8.  **Calculate Missing Data**: If derived data (like growth rates) are needed, calculate them from historical data fetched by tools. Explain simple calculations clearly.
9.  **Format Results Cleanly**: Present numerical results clearly using **bold markdown** for key numbers/labels and bullet points for lists/breakdowns.
10. **Handle Missing Info/Failures**: Never say "I don't know." If a tool fails or returns no data, provide a helpful message: "I tried retrieving the data for [catalog/period] but didn't find any results. You could try a different period, check the catalog name, or rephrase your request."
11. **NEVER Fabricate Data**: Do NOT invent numerical trends or summaries. Never describe earnings behavior (e.g., "this catalog is evergreen" or "growth is accelerating") until *after* you have fetched actual data using the \`getYearlySummary\` tool.

Remember: Accuracy is paramount. Use **Catalog IDs** for filters. Prioritize complete data periods, use tools proactively, and present facts clearly based *only* on the information retrieved by your tools.`;

        // --- Safeguard: Pre-fetch yearly summary if keywords are present ---
        const lowerCasePrompt = userPrompt.toLowerCase();
        let preFetchedData = null;
        if (catalog && (lowerCasePrompt.includes("growth") || lowerCasePrompt.includes("evergreen"))) {
            console.log("Keywords 'growth' or 'evergreen' detected. Pre-fetching yearly summary for catalog:", catalog);
            try {
                const summaryResult = await getYearlySummary({ catalog_filter: catalog }); // Default metric 'amount_collected' is fine here
                if (summaryResult.success && summaryResult.result) {
                    console.log("Pre-fetched yearly summary data:", summaryResult.result);
                    preFetchedData = summaryResult.result; // Store for logging if needed
                    // *** Inject pre-fetched data into the system prompt for this call ***
                    systemPrompt += `\n\nIMPORTANT CONTEXT: The yearly summary for catalog ${catalog} has been pre-fetched. Use this data directly for assessing growth/maturity:\n${JSON.stringify(preFetchedData, null, 2)}`;
                } else {
                    console.warn("Pre-fetching yearly summary failed or returned no data:", summaryResult.error);
                     // Optionally inform the model about the failure? Or let it try again?
                }
            } catch (fetchError) {
                console.error("Error during pre-fetching yearly summary:", fetchError);
                // Log and proceed without pre-fetched data
            }
        }
        // --- End Safeguard ---

        console.log("System Prompt:", systemPrompt);

        // Single streamText call with maxSteps > 1
        const result = await streamText({
            model: chatModel,
            system: systemPrompt,
            messages: history,
            tools: functionTools,
            maxSteps: 10,
            async onFinish({ usage, finishReason, toolCalls, toolResults }) {
                // Log tool usage if any calls were made
                if (toolCalls && toolCalls.length > 0) {
                    logEntry.fn_called = toolCalls.map(tc => `${tc.toolName}(${JSON.stringify(tc.args)})`).join(', ');
                    logEntry.retrieved_data = JSON.stringify(toolResults);
                } else if (preFetchedData) {
                    // Log the pre-fetched data if no other tools were called
                    logEntry.fn_called = 'getYearlySummary (pre-fetched)';
                    logEntry.retrieved_data = JSON.stringify(preFetchedData);
                }
                logEntry.latency_ms = Date.now() - startTime;
                logEntry.total_tokens = usage?.totalTokens;
                logEntry.finish_reason = finishReason;
                logPrompt(logEntry);
            }
        });

        // Return the stream, which should now contain the final text content
        return result.toDataStreamResponse();

    } catch (error) {
        console.error("[API Chat Error]", error);
        logEntry.latency_ms = Date.now() - startTime;
        logPrompt({ ...logEntry, error: error.message });
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
        return Response.json({ error: errorMessage }, { status: 500 });
    }
}

// Removed handleAggregateQuery as logic is now integrated or handled by tools/streamText