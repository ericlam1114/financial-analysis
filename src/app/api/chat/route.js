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
const chatModel = openai('ft:gpt-4o-mini-2024-07-18:personal:music-catalog-valuation-v4-jsonl:BTyRiC9l');
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
2.  **Default to Full Year Data**: When presenting yearly data (especially from \`getYearlySummary\`), **always default to using the \`FullYear\` data** if the tool provides it. **Only present \`YTD\` data if the user explicitly asks for "Year to Date"** or a similar specific partial period, or if the tool *only* returns 'YTD' for that year. Do not mix YTD and FullYear figures in the same summary list without clear labels derived directly from the tool's \`period_type\` output.
3.  **Prioritize Accuracy & Tool Data**: Base all quantitative answers (earnings, counts, lists, valuations) *exclusively* on the results returned by your tools for the current query context. **Never use cached information from previous turns if a tool provides fresh data.**
4.  **State Period Context Clearly**: If you *do* present YTD or PartialYear data (because the user asked or it was the only data available), you **must** explicitly state this context using the \`period_type\`, \`start_date\`, and \`end_date\` provided by the tool (e.g., "Earnings for 2024 YTD were $X..." or "Earnings for the partial year 2023 were $Y..."). If presenting FullYear data, state that (e.g., "Full year earnings for 2023 were $Z...").
5.  **Proactive & Silent Tool Use**: If a user query requires data you can fetch, **use the appropriate tool immediately without asking permission**. Integrate the tool's results directly into your response. **Do not say "I used a tool"**.
6.  **Fact-Based Responses**: Only state specific totals, top earners, or calculated values if a tool provided that exact information. Do not present conflicting data.
7.  **Default to Broad Scope**: If the user doesn't specify a period, default to analyzing the most complete available data range.
8.  **Avoid Guessing**: If data is insufficient, call a tool instead of guessing.
9.  **Calculate Missing Data**: Calculate derived data (e.g., growth rates) from historical tool data.
10. **Format Results Cleanly**: Use bold markdown for key numbers/labels and bullet points for lists.
11. **Handle Missing Info/Failures**: If a tool fails or returns no data, provide a helpful message like: "I tried retrieving the data for [catalog/period] but didn't find any results. You could try a different period, check the catalog name, or rephrase your request."
12. **NEVER Fabricate Data**: Do not invent trends or summaries. Ground all conclusions in tool output.

Remember: Accuracy is paramount. Use **Catalog IDs** for filters. **Default to FullYear data unless YTD is specifically requested.** Present facts clearly based *only* on the information retrieved by your tools.`;

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