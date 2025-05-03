// Placeholder for src/lib/embeddings.js
// Helper functions for interacting with OpenAI Embeddings API via Langchain

import { OpenAIEmbeddings } from "@langchain/openai";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OpenAI API Key. Please set OPENAI_API_KEY environment variable.");
}

// Initialize OpenAIEmbeddings 
const embeddings = new OpenAIEmbeddings({
  openAIApiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small", // Specify model directly if needed, defaults usually work
  // batchSize: 512, // Optional: Adjust batch size based on API limits and performance
});

/**
 * Generates embeddings for a given text.
 * @param {string} text - The text to embed.
 * @returns {Promise<number[]>} - The embedding vector.
 */
export async function getEmbeddings(text) {
  if (!text) {
    console.error("getEmbeddings: Text input is empty.");
    return [];
  }
  console.log(`Generating embedding for: "${text.substring(0, 50)}..."`);
  try {
    // Use embedQuery for single text embedding
    const vector = await embeddings.embedQuery(text);
    console.log(`Generated embedding of dimension: ${vector.length}`);
    return vector;
  } catch (error) {
    console.error("Error generating embeddings:", error);
    // Depending on desired behavior, you might want to return an empty array,
    // null, or re-throw the error for the caller to handle.
    throw error; 
  }
}

// Optionally add batch embedding function if needed
/**
 * Generates embeddings for multiple documents.
 * @param {string[]} documents - An array of texts to embed.
 * @returns {Promise<number[][]>} - An array of embedding vectors.
 */
export async function embedDocuments(documents) {
  if (!documents || documents.length === 0) {
      console.warn("embedDocuments: No documents provided.");
      return [];
  }
  console.log(`Generating batch embeddings for ${documents.length} documents...`);
  try {
      const vectors = await embeddings.embedDocuments(documents);
      console.log(`Generated ${vectors.length} embeddings.`);
      return vectors;
  } catch (error) {
      console.error("Error generating batch embeddings:", error);
      throw error;
  }
} 