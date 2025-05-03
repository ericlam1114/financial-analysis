// src/app/api/chat/route.js - Refactored with Intent Router
import { createClient } from '@supabase/supabase-js';
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai"; // Import streamText from the ai package
import { embed } from "ai"; // Import embed from the ai package
import { calculateMetricSummary } from "@/lib/openaiFunctions.js"; // Import backend functions directly
import { functionTools } from "@/lib/openaiFunctions.js";
// Embeddings will also use the Vercel adapter implicitly or via a separate call if needed

// IMPORTANT: Set the runtime to edge
export const runtime = 'edge';

// No need for a separate provider instance here
// const openaiProvider = new OpenAI({
//     apiKey: process.env.OPENAI_API_KEY, 
// });

// Create specific model instances directly from the imported provider function
const chatModel = openai('gpt-4.1');
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
            return new Response(JSON.stringify({ error: 'Missing message content' }), { status: 400 });
        }
        console.log(`API Route: Received message for catalog '${catalog || "N/A"}':`, userPrompt);

        // *** USE THE NEW SYSTEM PROMPT ***
        const systemPrompt = `You are a proactive financial analyst assistant specialized in music royalty data for the catalog: ${catalog || 'unknown'} (${client_name || 'unknown'}).

You have access to tools that retrieve earnings, top songs, and metric summaries across any year, quarter, or month.

Your behavior rules:
1. Always take initiative: if the user asks a question that requires data you can fetch (e.g., earnings, growth, summaries), **use the tools immediately** without asking for permission.
2. If data is missing (e.g., growth rate), calculate it from available history (e.g., use past years to derive an average).
3. If the period isn't specified, assume the broadest reasonable scope (e.g., fetch all years and derive what's needed).
4. Clearly format your response, using:
   - **bold** for key numbers
   - bullet points for clarity
   - simple math in plain language (avoid LaTeX or special math syntax)

If a tool fails or returns no results, state that clearly and explain what the user can do next.

You are expected to *answer the user's intent*, not just their literal words. Use judgment and be helpful.`;
        
        console.log("System Prompt:", systemPrompt);

        const history = messages.map((msg) => ({ role: msg.role, content: msg.content }));

        // Single streamText call with maxSteps > 1
        const result = await streamText({
            model: chatModel,
            system: systemPrompt,
            messages: history,
            tools: functionTools,
            maxSteps: 5,
            async onFinish({ usage, finishReason, toolCalls, toolResults }) {
                // Log tool usage if any calls were made
                if (toolCalls && toolCalls.length > 0) {
                    logEntry.fn_called = toolCalls.map(tc => `${tc.toolName}(${JSON.stringify(tc.args)})`).join(', ');
                    logEntry.retrieved_data = JSON.stringify(toolResults);
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

// Handle aggregate query with metadata functions
const handleAggregateQuery = async (params) => {
    console.log("Handling aggregate query...");
    console.log("Extracted Params:", params);

    try {
        // Call the appropriate function based on the type of query
        const aggregateResult = await calculateMetricSummary(params);
        console.log("Aggregate data retrieved:", aggregateResult);

        if (!aggregateResult.success) {
            console.log("Aggregate query failed:", aggregateResult.error);
            // If there was an error, pass that to the LLM
            const systemPrompt = `I encountered an issue while calculating the aggregate data: ${aggregateResult.error}. Please inform the user about this problem.`;
            return generateChatResponse(systemPrompt, {});
        }

        // Pass the actual aggregate data to the LLM for formatting the response
        const systemPrompt = `You have calculated the following aggregate data for the **${selectedCatalog}** catalog based on the user's request. Please present this information clearly using bullet points. Ensure key numerical values (like totals, averages) are emphasized using **markdown bolding**. Use only the data provided below.
Data:
${JSON.stringify(aggregateResult, null, 2)}`;

        return generateChatResponse(systemPrompt, {});
    } catch (error) {
        console.error("Error in handleAggregateQuery:", error);
        const systemPrompt = `I encountered an error while trying to calculate the aggregate data: ${error.message}. Please try again or contact support if the issue persists.`;
        return generateChatResponse(systemPrompt, {});
    }
};