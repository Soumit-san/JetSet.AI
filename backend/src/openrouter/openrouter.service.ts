import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

@Injectable()
export class OpenRouterService {
  private readonly logger = new Logger(OpenRouterService.name);
  private readonly baseUrl = 'https://openrouter.ai/api/v1';

  constructor(private readonly configService: ConfigService) {
    const key = this.getApiKey();
    if (key) {
      const model = this.getModel();
      const isFree = this.isFreeModel(model);
      if (isFree) {
        this.logger.log(`OpenRouter API initialized for OpenRouterService (Model: ${model} [VERIFIED FREE MODEL])`);
      } else {
        this.logger.warn(`[OpenRouterService Safety Guard] Configured model "${model}" does not have a ":free" suffix or "openrouter/free" ID. Free-only mode is active; defaulting to "openrouter/free" to prevent accidental paid usage.`);
      }
    } else {
      this.logger.warn('OPENROUTER_API_KEY is not configured in backend environment.');
    }
  }

  public getApiKey(): string {
    const raw = this.configService.get<string>('OPENROUTER_API_KEY') || process.env.OPENROUTER_API_KEY || '';
    return raw.trim();
  }

  public get hasKey(): boolean {
    return !!this.getApiKey();
  }

  public get isFreeOnly(): boolean {
    const val = this.configService.get<string>('OPENROUTER_FREE_ONLY') || process.env.OPENROUTER_FREE_ONLY;
    return val === 'true' || val === '1' || val === undefined;
  }

  public isFreeModel(modelName: string): boolean {
    if (!modelName) return false;
    const lower = modelName.toLowerCase().trim();
    return lower === 'openrouter/free' || lower.endsWith(':free') || lower.includes(':free') || lower.includes('/free');
  }

  public getModel(): string {
    const model = this.configService.get<string>('OPENROUTER_MODEL') || process.env.OPENROUTER_MODEL;
    if (model && model.trim()) {
      const trimmed = model.trim();
      if (this.isFreeModel(trimmed)) {
        return trimmed;
      }
      // Safety guard: if a non-free model is passed in a free-only environment, route to openrouter/free
      return 'openrouter/free';
    }
    return 'openrouter/free';
  }

  public getEmbeddingModel(): string {
    const model = this.configService.get<string>('OPENROUTER_EMBEDDING_MODEL') || process.env.OPENROUTER_EMBEDDING_MODEL;
    return (model && model.trim()) ? model.trim() : 'openai/text-embedding-3-small';
  }

