import { Injectable, OnModuleInit, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeAndHash } from '../common/normalize';
import { OpenRouterService } from '../openrouter/openrouter.service';

// ─── Constants ────────────────────────────────────────────────────────────────
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const RAG_TABLE = 'rag_documents';
const SIMILARITY_FN = 'match_rag_documents';
const SIMILARITY_THRESHOLD = 0.3;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocumentChunk {
  filePath: string;
  chunkIndex: number;
  content: string;
  embedding?: number[];
}

interface PgVectorRow {
  id: number;
  source_file: string;
  chunk_index: number;
  content: string;
  embedding_model: string;
  similarity: number;
}

// ─── RagService ──────────────────────────────────────────────────────────────

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);

  /** In-memory fallback: all chunks with optional embeddings */
  private chunks: DocumentChunk[] = [];

  /** Whether OpenRouter embeddings are operational */
  private hasEmbeddingProvider = false;

  /** Whether Supabase pgvector is available and table is populated */
  private hasPgVector = false;

  /** Deduplicates identical in-flight RAG queries */
  private readonly inFlightRequests = new Map<string, Promise<string[]>>();

  constructor(
    private readonly openRouterService: OpenRouterService,
    @Inject('DATABASE_POOL') private readonly pool: any,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit() {
    // 1. Test embedding provider
    if (this.openRouterService.hasKey) {
      this.logger.log(
        `OpenRouter embedding provider detected (Model: ${this.openRouterService.getEmbeddingModel()})`,
      );
      const authOk = await this.testOpenRouterEmbedding();
      if (authOk) {
        this.hasEmbeddingProvider = true;
        this.logger.log('OpenRouter embedding authentication test succeeded');
      } else {
        this.hasEmbeddingProvider = false;
        this.logger.warn(
          'OpenRouter embedding test failed. RAG will fallback to keyword search.',
        );
      }
    } else {
      this.hasEmbeddingProvider = false;
      this.logger.warn(
        'OPENROUTER_API_KEY not configured. RAG will fallback to keyword search.',
      );
    }

    // 2. Load document chunks into memory (for fallback, always)
    await this.loadChunksIntoMemory();

    // 3. Setup Supabase pgvector
    await this.initPgVector();
  }

  // ─── Embedding Auth Test ───────────────────────────────────────────────────

  private async testOpenRouterEmbedding(): Promise<boolean> {
    try {
      const emb = await this.generateEmbedding(
        'JetSet AI embedding authentication test',
      );
      return Array.isArray(emb) && emb.length > 0;
    } catch (err: any) {
      const msg = err.message || '';
      if (
        msg.includes('OPENROUTER_AUTH_ERROR') ||
        msg.includes('401') ||
        msg.includes('403')
      ) {
        this.logger.error(
          `[OPENROUTER_AUTH_ERROR] OpenRouter embedding authentication failed: ${msg}`,
        );
      } else if (
        msg.includes('OPENROUTER_RATE_LIMIT') ||
        msg.includes('429')
      ) {
        this.logger.warn(
          `[OPENROUTER_RATE_LIMIT] OpenRouter embedding quota/rate limit reached (429): ${msg}`,
        );
      } else {
        this.logger.warn(
          `[OPENROUTER_PROVIDER_ERROR] OpenRouter embedding probe failed: ${msg}`,
        );
      }
      return false;
    }
  }

  // ─── Document Loading (in-memory chunks) ──────────────────────────────────

  /**
   * Loads all .md documents into this.chunks.
   * Does NOT generate embeddings — that is deferred to pgvector indexing.
   * For local-memory vector fallback, embeddings are added lazily on first retrieval.
   */
  private async loadChunksIntoMemory() {
    const pathsToTry = [
      path.join(process.cwd(), 'src', 'rag', 'documents'),
      path.join(__dirname, 'documents'),
    ];

    let docsDir = '';
    for (const p of pathsToTry) {
      if (fs.existsSync(p)) {
        docsDir = p;
        break;
      }
    }

    if (!docsDir) {
      docsDir = pathsToTry[1];
      fs.mkdirSync(docsDir, { recursive: true });
    }

    this.logger.log(`Loading documents from: ${docsDir}`);

    let files: string[] = [];
    try {
      files = fs
        .readdirSync(docsDir)
        .filter((file) => file.endsWith('.md'));
    } catch {
      this.logger.error(`Failed to read documents directory: ${docsDir}`);
    }

    this.logger.log(`Found ${files.length} documents for RAG indexing.`);

    const loadedChunks: DocumentChunk[] = [];
    for (const file of files) {
      const filePath = path.join(docsDir, file);
      const text = fs.readFileSync(filePath, 'utf-8');
      const sections = text
        .split(/\n\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      for (let i = 0; i < sections.length; i++) {
        loadedChunks.push({
          filePath: file,
          chunkIndex: i,
          content: sections[i],
        });
      }
    }

    this.chunks = loadedChunks;
    this.logger.log(`Loaded ${this.chunks.length} chunks into memory.`);
  }

  // ─── Supabase pgvector Setup ───────────────────────────────────────────────

  /**
   * Initialise Supabase pgvector:
   *  1. Enable the vector extension (idempotent).
   *  2. Ensure rag_documents table + index + RPC function exist.
   *  3. Check if the table is already indexed with the current model.
   *  4. Only generate/upsert embeddings when the table is empty or stale.
   */
  private async initPgVector() {
    try {
      // Enable extension (safe to run repeatedly)
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
      this.logger.log('Supabase pgvector extension: ACTIVE');

      // Create table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${RAG_TABLE} (
          id               SERIAL PRIMARY KEY,
          source_file      TEXT        NOT NULL,
          chunk_index      INTEGER     NOT NULL,
          content          TEXT        NOT NULL,
          embedding        vector(${EMBEDDING_DIM}),
          embedding_model  TEXT        NOT NULL DEFAULT '${EMBEDDING_MODEL}',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (source_file, chunk_index)
        );
      `);

      // Create HNSW index (idempotent)
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
          ON ${RAG_TABLE}
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
      `);

      // Source file lookup index
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS rag_documents_source_idx
          ON ${RAG_TABLE} (source_file);
      `);

      // Create / replace similarity RPC function
      await this.pool.query(`
        CREATE OR REPLACE FUNCTION ${SIMILARITY_FN}(
          query_embedding  vector(${EMBEDDING_DIM}),
          match_threshold  float    DEFAULT ${SIMILARITY_THRESHOLD},
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
          FROM ${RAG_TABLE} d
          WHERE d.embedding IS NOT NULL
            AND (1 - (d.embedding <=> query_embedding)) >= match_threshold
          ORDER BY d.embedding <=> query_embedding
          LIMIT match_count;
        END;
        $$;
      `);

      this.logger.log('Supabase RAG vector table: READY');

      // ── Check if indexing is needed ──────────────────────────────────────
      const countRes = await this.pool.query(
        `SELECT COUNT(*) AS cnt FROM ${RAG_TABLE} WHERE embedding_model = $1`,
        [EMBEDDING_MODEL],
      );
      const existingCount = parseInt(countRes.rows[0]?.cnt ?? '0', 10);

      this.logger.log(`RAG vector count (${EMBEDDING_MODEL}): ${existingCount}`);

      if (existingCount >= this.chunks.length && this.chunks.length > 0) {
        // Table is fully indexed — no OpenRouter calls needed
        this.hasPgVector = true;
        this.logger.log(
          `RAG similarity search ready (${existingCount} vectors, no re-indexing needed).`,
        );
        return;
      }

      // ── Index missing chunks ──────────────────────────────────────────────
      if (!this.hasEmbeddingProvider) {
        this.logger.warn(
          'Embedding provider unavailable — cannot index RAG vectors. Falling back to local memory.',
        );
        return;
      }

      this.logger.log(
        `Indexing ${this.chunks.length} chunks into Supabase pgvector using OpenRouter embeddings...`,
      );

      let successCount = 0;
      for (const chunk of this.chunks) {
        try {
          const embedding = await this.generateEmbedding(chunk.content);
          // Store in memory too (for local fallback)
          chunk.embedding = embedding;

          const pgVec = `[${embedding.join(',')}]`;
          await this.pool.query(
            `INSERT INTO ${RAG_TABLE}
               (source_file, chunk_index, content, embedding, embedding_model, updated_at)
             VALUES ($1, $2, $3, $4::vector, $5, NOW())
             ON CONFLICT (source_file, chunk_index) DO UPDATE
               SET content          = EXCLUDED.content,
                   embedding        = EXCLUDED.embedding,
                   embedding_model  = EXCLUDED.embedding_model,
                   updated_at       = NOW()`,
            [chunk.filePath, chunk.chunkIndex, chunk.content, pgVec, EMBEDDING_MODEL],
          );
          successCount++;
        } catch (err: any) {
          this.logger.error(
            `Failed to index chunk ${chunk.filePath}[${chunk.chunkIndex}]: ${err.message}`,
          );
        }
      }

      this.logger.log(
        `Embedding indexing complete: ${successCount}/${this.chunks.length} chunks upserted into Supabase.`,
      );

      if (successCount > 0) {
        this.hasPgVector = true;
        this.logger.log('RAG similarity search ready (Supabase pgvector).');
      }
    } catch (err: any) {
      this.logger.warn(
        `Supabase pgvector setup failed: ${err.message}. RAG will fallback to local memory.`,
      );
      this.hasPgVector = false;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Retrieve the top-`limit` relevant RAG context chunks for `query`.
   * Checks Supabase cache → pgvector → local-memory vector → keyword fallback.
   * Public API unchanged for all callers.
   */
  async retrieveContext(query: string, limit: number = 3): Promise<string[]> {
    if (this.chunks.length === 0) {
      await this.loadChunksIntoMemory();
    }
    if (this.chunks.length === 0) {
      return [];
    }

    // ── Cache hit ──────────────────────────────────────────────────────────
    const cacheKey = normalizeAndHash('rag_retrieval', { query, limit });
    const cachedData = (await this.cacheManager.get(cacheKey)) as
      | string[]
      | undefined;
    if (cachedData) {
      this.logger.debug('RAG cache HIT — returning cached context');
      return cachedData;
    }

    // ── Deduplicate in-flight identical queries ────────────────────────────
    const inFlight = this.inFlightRequests.get(cacheKey);
    if (inFlight) {
      this.logger.debug('Reusing in-flight RAG query');
      return inFlight;
    }

    const promise = (async () => {
      const results = await this.performRetrieval(query, limit);
      await this.cacheManager.set(cacheKey, results, 86400000); // 24 h
      return results;
    })();

    this.inFlightRequests.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  // ─── Internal Retrieval ────────────────────────────────────────────────────

  private async performRetrieval(
    query: string,
    limit: number,
  ): Promise<string[]> {
    // ── 1. Supabase pgvector ─────────────────────────────────────────────
    if (this.hasPgVector && this.hasEmbeddingProvider) {
      try {
        const queryEmbedding = await this.generateEmbedding(query);
        const pgVec = `[${queryEmbedding.join(',')}]`;

        const res = await this.pool.query(
          `SELECT id, source_file, chunk_index, content, embedding_model,
                  (1 - (embedding <=> $1::vector))::float AS similarity
           FROM ${RAG_TABLE}
           WHERE embedding IS NOT NULL
             AND (1 - (embedding <=> $1::vector)) >= $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [pgVec, SIMILARITY_THRESHOLD, limit],
        );

        if (res.rows && res.rows.length > 0) {
          this.logger.debug(
            `Supabase pgvector returned ${res.rows.length} chunks for query.`,
          );
          return res.rows.map((r: PgVectorRow) => r.content);
        }

        this.logger.debug(
          'Supabase pgvector returned 0 results — falling back to local memory.',
        );
      } catch (err: any) {
        this.logger.warn(
          `Supabase pgvector unavailable — using local-memory RAG fallback: ${err.message}`,
        );
      }
    }

    // ── 2. Local-memory vector search ───────────────────────────────────
    if (this.hasEmbeddingProvider) {
      try {
        // Lazily generate embeddings for in-memory chunks if not already done
        const chunksWithoutEmb = this.chunks.filter((c) => !c.embedding);
        if (chunksWithoutEmb.length > 0) {
          this.logger.log(
            `Local-memory fallback: generating ${chunksWithoutEmb.length} missing embeddings...`,
          );
          for (const chunk of chunksWithoutEmb) {
            try {
              chunk.embedding = await this.generateEmbedding(chunk.content);
            } catch {
              // silently skip individual failures
            }
          }
        }

        const queryEmbedding = await this.generateEmbedding(query);
        const scoredChunks = this.chunks
          .filter((chunk) => chunk.embedding)
          .map((chunk) => ({
            content: chunk.content,
            similarity: this.cosineSimilarity(chunk.embedding!, queryEmbedding),
          }));

        if (scoredChunks.length > 0) {
          scoredChunks.sort((a, b) => b.similarity - a.similarity);
          this.logger.debug(
            `Local-memory vector search returned ${Math.min(limit, scoredChunks.length)} chunks.`,
          );
          return scoredChunks.slice(0, limit).map((c) => c.content);
        }
      } catch (err: any) {
        this.logger.error(
          `Local-memory vector search failed: ${err.message}. Falling back to keyword search.`,
        );
      }
    }

    // ── 3. Keyword fallback ────────────────────────────────────────────────
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 2);
    const scoredChunks = this.chunks.map((chunk) => {
      let score = 0;
      const contentLower = chunk.content.toLowerCase();
      if (contentLower.includes(query.toLowerCase())) score += 10;
      for (const keyword of keywords) {
        if (contentLower.includes(keyword)) score += 2;
      }
      return { content: chunk.content, score };
    });
    scoredChunks.sort((a, b) => b.score - a.score);
    return scoredChunks
      .filter((c) => c.score > 0)
      .slice(0, limit)
      .map((c) => c.content);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openRouterService.hasKey) {
      this.hasEmbeddingProvider = false;
      throw new Error(
        '[OPENROUTER_AUTH_ERROR] OPENROUTER_API_KEY is not configured',
      );
    }
    try {
      return await this.openRouterService.generateEmbedding(text);
    } catch (error: any) {
      const msg = error.message || '';
      if (
        msg.includes('OPENROUTER_AUTH_ERROR') ||
        msg.includes('401') ||
        msg.includes('403')
      ) {
        this.hasEmbeddingProvider = false;
        throw new Error(
          `[OPENROUTER_AUTH_ERROR] OpenRouter authentication failed: ${msg}`,
        );
      }
      if (
        msg.includes('OPENROUTER_RATE_LIMIT') ||
        msg.includes('429')
      ) {
        this.hasEmbeddingProvider = false;
        throw new Error(
          `[OPENROUTER_RATE_LIMIT] OpenRouter quota/rate limit reached: ${msg}`,
        );
      }
      throw error;
    }
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ─── Public utility (used by existing callers) ─────────────────────────────

  /** @deprecated Use retrieveContext() */
  async loadAndIndexDocuments() {
    await this.loadChunksIntoMemory();
    await this.initPgVector();
  }
}
