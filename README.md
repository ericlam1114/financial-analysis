# Valuations AI

Next.js 14 web app that ingests music catalog royalty data (CSV, XLSX, PDF) and answers valuation questions using RAG, function calling (DCF, NPV), and Supabase.

## Stack

*   **Frontend:** Next.js 14 (App Router), React, Tailwind CSS, shadcn/ui, react-query, react-dropzone
*   **Backend:** Next.js API Routes (Edge Runtime), LangChain.js, OpenAI (GPT-4o, Embeddings)
*   **Database:** Supabase (Postgres + pgvector)
*   **Storage:** Supabase Storage
*   **Math:** mathjs
*   **Parsing:** papaparse, exceljs, pdf-parse

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd valuations-ai
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up Supabase:**
    *   Create a new project on [Supabase](https://supabase.com/).
    *   In the SQL Editor, enable the `vector` extension:
        ```sql
        create extension vector;
        ```
    *   Create the `rows` table (adjust schema as needed):
        ```sql
        -- Example schema, adjust dimensions (e.g., 1536 for text-embedding-3-small)
        create table rows (
          id bigserial primary key,
          content text, -- Text used for embedding (e.g., "Catalog: X | Period: Y | Metric: Z | Value: V")
          embedding vector(1536), -- Store the embedding
          metadata jsonb, -- Store original row data, source file, etc.
          created_at timestamptz default now()
        );
        ```
    *   Create the `match_rows` RPC function (see `src/lib/rag/query.js` for the SQL).
    *   Create a Supabase Storage bucket (e.g., `royalty-files`). Make sure bucket policies allow uploads (and potentially reads) as needed.
    *   (Optional) Set up a `prompt_log` table if desired.

4.  **Set up Environment Variables:**
    *   Copy `.env.example` to `.env.local`:
        ```bash
        cp .env.example .env.local
        ```
    *   Fill in your Supabase Project URL, Anon Key, and OpenAI API Key in `.env.local`.

5.  **Install Supabase CLI (if deploying Edge Functions):**
    Follow instructions: [Supabase CLI Docs](https://supabase.com/docs/guides/cli)
    ```bash
    supabase login
    supabase link --project-ref <your-project-ref>
    ```

## Running Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment

1.  **Frontend (Vercel):**
    *   Connect your Git repository to Vercel.
    *   Configure environment variables (Supabase URL/Key, OpenAI Key) in Vercel project settings.
    *   Deploy.

2.  **Backend API Route (Supabase Edge Function):**
    *   Ensure Supabase CLI is linked to your project.
    *   Deploy the function:
        ```bash
        # Ensure your API route code is in `supabase/functions/api/chat/index.ts` or adjust path
        # The `package.json` script assumes the route is directly in `pages/api` which needs adjustment for Supabase deploy.
        # Manual deployment might be needed: copy relevant code to supabase/functions/api/chat
        npm run supabase:deploy 
        # OR: supabase functions deploy api/chat
        ```
    *   **Note:** The project structure uses Next.js API routes (`pages/api/chat`). Deploying this specific file *directly* as a Supabase Edge Function requires adapting the code structure or using a different deployment method (like deploying the *entire* Next.js app which Vercel handles).

## TODO / Next Steps

*   Implement actual file parsing logic in `src/lib/ingest.js`.
*   Implement embedding generation in `src/lib/embeddings.js`.
*   Build the real LangChain RAG chain in `src/lib/rag/query.js`.
*   Refine the API route (`/api/chat/route.js`) for proper LangChain streaming with tool results.
*   Implement the `uploadFile` client utility.
*   Connect `TracePanel` to display actual data from the API stream.
*   Implement Excel and Markdown export features.
*   Add logging to `prompt_log` table.
*   Add error handling and UI feedback (loading states, errors).
*   Write tests.
