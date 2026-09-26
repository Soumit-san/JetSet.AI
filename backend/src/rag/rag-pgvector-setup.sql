-- ====================================================
-- JetSet.AI — Supabase pgvector RAG Setup
-- Run once in the Supabase SQL editor (or via psql).
-- ====================================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. RAG documents table
--    Stores every chunk with its embedding vector.
--    embedding dimension = 1536 (openai/text-embedding-3-small)
CREATE TABLE IF NOT EXISTS rag_documents (
  id               SERIAL PRIMARY KEY,
  source_file      TEXT        NOT NULL,          -- e.g. "tokyo.md"
  chunk_index      INTEGER     NOT NULL,           -- 0-based chunk index within the file
  content          TEXT        NOT NULL,           -- raw chunk text
  embedding        vector(1536),                   -- OpenRouter openai/text-embedding-3-small
  embedding_model  TEXT        NOT NULL DEFAULT 'openai/text-embedding-3-small',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_file, chunk_index)               -- allow safe upserts
);

-- 3. HNSW index (cosine distance) — production-ready even for small datasets
CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
  ON rag_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. Helper index for fast count/exists queries used in startup check
CREATE INDEX IF NOT EXISTS rag_documents_source_idx
  ON rag_documents (source_file);

-- 5. Similarity search RPC
--    Called by RagService.performRetrieval() via the pg pool directly.
--    Returns top-k chunks ordered by cosine similarity (highest first).
CREATE OR REPLACE FUNCTION match_rag_documents(
  query_embedding  vector(1536),
  match_threshold  float    DEFAULT 0.3,
  match_count      integer  DEFAULT 5
)
RETURNS TABLE (
  id              integer,
  source_file     text,
  chunk_index     integer,
  content         text,
  embedding_model text,
  similarity      float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.source_file,
    d.chunk_index,
    d.content,
    d.embedding_model,
    (1 - (d.embedding <=> query_embedding))::float AS similarity
  FROM rag_documents d
  WHERE d.embedding IS NOT NULL
    AND (1 - (d.embedding <=> query_embedding)) >= match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