  private getHeaders(): Record<string, string> {
    const key = this.getApiKey();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://jetset.ai',
      'X-Title': 'JetSet.AI',
    };
  }

  /**
   * Non-streaming Chat Completion (supports JSON mode & fallback models)
   */
  async chatCompletion(params: {
    messages: OpenRouterMessage[];
    model?: string;
    temperature?: number;
    expectJson?: boolean;
    maxTokens?: number;
  }): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('[OPENROUTER_AUTH_ERROR] OPENROUTER_API_KEY is not configured');
    }

    const model = params.model || this.getModel();
    if (this.isFreeOnly && !this.isFreeModel(model)) {
      throw new Error(`[OPENROUTER_SAFETY_GUARD] Blocked paid OpenRouter model "${model}". OPENROUTER_FREE_ONLY is active.`);
    }
    const body: any = {
      model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens,
    };

    if (params.expectJson) {
      body.response_format = { type: 'json_object' };
    }

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errJson: any = null;
        try { errJson = JSON.parse(errText); } catch {}
        const msg = errJson?.error?.message || errText || res.statusText;

        if (res.status === 401 || res.status === 403) {
          this.logger.error(`[OPENROUTER_AUTH_ERROR] Unauthorized (${res.status}): ${msg}`);
          throw new Error(`[OPENROUTER_AUTH_ERROR] ${msg}`);
        }
        if (res.status === 429) {
          this.logger.warn(`[OPENROUTER_RATE_LIMIT] Rate limit exceeded (429): ${msg}`);
          throw new Error(`[OPENROUTER_RATE_LIMIT] ${msg}`);
        }
        if (res.status >= 500) {
          this.logger.error(`[OPENROUTER_PROVIDER_ERROR] Server error (${res.status}): ${msg}`);
          throw new Error(`[OPENROUTER_PROVIDER_ERROR] ${msg}`);
        }
        throw new Error(`[OPENROUTER_PROVIDER_ERROR] Request failed (${res.status}): ${msg}`);
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      let content = choice?.message?.content || choice?.text;

      // Some free models return reasoning when content is null
      if (!content && choice?.message?.reasoning) {
        content = choice.message.reasoning;
      }

      if (!content || typeof content !== 'string') {
        throw new Error('[OPENROUTER_PROVIDER_ERROR] Empty or invalid response received from OpenRouter');
      }

      // If reasoning model wrapped response in <think>...</think>, strip thought tokens
      if (content.includes('</think>')) {
        const parts = content.split('</think>');
        const afterThink = parts[parts.length - 1].trim();
        if (afterThink) {
          content = afterThink;
        }
      }

      return content;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('timeout') || err.message?.includes('fetch failed')) {
        throw new Error(`[OPENROUTER_NETWORK_ERROR] ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Streaming Chat Completion (SSE)
   */
  async chatStream(params: {
    messages: OpenRouterMessage[];
    onChunk: (text: string) => void;
    model?: string;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.logger.warn('[OPENROUTER_AUTH_ERROR] OPENROUTER_API_KEY is not configured for stream');
      return false;
    }

    const model = params.model || this.getModel();
    if (this.isFreeOnly && !this.isFreeModel(model)) {
      this.logger.error(`[OPENROUTER_SAFETY_GUARD] Blocked paid OpenRouter model "${model}". OPENROUTER_FREE_ONLY is active.`);
      return false;
    }
    const body = {
      model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      stream: true,
    };

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: params.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.logger.error(`[OPENROUTER_STREAM_ERROR] Status ${res.status}: ${errText}`);
        return false;
      }

      if (!res.body) {
        this.logger.error('[OPENROUTER_STREAM_ERROR] No response body returned');
        return false;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              params.onChunk(delta);
            }
          } catch {
            // ignore partial JSON chunks
          }
        }
      }

      return true;
    } catch (err: any) {
      this.logger.error(`[OPENROUTER_STREAM_ERROR] Stream failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Generate text embedding via OpenRouter
   */
  async generateEmbedding(text: string, modelOverride?: string): Promise<number[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('[OPENROUTER_AUTH_ERROR] OPENROUTER_API_KEY is not configured');
    }

    const model = modelOverride || this.getEmbeddingModel();

    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model,
          input: text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errJson: any = null;
        try { errJson = JSON.parse(errText); } catch {}
        const msg = errJson?.error?.message || errText || res.statusText;

        if (res.status === 401 || res.status === 403) {
          this.logger.error(`[OPENROUTER_AUTH_ERROR] Unauthorized (${res.status}): ${msg}`);
          throw new Error(`[OPENROUTER_AUTH_ERROR] ${msg}`);
        }
        if (res.status === 429) {
          this.logger.warn(`[OPENROUTER_RATE_LIMIT] Embedding quota/rate limit (429): ${msg}`);
          throw new Error(`[OPENROUTER_RATE_LIMIT] ${msg}`);
        }
        throw new Error(`[OPENROUTER_PROVIDER_ERROR] Embedding error (${res.status}): ${msg}`);
      }

      const data = await res.json();
      const embedding = data.data?.[0]?.embedding;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('[OPENROUTER_PROVIDER_ERROR] Malformed embedding response from OpenRouter');
      }

      return embedding;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('timeout') || err.message?.includes('fetch failed')) {
        throw new Error(`[OPENROUTER_NETWORK_ERROR] ${err.message}`);
      }
      throw err;
    }
  }
}
