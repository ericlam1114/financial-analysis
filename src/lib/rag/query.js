// Placeholder for src/lib/rag/query.js
// Handles building the LangChain RAG chain and querying Supabase vector store

import { supabase } from '../supabaseClient';
import { getEmbeddings } from '../embeddings'; // Keep single embedding for query
import { ChatOpenAI } from "@langchain/openai";
// Updated imports for Agent creation
import { PromptTemplate } from "@langchain/core/prompts";
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents"; 
import { RunnableSequence, RunnablePassthrough } from "@langchain/core/runnables";
import { formatToOpenAIFunctionMessages } from "langchain/agents/format_scratchpad";
import { OpenAIFunctionsAgentOutputParser } from "langchain/agents/openai/output_parser";
// import { StringOutputParser } from "@langchain/core/output_parsers"; // No longer needed here
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { calc_npv, calc_dcf } from "../math/valuation"; // Use correct exported names
// import { formatDocumentsAsString } from "langchain/util/document"; // Use custom formatting
// Note: SupabaseVectorStore might not be fully Edge Runtime compatible or needed if using RPC directly.

/**
 * Performs cosine similarity search against the Supabase vector store using RPC.
 * @param {string} queryText - The user's query.
 * @param {number} k - The number of top results to retrieve.
 * @returns {Promise<object[]>} - Array of relevant row objects (content, metadata, similarity) from the database.
 */
export async function cosineSimilaritySearch(queryText, k = 12) {
  console.log(`Performing cosine similarity search for: "${queryText}" (k=${k})`);
  if (!queryText) return [];

  try {
    const queryEmbedding = await getEmbeddings(queryText);
    if (!queryEmbedding || queryEmbedding.length === 0) {
        console.error('Failed to generate query embedding.');
        return [];
    }

    // Ensure you have the 'match_rows' function in Supabase SQL Editor
    const { data: rows, error } = await supabase.rpc('match_rows', {
      query_embedding: queryEmbedding,
      match_threshold: 0.1, // Keep lowered threshold for now
      match_count: k,
    });

    if (error) {
      console.error('Supabase vector search RPC error:', error);
      return [];
    }

    console.log(`Retrieved ${rows?.length || 0} rows from vector search.`);
    console.log("Raw RPC result rows:", JSON.stringify(rows, null, 2)); 
    
    // RPC function now returns { id, content, similarity }
    // Map this to the structure expected by LangChain (pageContent, metadata)
    return rows?.map(r => ({
        pageContent: r.content, // Use the content column directly
        metadata: {
            id: r.id,
            similarity: r.similarity
            // We no longer get catalog, period etc. directly from the RPC call
            // If needed, we'd have to fetch them separately using the ID
            // or store *everything* needed for display in the 'content' string during ingest
            // or adjust the SQL function again (might impact performance)
        }
    })) || [];

  } catch (error) {
    console.error("Error during cosine similarity search process:", error);
    return []; // Return empty on error
  }
}

/**
 * Formats retrieved documents.
 * @param {Array<object>} docs - Array of document objects from retrieval.
 * @returns {string} - Formatted context string.
 */
function formatContextWithDocType(docs) {
    // If no docs, return a specific string
    if (!docs || docs.length === 0) {
        return "No context documents found.";
    }
    // Now just display the pageContent (which comes from the DB 'content' column)
    return docs.map((doc, i) => {
        // The docType information would ideally be parsed from the content string itself
        // or we'd need to modify the SQL/retrieval again to get metadata
        return `${i + 1}. ${doc.pageContent || "(empty content)"}`;
    }).join("\n"); // Use single newline
}

/**
 * Creates the LangChain Agent Executor for RAG + Tool use.
 * @param {ChatOpenAI} llm - The initialized LangChain LLM (ChatOpenAI instance).
 * @param {object[]} functionSpecs - The JSON schemas for function calling.
 * @returns {AgentExecutor} - The constructed LangChain Agent Executor.
 */
export function makeChain(llm, functionSpecs) {
  console.log('Building LangChain Agent Executor...');

  // Tools remain the same
  const tools = [calc_npv, calc_dcf];

  // Define the prompt template for the agent
  const promptTemplate = 
  `You are an AI assistant specialized in analyzing music royalty data for valuation purposes. You will be given context labeled as [Eval] or [Ref]. 
  Your primary goal is to answer the user's question accurately based on the provided context and chat history.
  
  Instructions:
  1. Analyze the Question: Determine if the user is asking for a specific data point lookup or a financial calculation (NPV, DCF).
  2. Use Context: Base your answer *only* on the provided CONTEXT. The context contains rows from uploaded documents, formatted as "key: value | key: value ...".
  3. Data Lookup: If the question asks for specific data found in the context (like 'catalog_streams' for a specific 'streamed_quarter'), provide the answer directly from the relevant context row.
  4. Calculations (Tools):
     - If the question requires calculations like NPV or DCF, first check the CONTEXT for relevant cash flow data, specifically looking for rows with the metric **'Total Royalties'** from [Eval] data.
     - Attempt to extract the **'Value'** associated with 'Total Royalties' from these rows and order them chronologically based on the 'paid_quarter' or 'period' field associated with them.
     - The 'calc_npv' and 'calc_dcf' tools expect a 'cashFlows' argument which MUST be an array of numbers representing the cash flow for each period (e.g., [1000, 1200, 1150]).
     - If you can successfully extract a plausible sequence of cash flows from the context, use the appropriate tool with the extracted 'cashFlows' array and the discount rate (and terminal growth for DCF) provided in the user query.
  5. Insufficient Data for Calculation: If you cannot find a clear, consecutive sequence of 'Total Royalties' values suitable for the 'cashFlows' array, DO NOT attempt to use the tool. Instead, state clearly that you cannot perform the calculation because the necessary consecutive cash flow data is missing from the context. Explain what you found and what is missing.
  6. General Insufficiency: If the context lacks the specific data point for a lookup question, state that clearly.
  7. Do not make up information or calculations.

  CONTEXT:
  {context}

  CHAT HISTORY:
  {chat_history}

  USER INPUT:
  {input}

  AGENT SCRATCHPAD (Tool usage sequence):
  {agent_scratchpad}`;

  const prompt = PromptTemplate.fromTemplate(promptTemplate);

  const llmWithTools = llm.bind({ functions: functionSpecs });

  // Agent remains the same structure
  const agent = RunnableSequence.from([
    {
      input: (i) => i.input,
      chat_history: (i) => i.chat_history, 
      agent_scratchpad: (i) => formatToOpenAIFunctionMessages(i.intermediate_steps || []),
      context: async (i) => {
         const docs = await cosineSimilaritySearch(i.input, 10); 
         const formattedContext = formatContextWithDocType(docs);
         console.log("Formatted Context for Prompt:", formattedContext);
         return formattedContext; // Use updated formatting
      },
    },
    prompt,
    llmWithTools,
    new OpenAIFunctionsAgentOutputParser(),
  ]);

  const executor = AgentExecutor.fromAgentAndTools({ agent, tools });

  console.log('LangChain Agent Executor built.');
  return executor;
} 