import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { TripsService } from '../trips/trips.service';
import { RagService } from '../rag/rag.service';
import { normalizeAndHash } from '../common/normalize';

export interface ItineraryStopDto {
  city: string;
  dayStart: number;
  dayEnd: number;
  checkin: string;
  checkout: string;
  displayCheckin: string;
  displayCheckout: string;
}

export interface FlightLegItemDto {
  legNum: number;
  from: string;
  fromIata: string;
  to: string;
  toIata: string;
  date: string;
  note?: string;
}

export interface FlightLegsDto {
  gateway: string;
  gatewayIata: string;
  outbound: FlightLegItemDto[];
  return: FlightLegItemDto[];
  groundSegments: string[];
}

export interface DestinationWarningDto {
  isSensitive: boolean;
  isOffSeason: boolean;
  warningTitle: string | null;
  warningMessage: string | null;
}



class SectionStreamer {
  private buffer = '';
  private started = false;
  private ended = false;

  constructor(
    private startDelim: string,
    private endDelim: string,
    private onChunk: (text: string) => void
  ) {}

  push(chunk: string) {
    if (this.ended) return;
    this.buffer += chunk;

    if (!this.started) {
      const idx = this.buffer.indexOf(this.startDelim);
      if (idx !== -1) {
        this.started = true;
        this.buffer = this.buffer.substring(idx + this.startDelim.length);
      }
    }

    if (this.started) {
      const endIdx = this.buffer.indexOf(this.endDelim);
      if (endIdx !== -1) {
        const send = this.buffer.substring(0, endIdx);
        if (send) this.onChunk(send);
        this.ended = true;
      } else {
        const safeLength = this.buffer.length - this.endDelim.length;
        if (safeLength > 0) {
          const send = this.buffer.substring(0, safeLength);
          this.onChunk(send);
          this.buffer = this.buffer.substring(safeLength);
        }
      }
    }
  }

  flush() {
    if (this.started && !this.ended) {
      if (this.buffer) this.onChunk(this.buffer);
    }
  }
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private hasApiKey = false;
  private hasGrokKey = false;
  private readonly activeGenerations = new Map<string, Promise<string>>();
  private readonly inFlightChatRequests = new Map<string, Promise<string>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly tripsService: TripsService,
    private readonly ragService: RagService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (geminiKey && geminiKey.trim() !== '') {
      this.hasApiKey = true;
      this.logger.log('Google Gemini API initialized for AiService');
    }
    const grokKey = this.configService.get<string>('GROK_API_KEY');
    if (grokKey && grokKey.trim() !== '') {
      this.hasGrokKey = true;
      this.logger.log('Grok API initialized for AiService');
    }
  }

  private getGrokConfig(): { url: string; model: string; headers: Record<string, string> } {
    const key = this.configService.get<string>('GROK_API_KEY') || '';
    if (key.startsWith('gsk_')) {
      return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'openai/gpt-oss-20b',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
      };
    } else {
      return {
        url: 'https://api.x.ai/v1/chat/completions',
        model: 'grok-2-latest',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
      };
    }
  }

  // ─── Circuit-breaker state (in-process, resets after GROK_COOLDOWN_MS) ───────
  private grokCircuitOpen = false;
  private grokCircuitOpenAt = 0;
  private readonly GROK_COOLDOWN_MS = 30_000; // 30 s
  private readonly AI_REQUEST_TIMEOUT_MS = 12_000; // 12 s per provider

  /** Returns true when Grok should be skipped due to recent failures. */
  private isGrokCircuitOpen(): boolean {
    if (!this.grokCircuitOpen) return false;
    if (Date.now() - this.grokCircuitOpenAt > this.GROK_COOLDOWN_MS) {
      this.grokCircuitOpen = false;
      this.logger.log('Grok circuit breaker reset — retrying Grok.');
      return false;
    }
    return true;
  }

  private tripGrokCircuit(reason: string) {
    this.grokCircuitOpen = true;
    this.grokCircuitOpenAt = Date.now();
    this.logger.warn(`Grok circuit opened for ${this.GROK_COOLDOWN_MS / 1000}s: ${reason}`);
  }

  /** Wraps a fetch promise with a hard timeout. Rejects with a timeout error if exceeded. */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  private async callModelWithFallback(
    prompt: string,
    systemPrompt = 'You are a helpful travel planning assistant.',
    expectJson = false,
  ): Promise<string> {
    const grokKey = this.configService.get<string>('GROK_API_KEY');
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');

    const hasGrok = !!(grokKey && grokKey.trim());
    const hasGemini = !!(geminiKey && geminiKey.trim());

    if (!hasGrok && !hasGemini) {
      throw new Error('No AI credentials available (both Gemini and Grok/Groq keys are missing)');
    }

    // ── Fast path: if both providers available AND Grok circuit is closed, race them ──
    if (hasGrok && hasGemini && !this.isGrokCircuitOpen()) {
      const config = this.getGrokConfig();
      const grokBody: any = {
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ]
      };
      if (expectJson) grokBody.response_format = { type: 'json_object' };

      const geminiBody: any = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      };
      if (expectJson) geminiBody.generationConfig = { responseMimeType: 'application/json' };

      // Race both providers — whichever replies first wins
      const grokPromise = this.withTimeout(
        fetch(config.url, { method: 'POST', headers: config.headers, body: JSON.stringify(grokBody) })
          .then(async (res) => {
            if (!res.ok) throw new Error(`Grok status ${res.status}`);
            const d = await res.json();
            const c = d.choices?.[0]?.message?.content;
            if (!c?.trim()) throw new Error('Grok returned empty content');
            return { source: 'grok' as const, text: c };
          }),
        this.AI_REQUEST_TIMEOUT_MS,
        'Grok'
      );

      const geminiPromise = this.withTimeout(
        fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiBody)
        }).then(async (res) => {
          if (!res.ok) throw new Error(`Gemini status ${res.status}`);
          const d = await res.json();
          const t = d.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!t?.trim()) throw new Error('Gemini returned empty content');
          return { source: 'gemini' as const, text: t };
        }),
        this.AI_REQUEST_TIMEOUT_MS,
        'Gemini'
      );

      try {
        // Promise.any → first successful response wins
        const winner = await Promise.any([grokPromise, geminiPromise]);
        this.logger.log(`callModelWithFallback: ${winner.source} responded first`);
        if (winner.source === 'gemini') {
          // Grok was slower/failed — open circuit so next calls skip it immediately
          this.tripGrokCircuit('Grok was slower than Gemini in race');
        }
        return winner.text;
      } catch {
        // Both failed in race — fall through to sequential below
        this.tripGrokCircuit('Both providers failed in race');
      }
    }

    // ── Slow path: try providers sequentially with timeouts ──
    if (hasGrok && !this.isGrokCircuitOpen()) {
      try {
        const config = this.getGrokConfig();
        const body: any = {
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ]
        };
        if (expectJson) body.response_format = { type: 'json_object' };

        this.logger.log(`callModelWithFallback: trying Grok (${config.model})...`);
        const res = await this.withTimeout(
          fetch(config.url, { method: 'POST', headers: config.headers, body: JSON.stringify(body) }),
          this.AI_REQUEST_TIMEOUT_MS,
          'Grok'
        );
        if (res.ok) {
          const data = await res.json();
          const content = data.choices?.[0]?.message?.content;
          if (content?.trim()) return content;
        } else {
          const errText = await res.text().catch(() => '');
          this.tripGrokCircuit(`status ${res.status}: ${errText.slice(0, 100)}`);
        }
      } catch (e: any) {
        this.tripGrokCircuit(e.message);
        this.logger.warn(`Grok failed: ${e.message} — switching to Gemini...`);
      }
    }

    if (!hasGemini) throw new Error('Gemini key not configured and Grok failed');

    // Use only the fast flash-lite model; 2.5-flash is slower and not needed for simple tasks
    try {
      this.logger.log('callModelWithFallback: using Gemini fallback...');
      const body: any = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      };
      if (expectJson) body.generationConfig = { responseMimeType: 'application/json' };

      const res = await this.withTimeout(
        fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }),
        this.AI_REQUEST_TIMEOUT_MS,
        'Gemini'
      );
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text?.trim()) return text;
      }
    } catch (e: any) {
      this.logger.error(`Gemini fallback failed: ${e.message}`);
    }

    throw new Error('All model generation attempts failed');
  }

  async getSummaryStream(tripId: string, onChunk: (text: string) => void, onComplete: () => void) {
    let trip;
    try {
      trip = await this.tripsService.getTrip(tripId);
    } catch {
      trip = {
        origin: 'London',
        destination: 'Paris',
        fromDate: '2026-07-10',
        toDate: '2026-07-15',
        budget: 'Mid-Range',
        companions: 'Couple',
        interests: ['Culture', 'Food'],
        currency: 'USD'
      };
    }

    // Check if combined plan is cached
    if (trip.combinedPlan) {
      const summaryText = this.extractSection(trip.combinedPlan, 'summary');
      await this.streamString(summaryText, onChunk);
      onComplete();
      return;
    }

    const ragContext = await this.ragService.retrieveContext(trip.destination, 3);
    const contextString = ragContext.length > 0
      ? ragContext.join('\n\n')
      : 'No travel document context found in library. Use general knowledge.';

    let geminiSucceeded = false;
    try {
      const streamer = new SectionStreamer('---SUMMARY_START---', '---SUMMARY_END---', onChunk);
      const fullResponse = await this.callCombinedPlanGenerationStream(trip, contextString, (chunk) => {
        streamer.push(chunk);
      });
      streamer.flush();
      geminiSucceeded = true;

      // Try to cache — but don't let cache failure break the response
      try {
        await this.tripsService.updateTrip(tripId, { combinedPlan: fullResponse });
      } catch (cacheErr: any) {
        this.logger.warn(`Could not cache combined plan for trip ${tripId}: ${cacheErr.message}`);
      }
      onComplete();
    } catch (error: any) {
      this.logger.error(`Failed to stream summary combined plan: ${error.message}`);
      if (!geminiSucceeded) {
        const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
        const grokKey = this.configService.get<string>('GROK_API_KEY');
        let reason = 'The AI model quota limits have been temporarily exceeded or the API services returned a rate limit error (429).';
        if (!geminiKey && !grokKey) {
          reason = 'Both GEMINI_API_KEY and GROK_API_KEY are missing from the backend configuration.';
        }
        const apology = `
> ### 🌍 A Gentle Apology from JetSet.AI
> 
> We are sincerely sorry, but our intelligent planning assistant is currently unable to generate a fresh custom plan.
> **Reason:** ${reason}
> 
> * **For Developers:** Please check and verify that your \`GEMINI_API_KEY\` and/or \`GROK_API_KEY\` in your backend \`.env\` file are set, active, and have sufficient billing credits to execute requests.
> * **For Travelers:** While we wait for the AI endpoints to reset, here is a localized backup itinerary we prepared for you to get started:
> 
`;
        onChunk(apology);
        await this.streamMockSummary(trip, contextString, onChunk, onComplete);
      } else {
        onComplete();
      }
    }
  }

  private async detectAndApplyTripUpdates(tripId: string, trip: any, userMsg: string): Promise<any | null> {
    const prompt = `
You are JetSet.AI's structural planning agent.
The user is conversing with the chatbot about their trip plan.
Current Trip Parameters:
- Origin: "${trip.origin || ''}"
- Destination: "${trip.destination || ''}"
- From Date: "${trip.fromDate || ''}"
- To Date: "${trip.toDate || ''}"
- Budget: "${trip.budget || ''}"
- Companions: "${trip.companions || ''}"
- Interests: ${JSON.stringify(trip.interests || [])}

User message: "${userMsg}"

Task:
Determine if the user is requesting to modify any of the structural parameters of their trip (e.g., changing the destination, the origin, changing dates, adding/removing companions/kids, changing budget tier to luxury/economy, or modifying interests).
If they are NOT requesting any change, output: {}

If they are requesting a change, return a JSON object with the UPDATED fields. Only include fields that are changing.
For dates, parse them to YYYY-MM-DD format.
For companions, translate terms like "i am going with my wife" -> "Couple", "with kids / family / wife and child" -> "Family", "alone" -> "Solo", "friends" -> "Friends".
For budget, translate "cheap/budget" -> "Budget", "mid-range/medium" -> "Mid-Range", "expensive/luxury/luxury style" -> "Luxury".
For interests, if they say "add shopping" or "i like food", add them to the array.

Output ONLY valid JSON. No markdown blocks, no explanations.
Example:
{"budget": "Luxury", "companions": "Family"}
`;

    try {
      const text = await this.callModelWithFallback(
        prompt,
        "You are JetSet.AI's structural planning agent.",
        true
      );
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      if (!cleanJson || cleanJson === '{}') return null;

      const updates = JSON.parse(cleanJson);
      if (Object.keys(updates).length > 0) {
        // Clear cached plan/seasonGuide since structural params changed
        updates.combinedPlan = null;
        updates.seasonGuide = null;
        this.logger.log(`Detected trip updates: ${JSON.stringify(updates)}`);
        await this.tripsService.updateTrip(tripId, updates);
        return updates;
      }
    } catch (e: any) {
      this.logger.error(`Error detecting trip updates: ${e.message}`);
    }
    return null;
  }

  async getChatStream(
    tripId: string, 
    messages: { role: 'user' | 'model'; content: string }[], 
    onChunk: (text: string) => void, 
    onComplete: () => void
  ) {
    let trip: any;
    try {
      trip = await this.tripsService.getTrip(tripId);
    } catch {
      trip = { destination: 'Paris' };
    }

    const latestUserMessage = messages[messages.length - 1]?.content || '';

    // 1. Detect structural trip modifications (e.g. changing companion, dates, budget, destination)
    let detectedUpdates: any = null;
    try {
      detectedUpdates = await this.detectAndApplyTripUpdates(tripId, trip, latestUserMessage);
      if (detectedUpdates) {
        // Merge updates locally so prompts are constructed with the latest structural details
        trip = { ...trip, ...detectedUpdates };
      }
    } catch (e: any) {
      this.logger.warn(`Could not run trip updates detector: ${e.message}`);
    }

    // Check if it's the Itinerary Module Request
    const isItineraryRequest = latestUserMessage.includes('day-by-day travel itinerary') || latestUserMessage.includes('travel itinerary');
    if (isItineraryRequest) {
      if (trip.combinedPlan) {
        const itineraryText = this.extractSection(trip.combinedPlan, 'itinerary');
        if (itineraryText) {
          await this.streamString(itineraryText, onChunk);
          onComplete();
          return;
        }
      }

      // Deduplicate active parallel itinerary generations
      const genKey = `itinerary_${tripId}`;
      const activeGen = this.activeGenerations.get(genKey);
      if (activeGen) {
        this.logger.log(`Reusing active in-flight itinerary generation for trip ${tripId}`);
        try {
          const res = await activeGen;
          const itineraryText = this.extractSection(res, 'itinerary');
          if (itineraryText) {
            await this.streamString(itineraryText, onChunk);
          }
        } catch (err: any) {
          this.logger.error(`Awaited itinerary generation failed: ${err.message}`);
        }
        onComplete();
        return;
      }

      // Generate and cache combined plan, streaming the itinerary
      const ragContext = await this.ragService.retrieveContext(trip.destination, 3);
      const contextString = ragContext.length > 0 ? ragContext.join('\n\n') : 'No travel guide context. Use general knowledge.';
      
      const promise = (async () => {
        const streamer = new SectionStreamer('---ITINERARY_START---', '---ITINERARY_END---', onChunk);
        const fullResponse = await this.callCombinedPlanGenerationStream(trip, contextString, (chunk) => {
          streamer.push(chunk);
        });
        streamer.flush();
        try {
          await this.tripsService.updateTrip(tripId, { combinedPlan: fullResponse });
        } catch (cacheErr: any) {
          this.logger.warn(`Could not cache itinerary plan for trip ${tripId}: ${cacheErr.message}`);
        }
        return fullResponse;
      })();

      this.activeGenerations.set(genKey, promise);
      try {
        await promise;
      } catch (err: any) {
        this.logger.error(`Combined plan itinerary generation failed: ${err.message}`);
      } finally {
        this.activeGenerations.delete(genKey);
        onComplete();
      }
      return;
    }

    // Check if it's the When to Go Module Request
    const isSeasonRequest = latestUserMessage.includes('Best Time to Visit');
    if (isSeasonRequest) {
      if (trip.seasonGuide && trip.seasonGuide.length > 50 && !trip.seasonGuide.includes('|')) {
        await this.streamString(trip.seasonGuide, onChunk);
        onComplete();
        return;
      }

      // Deduplicate active parallel season guide generations
      const genKey = `season_${trip.destination}`;
      const activeGen = this.activeGenerations.get(genKey);
      if (activeGen) {
        this.logger.log(`Reusing active in-flight season guide generation for destination ${trip.destination}`);
        try {
          const res = await activeGen;
          await this.streamString(res, onChunk);
        } catch (err: any) {
          this.logger.error(`Awaited season guide generation failed: ${err.message}`);
        }
        onComplete();
        return;
      }

      const promise = (async () => {
        const fullResponse = await this.callSeasonGuideGenerationStream(trip.destination, onChunk);
        try {
          await this.tripsService.updateTrip(tripId, { seasonGuide: fullResponse });
        } catch (cacheErr: any) {
          this.logger.warn(`Could not cache season guide: ${cacheErr.message}`);
        }
        return fullResponse;
      })();

      this.activeGenerations.set(genKey, promise);
      try {
        await promise;
      } catch (err: any) {
        this.logger.error(`Season guide generation failed: ${err.message}`);
      } finally {
        this.activeGenerations.delete(genKey);
        onComplete();
      }
      return;
    }

    // Chatbot query classifier
    const queryCategory = this.classifyQuery(latestUserMessage);

    // Grok easy/medium cache lookup (for initial non-history queries)
    const isConversationalHistory = messages.length > 1;
    const chatbotCacheKey = normalizeAndHash('chatbot_query', {
      query: latestUserMessage,
      destination: trip.destination,
    });

    if (!isConversationalHistory && (queryCategory === 'easy' || queryCategory === 'medium')) {
      const cached = await this.cacheManager.get(chatbotCacheKey) as string;
      if (cached) {
        this.logger.log(`Returning cached Grok chatbot response for query: "${latestUserMessage}"`);
        await this.streamString(cached, onChunk);
        onComplete();
        return;
      }
    }

    const ragContext = await this.ragService.retrieveContext(`${trip.destination} ${latestUserMessage}`, 3);
    const contextString = ragContext.length > 0
      ? ragContext.join('\n\n')
      : 'No travel document context found in library. Use general knowledge.';

    const tripInterests = trip.interests && trip.interests.length > 0
      ? `The user's selected interests are: ${trip.interests.join(', ')}.`
      : `The user did not specify interests.`;

    const systemInstruction = `
You are JetSet.AI, a smart, conversational travel assistant. 
The user is planning a trip to ${trip.destination}.
Current Trip context: Origin=${trip.origin || 'Unknown'}, Dates=${trip.fromDate || ''} to ${trip.toDate || ''}, Budget=${trip.budget || ''}, Companions=${trip.companions || ''}.
${tripInterests}

Conversation Guidelines:
1. Be natural, friendly, and brief. Answer only what the user asks directly.
2. If the user greets you (e.g. "hi", "hello", "bonjour"), greet them back warmly in 1-2 short sentences, ask how you can help them plan their trip, and do NOT dump a long list of tourist attractions or guides.
3. If they ask about local recommendations, only then provide highly curated suggestions.
4. If they state a modification (e.g. "change budget to luxury", "i have a kid", "we are 2 people now", "change dates"), acknowledge in a friendly way that you've updated the planner and are updating the blueprint details (flights, stays, itinerary).
5. Whenever you apply a structural change to the trip (e.g. updating budget, companion, dates, destination, or interests), you MUST include a clickable tab link in your reply using the format: [Link Text](tab:tabId) where tabId can be 'flights', 'hotels', 'itinerary', or 'season'. For example: "I have updated your trip parameters. You can [view your updated itinerary here](tab:itinerary) or [view luxury stays here](tab:hotels)!"
6. Keep your tone premium, helpful, and concise. Format all responses in clean markdown.

RAG Travel Guide Context:
${contextString}
`;

    // Map roles: model -> model (Google Gemini roles are 'user' and 'model')
    const contents = messages.map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    let queryHandled = false;
    let accumulatedResponse = '';
    const chunkWrapper = (chunk: string) => {
      accumulatedResponse += chunk;
      onChunk(chunk);
    };

    if (queryCategory === 'easy' || queryCategory === 'medium') {
      this.logger.log(`Routing ${queryCategory} query to Grok: "${latestUserMessage}"`);
      const success = await this.callGrokChatStream(systemInstruction, contents, chunkWrapper);
      if (success) {
        queryHandled = true;
      } else {
        this.logger.warn('Grok failed or is not available. Falling back to Gemini...');
      }
    }

    if (!queryHandled) {
      // Default to Gemini for complex queries or easy/medium fallback
      this.logger.log(`Routing query to Gemini: "${latestUserMessage}"`);
      const success = await this.callGeminiChatStream(systemInstruction, contents, chunkWrapper);
      if (success) {
        queryHandled = true;
      }
    }

    if (!queryHandled && queryCategory === 'complex') {
      // Last resort Grok fallback if Gemini fails on complex
      this.logger.warn('Gemini failed. Trying Grok as fallback...');
      const successGrok = await this.callGrokChatStream(systemInstruction, contents, chunkWrapper);
      if (successGrok) {
        queryHandled = true;
      }
    }

    if (!queryHandled) {
      onChunk(`Sorry, there was an error processing your request. Please check your credentials or try again.`);
    } else {
      // If cached conditions are met, save output to cache store
      if (!isConversationalHistory && (queryCategory === 'easy' || queryCategory === 'medium')) {
        await this.cacheManager.set(chatbotCacheKey, accumulatedResponse, 86400000); // 24 hours TTL
      }
    }

    // Stream refresh payload at the very end of the chunks if structural parameters updated
    if (detectedUpdates) {
      onChunk(`__JSON__:${JSON.stringify({ text: '', refresh: true, updates: detectedUpdates })}`);
    }

    onComplete();
  }

  private classifyQuery(q: string): 'easy' | 'medium' | 'complex' {
    const lq = q.toLowerCase();

    // Easy keywords
    const easyKeywords = [
      'visa', 'passport', 'entry requirement', 'document', 'schengen', 'etias',
      'currency', 'money', 'cash', 'atm', 'exchange', 'euro', 'dollar', 'rupee', 'yen', 'pound',
      'transport', 'transit', 'metro', 'subway', 'bus', 'train', 'taxi', 'uber', 'navigo', 'omny', 'card',
      'weather', 'temperature', 'rain', 'season', 'climate',
      'plug', 'electricity', 'voltage', 'adapter', 'socket',
      'time zone', 'timezone', 'language', 'speak', 'fact', 'population', 'emergency'
    ];

    // Medium keywords
    const mediumKeywords = [
      'restaurant', 'food', 'eat', 'dinner', 'lunch', 'breakfast', 'cafe', 'bistro', 'bar', 'cuisine', 'dish',
      'pack', 'wear', 'clothing', 'shoes', 'jacket', 'outfit',
      'attraction', 'sight', 'museum', 'landmark', 'park', 'monument', 'activity', 'thing to do', 'tourist spot',
      'tip', 'hack', 'saving', 'cheap', 'budget-saving', 'recommend', 'suggest', 'near', 'hotel description', 'explain hotel'
    ];

    // Complex keywords
    const complexKeywords = [
      'itinerary', 'rebuild', 'schedule', 'day-by-day', 'optimize', 'plan', 'budget planner',
      'change my trip', 'modify trip', 'customize', 'personalize'
    ];

    for (const kw of complexKeywords) {
      if (lq.includes(kw)) return 'complex';
    }

    for (const kw of easyKeywords) {
      if (lq.includes(kw)) return 'easy';
    }

    for (const kw of mediumKeywords) {
      if (lq.includes(kw)) return 'medium';
    }

    return 'medium'; // Default
  }

  private async streamString(text: string, onChunk: (text: string) => void) {
    const words = text.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      onChunk(words.slice(i, i + 3).join(' ') + ' ');
      await new Promise(r => setTimeout(r, 20));
    }
  }

  private extractSection(combined: string, section: 'summary' | 'itinerary'): string {
    const startTag = `---${section.toUpperCase()}_START---`;
    const endTag = `---${section.toUpperCase()}_END---`;
    const startIdx = combined.indexOf(startTag);
    const endIdx = combined.indexOf(endTag);
    if (startIdx === -1 || endIdx === -1) return '';
    
    let baseContent = combined.substring(startIdx + startTag.length, endIdx).trim();
    
    if (section === 'summary') {
      const tips = this.extractSectionRaw(combined, 'travel_tips');
      const budget = this.extractSectionRaw(combined, 'budget_breakdown');
      if (tips) baseContent += `\n\n## Travel Advice & Tips\n${tips}`;
      if (budget) baseContent += `\n\n## Estimated Budget Breakdown\n${budget}`;
    }
    
    return baseContent;
  }

  private extractSectionRaw(combined: string, section: string): string {
    const startTag = `---${section.toUpperCase()}_START---`;
    const endTag = `---${section.toUpperCase()}_END---`;
    const startIdx = combined.indexOf(startTag);
    const endIdx = combined.indexOf(endTag);
    if (startIdx === -1 || endIdx === -1) return '';
    return combined.substring(startIdx + startTag.length, endIdx).trim();
  }

  private async callCombinedPlanGenerationStream(trip: any, context: string, onChunk: (text: string) => void): Promise<string> {
    const prompt = `You are JetSet.AI, a premium travel companion. Generate a comprehensive travel plan for a trip to ${trip.destination}.

Trip Parameters:
- Origin: ${trip.origin || 'Unknown'}
- Destination: ${trip.destination}
- Dates: From ${trip.fromDate} to ${trip.toDate}
- Budget Tier: ${trip.budget}
- Travelers: ${trip.companions}
- Selected Interests: ${trip.interests?.join(', ') || 'General travel'}
- Currency: ${trip.currency || 'USD'}

RAG Travel Context for ${trip.destination}:
${context}

Generate the response in the exact format shown below, using the delimiters. Do not include markdown code blocks around the entire output.
CRITICAL CONSTRAINT: Never mention system/AI terminology, internal databases, information limitations, or 'RAG' / 'context documents'. Behave strictly as a native, expert travel guide who has direct and complete knowledge of ${trip.destination}. Speak to the user directly without reference to the backend processing or source boundaries.

---SUMMARY_START---
Generate a structured, engaging 3-5 paragraph trip narrative summary. Include local highlights, culture, and packing advice. Do not include a title.
---SUMMARY_END---

---ITINERARY_START---
Generate a detailed day-by-day travel itinerary. Use the format:
Day 1: Arrival & Exploration
- Activity or tip
- Activity or tip

Day 2: ...
- ...
---ITINERARY_END---

---TRAVEL_TIPS_START---
Provide key travel advice, safety tips, scams to avoid, and transport options.
---TRAVEL_TIPS_END---

---BUDGET_BREAKDOWN_START---
Provide estimated budget breakdown details.
---BUDGET_BREAKDOWN_END---`;

    let fullResponse = '';
    const wrapper = (chunk: string) => { fullResponse += chunk; onChunk(chunk); };
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];

    let ok = false;
    if (this.hasGrokKey) {
      this.logger.log('Streaming combined plan generation using Grok/Groq...');
      ok = await this.callGrokChatStream('You are JetSet.AI, a comprehensive AI travel planner.', contents, wrapper);
    }
    if (!ok) {
      this.logger.log('Streaming combined plan generation using Gemini fallback...');
      ok = await this.callGeminiChatStream('You are JetSet.AI, a comprehensive AI travel planner.', contents, wrapper);
    }

    if (!ok) {
      this.logger.error('callCombinedPlanGenerationStream: All AI streaming options failed');
      throw new Error('AI stream generation failed for combined plan');
    }
    return fullResponse;
  }

  private async callSeasonGuideGenerationStream(destination: string, onChunk: (text: string) => void): Promise<string> {
    const prompt = `Provide the absolute best month or months to visit ${destination}.
Keep it clean, engaging, and informative but concise.

Format your response exactly as:
## Best Months to Visit
- **[Month 3-letter code]**: Provide a detailed 2-3 sentence explanation covering what makes this month special. Include details about specific weather ranges, crowd expectations (e.g., peak vs. manageable), and any notable local events, blooms, or seasonal activities.
- **[Month 3-letter code]**: Provide a detailed 2-3 sentence explanation covering weather, crowds, and local highlights.

## Why
A short paragraph (3-4 sentences) summarizing why these months are the sweet spot for ${destination} compared to other times of the year (e.g., avoiding summer heat waves, high peak prices, or winter closures).

Do not write a massive month-by-month table or huge essays. Keep the entire response under 200 words.`;

    let fullResponse = '';
    const wrapper = (chunk: string) => { fullResponse += chunk; onChunk(chunk); };
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    
    // Call Groq (Llama 3.3) for blazing fast initial generation
    let success = await this.callGrokChatStream('You are an expert travel guide who gives high-impact, engaging and concise seasonal travel advice.', contents, wrapper);
    if (!success) {
      success = await this.callGeminiChatStream('You are an expert travel guide who gives high-impact, engaging and concise seasonal travel advice.', contents, wrapper);
    }
    if (!success) {
      const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
      const grokKey = this.configService.get<string>('GROK_API_KEY');
      let reason = 'The AI model quota limits have been temporarily exceeded or the API services returned a rate limit error (429).';
      if (!geminiKey && !grokKey) {
        reason = 'Both GEMINI_API_KEY and GROK_API_KEY are missing from the backend configuration.';
      }
      const apology = `
## 📅 Seasonal Guide Unavailable

We are sincerely sorry, but our seasonal AI advisor is temporarily offline.
**Reason:** ${reason}

* **For Developers:** Please check that your \`GEMINI_API_KEY\` or \`GROK_API_KEY\` is configured and active in your backend settings.
* **For Travelers:** Please try checking back later or explore another destination tab!
`;
      onChunk(apology);
      return apology;
    }
    return fullResponse;
  }

  private async callGrokChatStream(system: string, contents: any[], onChunk: (text: string) => void): Promise<boolean> {
    if (!this.hasGrokKey || this.isGrokCircuitOpen()) return false;
    try {
      const config = this.getGrokConfig();

      // Hard connection timeout — if Grok doesn't respond within limit, fall back immediately
      const controller = new AbortController();
      const connectionTimer = setTimeout(() => controller.abort(), this.AI_REQUEST_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(config.url, {
          method: 'POST',
          headers: config.headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            stream: true,
            messages: [
              { role: 'system', content: system },
              ...contents.map(c => ({ role: c.role, content: c.parts?.[0]?.text || c.content || '' }))
            ]
          })
        });
      } finally {
        clearTimeout(connectionTimer);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.tripGrokCircuit(`stream status ${res.status}: ${errText.slice(0, 100)}`);
        return false;
      }
      if (!res.body) {
        this.tripGrokCircuit('stream body was null');
        return false;
      }

      const bodyAny = res.body as any;
      const reader = bodyAny.getReader ? bodyAny.getReader() : bodyAny;
      const decoder = new TextDecoder();
      let buffer = '';

      if (typeof reader.read !== 'function') {
        for await (const chunk of reader) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) this.parseGrokSseLine(line, onChunk);
        }
      } else {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) this.parseGrokSseLine(line, onChunk);
        }
      }
      return true;
    } catch (err: any) {
      this.tripGrokCircuit(err.message);
      this.logger.error(`Grok stream error: ${err.message} — falling back to Gemini`);
      return false;
    }
  }

  private parseGrokSseLine(line: string, onChunk: (text: string) => void) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ')) {
      const dataStr = trimmed.slice(6).trim();
      if (dataStr === '[DONE]') return;
      try {
        const parsed = JSON.parse(dataStr);
        const text = parsed.choices?.[0]?.delta?.content;
        if (text) onChunk(text);
      } catch {}
    }
  }
  private async callGeminiChatStream(system: string, contents: any[], onChunk: (text: string) => void): Promise<boolean> {
    if (!this.hasApiKey) {
      this.logger.warn('callGeminiChatStream: No GEMINI_API_KEY configured');
      return false;
    }
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');

    // Normalize contents: support both {role,content} (OpenAI style) and {role,parts} (Gemini style)
    const normalizedContents = contents.map(c => ({
      role: c.role === 'model' ? 'model' : 'user',
      parts: c.parts ? c.parts : [{ text: c.content || '' }]
    }));

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
        const body = JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: normalizedContents,
        });
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          this.logger.warn(`Gemini model ${model} returned ${res.status}: ${errText.slice(0, 200)}`);
          if (res.status === 429 || res.status === 503) continue; // retry with next model
          return false;
        }
        await this.consumeSseStream(res.body, onChunk);
        return true;
      } catch (err: any) {
        this.logger.error(`callGeminiChatStream error with model ${model}: ${err.message}`);
        continue;
      }
    }
    return false;
  }
  private async consumeSseStream(body: any, onChunk: (text: string) => void) {
    if (!body) return;
    const reader = body.getReader ? body.getReader() : body;
    const decoder = new TextDecoder();
    let buffer = '';

    const parseLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === '[DONE]') return;
        try {
          const parsed = JSON.parse(dataStr);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
        } catch {}
      }
    };

    if (typeof reader.read !== 'function') {
      for await (const chunk of reader) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          parseLine(line);
        }
      }
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          parseLine(line);
        }
      }
    }
  }

  private async streamMockSummary(trip: any, context: string, onChunk: (text: string) => void, onComplete: () => void) {
    const mockSummary = `
### Welcome to your blueprint for **${trip.destination}**!

You are embarking on a **${trip.budget}** trip from **${trip.origin}** as a **${trip.companions}**. We have aggregated travel guides matching your interests in **${trip.interests.join(', ')}** to customize this adventure.

#### 📍 Local Highlights & Insights
Based on our guide context, if you are visiting, make sure to explore the primary landmarks (like the Eiffel Tower or Senso-ji Temple) and purchase public transit passes.

#### 💡 Expert Tips (Powered by Google Gemini)
* **Transport:** Save money by acquiring local multi-ride tickets or tapping card readers (e.g. OMNY / Navigo passes).
* **Safety:** Exercise normal vigilance against pickpockets in crowded tourist spots.
* **Dining:** Eat like a local by trying lunch sets or local convenience store snacks to keep food costs reasonable.

*We look forward to helping you refine your itinerary in the chat below!*
    `;

    const words = mockSummary.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, i + 3).join(' ') + ' ';
      onChunk(chunk);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    onComplete();
  }

  async analyzeFlights(flights: any[], trip: any): Promise<any[]> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey || apiKey.trim() === '') {
      this.logger.warn('No GEMINI_API_KEY. Using heuristic flight recommendations.');
      return this.heuristicAnalyzeFlights(flights, trip);
    }

    try {
      const prompt = `
You are JetSet.AI, an expert travel optimization system.
You are given:
1. Trip profile for the traveler:
   - Origin: ${trip.origin}
   - Destination: ${trip.destination}
   - Dates: From ${trip.fromDate} to ${trip.toDate} (Stay duration: ${this.calculateStayDays(trip.fromDate, trip.toDate)} days)
   - Budget Tier: ${trip.budget}
   - Companions: ${trip.companions}
   - Interests: ${trip.interests?.join(', ') || 'General travel'}

2. A list of flights:
${JSON.stringify(flights.map(f => ({
  id: f.id,
  flightNumber: f.flightNumber,
  airlineName: f.airlineName,
  duration: f.itineraries?.[0]?.duration || '',
  stops: (f.itineraries?.[0]?.segments?.length || 1) - 1,
  price: `${f.price?.currency} ${f.price?.total || 'Check price'}`,
  departureTime: f.itineraries?.[0]?.segments?.[0]?.departure?.at || '',
  arrivalTime: f.itineraries?.[0]?.segments?.[f.itineraries?.[0]?.segments?.length - 1]?.arrival?.at || ''
})), null, 2)}

Task:
Analyze each flight and evaluate how well it fits the traveler's itinerary and preferences (stay duration, budget tier, companion, travel time, arrival time, convenience, interests):
- A shorter trip stay (e.g. 1-3 days) needs faster/more direct flights to maximize time.
- Interests like "culture" or "sightseeing" benefit from flights arriving in the morning or early afternoon so they can utilize the first day.
- A "budget" or "mid-range" traveler values cheaper flights.
- A traveler with companions (e.g. family, kids, couple) might prefer fewer stops/shorter layovers/more convenient timings.

For EACH flight ID in the input list, generate:
1. An AI match score between 0 and 100 representing how suitable this flight is.
2. A brief, personalized 1-2 sentence recommendation reason explanation highlighting specific reasons related to the trip parameters (e.g. "Perfect for your short 3-day stay as it is direct and lands at 9 AM, giving you a full first day for Culture sights"). Do not mention code details. Refer to the traveler in second person.

Output your answer in raw JSON format matching this schema. Do not output any markdown code blocks or wrapping. Just the JSON:
{
  "analyses": [
    {
      "id": "flight-id-here",
      "score": 95,
      "reason": "explanation text here"
    }
  ]
}
`;

      const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];
      let resultText = '';
      for (const model of geminiModels) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (res.ok) {
          const resData = await res.json();
          resultText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (resultText) break;
        }
        this.logger.warn(`Model ${model} failed for flight analysis, trying next...`);
      }

      if (!resultText) {
        throw new Error('No content returned from Gemini');
      }

      const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      return parsed.analyses;

    } catch (e: any) {
      this.logger.error(`Failed to analyze flights with Gemini: ${e.message}. Using heuristic fallback.`);
      return this.heuristicAnalyzeFlights(flights, trip);
    }
  }

  private calculateStayDays(from: string, to: string): number {
    try {
      const d1 = new Date(from);
      const d2 = new Date(to);
      const diff = d2.getTime() - d1.getTime();
      return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    } catch {
      return 3;
    }
  }

  private heuristicAnalyzeFlights(flights: any[], trip: any): any[] {
    const budget = (trip.budget || '').toLowerCase();
    const stayDays = this.calculateStayDays(trip.fromDate, trip.toDate);
    
    return flights.map(f => {
      const price = parseFloat(f.price?.total || '500');
      const segments = f.itineraries?.[0]?.segments || [];
      const stops = segments.length - 1;
      const durationStr = f.itineraries?.[0]?.duration || 'PT0H0M';
      const durationMin = this.parseIsoDuration(durationStr);
      
      let score = 80;
      let reasons: string[] = [];

      if (budget.includes('budget') && price < 450) {
        score += 15;
        reasons.push('Great budget-friendly option for your trip');
      } else if (budget.includes('luxury') && stops === 0) {
        score += 15;
        reasons.push('Direct flights offer maximum comfort');
      }

      if (stayDays <= 3) {
        if (stops === 0) {
          score += 10;
          reasons.push('Saves valuable time for your short stay');
        } else {
          score -= 10;
          reasons.push('Connecting flight takes up a bit of time on a short stay');
        }
      }

      const depTimeStr = segments[0]?.departure?.at || '';
      if (depTimeStr) {
        const hour = new Date(depTimeStr).getHours();
        if (hour >= 6 && hour <= 11) {
          score += 5;
          reasons.push('Convenient morning departure maximizes your first day');
        }
      }

      score = Math.max(10, Math.min(100, score));
      const reason = reasons.join(', and ') || 'Good schedule fitting standard travel guidelines';

      return {
        id: f.id,
        score,
        reason: `${reason}.`
      };
    });
  }

  private parseIsoDuration(dur: string): number {
    if (!dur) return 0;
    const timeStr = dur.replace('PT', '');
    let hours = 0, mins = 0;
    const hMatch = timeStr.match(/(\d+)H/);
    const mMatch = timeStr.match(/(\d+)M/);
    if (hMatch) hours = parseInt(hMatch[1]);
    if (mMatch) mins = parseInt(mMatch[1]);
    return hours * 60 + mins;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Smart Flight Leg Extraction (Gemini AI — determines flyable legs only)
  // ─────────────────────────────────────────────────────────────────────────────

  async extractFlightLegs(trip: {
    origin: string;
    destination: string;
    fromDate: string;
    toDate: string;
    budget?: string;
    companions?: string;
    currency?: string;
    combinedPlan?: string | null;
  }): Promise<FlightLegsDto> {
    const itineraryText = trip.combinedPlan
      ? this.extractSection(trip.combinedPlan, 'itinerary')
      : '';

    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
    const grokKey = this.configService.get<string>('GROK_API_KEY');
    const hasKey = (geminiKey && geminiKey.trim() !== '') || (grokKey && grokKey.trim() !== '');

    if (hasKey) {
      try {
        const result = await this.geminiExtractFlightLegs(trip, itineraryText);
        if (result) return result;
      } catch (e: any) {
        this.logger.warn(`Flight leg extraction failed: ${e.message}. Using fallback.`);
      }
    }

    // Fallback: simple direct + return
    return this.fallbackFlightLegs(trip);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Destination Warning Checking (Sensitive Areas / Off-Season Check)
  // ─────────────────────────────────────────────────────────────────────────────

  async checkDestinationWarning(trip: {
    destination: string;
    fromDate: string;
    toDate: string;
  }): Promise<DestinationWarningDto> {
    const cacheKey = `warning_${trip.destination.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${trip.fromDate}`;
    try {
      const cached = await this.cacheManager.get(cacheKey) as DestinationWarningDto;
      if (cached) return cached;
    } catch {}

    try {
      const prompt = `You are JetSet.AI's travel safety advisor.
Evaluate the following trip details:
- Destination: "${trip.destination}"
- Travel dates: From "${trip.fromDate}" to "${trip.toDate}"

Evaluate:
1. SENSITIVE / RESTRICTED AREA: Is this destination a highly sensitive, restricted-access, or protected area requiring special government permits, visa approvals, military passes, or official tour operators to enter? (Examples: Tibet/Kailash Mansarovar, Antarctica, Bhutan, Svalbard, North Korea, Galapagos Islands, restricted parts of Ladakh/Leh, etc.)
2. OFF-SEASON / CLOSED ROUTE: Will the trip dates fall during the off-season, monsoon, extreme weather season, or winter closure where routes, hotels, or access are likely closed, dangerous, or heavily restricted? (Examples: Kailash outside May-Sept, Svalbard in winter, Antarctica outside Nov-March, heavy monsoon in Kerala/Himalayas, extreme 50°C summer in Middle East deserts, etc.)

Output ONLY a raw JSON object matching this schema (no markdown formatting, no explanations):
{
  "isSensitive": true or false,
  "isOffSeason": true or false,
  "warningTitle": "A concise title (e.g. 'Restricted Border Permit Required' or 'Extreme Monsoon Season' or null if both false)",
  "warningMessage": "A clear, helpful warning description explaining the access rules, permits, tour group requirements, or weather hazards, advising the user to book through authorized government/private agencies. Null if both false."
}
`;

      const text = await this.callModelWithFallback(
        prompt,
        "You are JetSet.AI's travel safety advisor.",
        true
      );
      const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed: DestinationWarningDto = JSON.parse(clean);

      try {
        await this.cacheManager.set(cacheKey, parsed, 86400000); // 24 hours
      } catch {}

      return parsed;
    } catch (e: any) {
      this.logger.error(`Error checking destination warning: ${e.message}`);
    }

    return { isSensitive: false, isOffSeason: false, warningTitle: null, warningMessage: null };
  }

  private async geminiExtractFlightLegs(
    trip: { origin: string; destination: string; fromDate: string; toDate: string; budget?: string; companions?: string; currency?: string },
    itineraryText: string,
  ): Promise<FlightLegsDto | null> {
    const budgetRaw = (trip.budget || 'mid-range').toLowerCase();
    const companionsRaw = (trip.companions || 'solo').toLowerCase();
    const currencyCode = (trip.currency  || 'USD').toUpperCase();

    const isLuxury     = budgetRaw.includes('luxury') || budgetRaw.includes('premium') || budgetRaw.includes('high');
    const isBudget     = budgetRaw.includes('budget') || budgetRaw.includes('low') || budgetRaw.includes('backpack');
    const isMidRange   = !isLuxury && !isBudget;

    // Country-relative purchasing power note for AI
    const purchasingPowerNote = (() => {
      if (['INR','NPR','BDT','PKR','LKR'].includes(currencyCode)) {
        if (isLuxury)   return 'Traveller has a high/luxury budget. Helicopter/chartered flights/domestic planes are allowed for remote connections if they save time.';
        if (isMidRange) return 'Traveller has a moderate/mid-range/middle-class budget. Strictly avoid small domestic flights, charters, or helicopters. Only fly to the main international/national gateway airport (e.g. Kathmandu, KTM). All remote regional connections must be by ground/road/vehicle.';
        if (isBudget)   return 'Traveller has a budget/backpack budget. Economy flight to the main gateway only. All onward transit by bus/road.';
      }
      if (['USD','GBP','EUR','AUD','CAD','JPY','SGD','AED'].includes(currencyCode)) {
        if (isLuxury)   return 'Traveller has a high/luxury budget. Helicopters or charters are suitable for remote regions.';
        if (isMidRange) return 'Traveller has a moderate/mid-range budget. Strictly avoid helicopters, private charters, or regional small aircraft. Only fly to the main gateway. Onward travel is by road/vehicle.';
        if (isBudget)   return 'Traveller has a budget tier. Fly only to the main gateway. Rest of travel is by road/bus.';
      }
      return `Traveller budget: ${trip.budget}. Adjust transport recommendations accordingly.`;
    })();

    const transportByBudget = isLuxury
      ? `LUXURY/HIGH BUDGET RULES:
- Helicopter or domestic small aircraft connecting flights are allowed for remote routes if they save time or enhance convenience (e.g. Kathmandu→Lukla, Nepalgunj→Simikot).
- Standard commercial airline flights for main transit.`
      : `MODERATE & BUDGET RULES (VERY IMPORTANT):
- ONLY plan commercial airline flights to the main gateway airport (e.g. Kathmandu KTM for Kailash, Delhi DEL for North India).
- STRICTLY avoid any secondary/regional flights, small aircraft flights, private charters, or helicopters (e.g. do NOT plan Nepalgunj→Simikot flights or Kathmandu→Lukla flights).
- All onward travel from the gateway airport must be designated as ground/vehicle transit and excluded from the flight legs.
- Keep flight segments to the absolute minimum necessary to reach the country/major city gateway.`;


    const prompt = `You are JetSet.AI's expert flight planning agent. Your job is to determine ONLY the commercially bookable flight segments for a trip, taking into account the traveller's budget.

Trip Details:
- Origin: "${trip.origin}"
- Destination: "${trip.destination}"
- Departure Date: "${trip.fromDate}"
- Return Date: "${trip.toDate}"
- Budget Tier: "${trip.budget || 'Mid-range'}"
- Companions: "${trip.companions || 'Solo'}"
- Currency: "${currencyCode}"

Budget Context: ${purchasingPowerNote}

${transportByBudget}

${itineraryText ? `Itinerary:\n${itineraryText}\n` : ''}

Your task:
1. Identify the MAIN GATEWAY airport the traveller flies to commercially (e.g., for "Kailash Mansarovar" → Kathmandu KTM is the gateway. Simikot/Taklakot have NO commercial airline flights).
2. Check if a direct commercial flight exists from origin to gateway. If NOT, add HUB city legs (e.g., Bhubaneswar→Delhi→Kathmandu).
3. Based on the BUDGET RULES above, decide if any additional transport legs (helicopter, small charter, domestic aircraft) should be included as separate legs.
4. Build OUTBOUND legs (commercial/charter hops only), then RETURN legs (reverse route, on toDate).
5. List all remaining non-bookable segments (road/trek/walk) in groundSegments.

Knowledge base:
- Routes with NO commercial scheduled service: Simikot→Hilsa, Hilsa→Taklakot, Taklakot→Darchen, Darchen→Kailash Parikrama
- Domestic small-aircraft routes (exist but weather-dependent): Nepalgunj↔Simikot (KEP↔IMK), Kathmandu↔Lukla (KTM↔LUA)
- Helicopter routes (luxury/charter only): Kathmandu→Everest Base Camp, Nepalgunj→Simikot, scenic Himalayan
- No commercial airport: Kailash Mansarovar itself, Taklakot road access from Tibet side

Output ONLY valid JSON (no markdown, no explanation):
{
  "gateway": "Main flyable hub city",
  "gatewayIata": "IATA",
  "outbound": [
    { "legNum": 1, "from": "City", "fromIata": "XXX", "to": "City", "toIata": "YYY", "date": "YYYY-MM-DD", "note": "e.g. Hub connection / Helicopter charter / Domestic aircraft" }
  ],
  "return": [
    { "legNum": 2, "from": "City", "fromIata": "YYY", "to": "City", "toIata": "XXX", "date": "YYYY-MM-DD", "note": "reason" }
  ],
  "groundSegments": ["e.g. Simikot → Hilsa (jeep/trek, 2-3 days)", "Hilsa → Kailash (road + trek)"]
}

Rules:
- legNum sequential across outbound+return
- Dates: all outbound use fromDate, all return use toDate
- Hub routing = 2 outbound + 2 return legs
- Direct = 1 outbound + 1 return
- Helicopter leg: include ONLY if budget is luxury AND a helicopter route genuinely exists
- fromIata/toIata must be real IATA codes
- groundSegments max 5 items with travel mode and estimated time
`;

    try {
      const text = await this.callModelWithFallback(
        prompt,
        "You are JetSet.AI's expert flight planning agent.",
        true
      );
      const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed: FlightLegsDto = JSON.parse(clean);
      if (parsed?.outbound?.length) {
        this.logger.log(`Flight legs extracted [budget=${trip.budget}]: gateway=${parsed.gateway}, outbound=${parsed.outbound.length} legs, ground=${parsed.groundSegments?.length}`);
        return parsed;
      }
    } catch (e: any) {
      this.logger.error(`Error extracting flight legs: ${e.message}`);
    }
    return null;
  }

  private fallbackFlightLegs(trip: { origin: string; destination: string; fromDate: string; toDate: string }): FlightLegsDto {
    // Simple direct + return fallback using static IATA mapping
    const STATIC: Record<string, string> = {
      'bhubaneswar': 'BBI', 'bhubaneshwar': 'BBI', 'cuttack': 'BBI',
      'delhi': 'DEL', 'new delhi': 'DEL', 'mumbai': 'BOM', 'kolkata': 'CCU',
      'kathmandu': 'KTM', 'nepal': 'KTM', 'kailash': 'KTM', 'kailash mansarovar': 'KTM',
      'london': 'LHR', 'paris': 'CDG', 'dubai': 'DXB', 'singapore': 'SIN',
      'sydney': 'SYD', 'tokyo': 'HND', 'bangkok': 'BKK', 'new york': 'JFK',
    };
    const code = (s: string) => {
      const l = s.toLowerCase();
      for (const [k, v] of Object.entries(STATIC)) if (l.includes(k)) return v;
      return s.substring(0, 3).toUpperCase();
    };

    const orgIata  = code(trip.origin);
    const destIata = code(trip.destination);
    const orgCity  = trip.origin.split(',')[0].trim();
    const destCity = trip.destination.split(',')[0].trim();

    return {
      gateway: destCity,
      gatewayIata: destIata,
      outbound: [{ legNum: 1, from: orgCity,  fromIata: orgIata,  to: destCity, toIata: destIata, date: trip.fromDate, note: 'Direct flight' }],
      return:   [{ legNum: 2, from: destCity, fromIata: destIata, to: orgCity,  toIata: orgIata,  date: trip.toDate,   note: 'Return flight' }],
      groundSegments: [],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Itinerary Stop Extraction (Gemini-powered, regex fallback)
  // ─────────────────────────────────────────────────────────────────────────────


  async extractItineraryStops(
    combinedPlan: string,
    fromDate: string,
    toDate: string,
    destination: string,
  ): Promise<ItineraryStopDto[]> {
    const itineraryText = this.extractSection(combinedPlan, 'itinerary');
    if (!itineraryText) {
      return this.buildFallbackStop(destination, fromDate, toDate);
    }

    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (apiKey && apiKey.trim() !== '') {
      try {
        const result = await this.geminiExtractStops(itineraryText, fromDate, destination, apiKey);
        if (result && result.length > 0) return result;
      } catch (e: any) {
        this.logger.warn(`Gemini stop extraction failed: ${e.message}. Using regex fallback.`);
      }
    }

    // Regex fallback
    return this.regexExtractStops(itineraryText, fromDate, toDate, destination);
  }

  private async geminiExtractStops(
    itineraryText: string,
    fromDate: string,
    destination: string,
    apiKey: string,
  ): Promise<ItineraryStopDto[]> {
    const prompt = `You are a travel itinerary parser. Given the following day-by-day travel itinerary, extract each UNIQUE city/destination where the traveller will STAY OVERNIGHT (i.e., needs a hotel). Group consecutive days in the same city.

Trip start date: ${fromDate}
Overall destination: ${destination}

Itinerary:
${itineraryText}

Return a JSON array (no markdown, no explanation) of objects with this schema:
[
  { "city": "City Name", "dayStart": 1, "dayEnd": 2 },
  { "city": "Another City", "dayStart": 3, "dayEnd": 5 }
]

Rules:
- Only include cities where the traveller actually SLEEPS (needs a hotel/guesthouse). Exclude transit-only stops.
- "city" must be the real geographic city/town name — NOT words like "Arrival", "Departure", "Leisure", "Exploration", "Rest".
- Group consecutive days spent in the same city into ONE entry.
- Day numbers refer to the trip day (Day 1 = first day of trip).
- If a day says "Return to X" or "Back to X", that city is still a valid stop.
- If unsure about exact city, use the nearest well-known city.
`;

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];
    for (const model of models) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed: Array<{ city: string; dayStart: number; dayEnd: number }> = JSON.parse(clean);
      if (!Array.isArray(parsed) || parsed.length === 0) continue;

      return this.computeDates(parsed, fromDate);
    }
    return [];
  }

  private regexExtractStops(
    itineraryText: string,
    fromDate: string,
    toDate: string,
    destination: string,
  ): ItineraryStopDto[] {
    // Known city keywords for Himalayan and global trips
    const CITY_KEYWORDS: Record<string, string> = {
      'kathmandu': 'Kathmandu', 'ktm': 'Kathmandu',
      'pokhara': 'Pokhara', 'lhasa': 'Lhasa',
      'delhi': 'Delhi', 'new delhi': 'Delhi',
      'mumbai': 'Mumbai', 'kolkata': 'Kolkata',
      'bhubaneswar': 'Bhubaneswar', 'bhubaneshwar': 'Bhubaneswar',
      'cuttack': 'Cuttack',
      'simikot': 'Simikot', 'nepalganj': 'Nepalgunj', 'nepalgunj': 'Nepalgunj',
      'hilsa': 'Hilsa',
      'taklakot': 'Taklakot', 'purang': 'Purang',
      'darchen': 'Darchen', 'mansarovar': 'Kailash Mansarovar', 'kailash': 'Kailash Mansarovar',
      'nyalam': 'Nyalam', 'saga': 'Saga', 'shigatse': 'Shigatse',
      'london': 'London', 'paris': 'Paris', 'rome': 'Rome',
      'tokyo': 'Tokyo', 'kyoto': 'Kyoto', 'osaka': 'Osaka',
      'sydney': 'Sydney', 'melbourne': 'Melbourne', 'brisbane': 'Brisbane',
      'new york': 'New York', 'los angeles': 'Los Angeles', 'chicago': 'Chicago',
      'singapore': 'Singapore', 'bangkok': 'Bangkok', 'bali': 'Bali',
      'dubai': 'Dubai', 'abu dhabi': 'Abu Dhabi',
      'amsterdam': 'Amsterdam', 'barcelona': 'Barcelona', 'berlin': 'Berlin',
      'istanbul': 'Istanbul', 'cairo': 'Cairo',
      'leh': 'Leh', 'ladakh': 'Leh', 'srinagar': 'Srinagar',
      'manali': 'Manali', 'shimla': 'Shimla',
      'jaipur': 'Jaipur', 'agra': 'Agra', 'varanasi': 'Varanasi',
      'goa': 'Goa', 'kochi': 'Kochi', 'lucknow': 'Lucknow',
      'kuala lumpur': 'Kuala Lumpur', 'jakarta': 'Jakarta',
      'ho chi minh': 'Ho Chi Minh City', 'hanoi': 'Hanoi',
      'seoul': 'Seoul', 'beijing': 'Beijing', 'shanghai': 'Shanghai',
    };

    // INVALID non-city words that regex/Gemini might incorrectly pick up
    const INVALID_CITIES = new Set([
      'arrival', 'departure', 'leisure', 'rest', 'acclimatization', 'exploration',
      'sightseeing', 'transfer', 'transit', 'journey', 'excursion', 'day',
      'return', 'welcome', 'farewell', 'flight', 'check', 'morning', 'evening',
    ]);

    const rawDays: Array<{ day: number; city: string }> = [];

    for (const line of itineraryText.split('\n')) {
      const clean = line.trim().replace(/[*_#]/g, '');
      const match = clean.match(/^Day\s*(\d+)[:\s-]*(.*)/i);
      if (!match) continue;
      const dayNum = parseInt(match[1]);
      const header = match[2].trim();
      const lower = header.toLowerCase();

      let foundCity = '';

      // 1. Check known city keywords (longest match first)
      const sortedKeys = Object.keys(CITY_KEYWORDS).sort((a, b) => b.length - a.length);
      for (const kw of sortedKeys) {
        if (lower.includes(kw)) {
          foundCity = CITY_KEYWORDS[kw];
          break;
        }
      }

      // 2. Preposition extraction: "to X", "in X", "at X", "arrive X"
      if (!foundCity) {
        const pm = header.match(/\b(?:in|to|at|arrive(?:d)?(?:\s+in)?|reach(?:ed)?|visiting)\s+([A-Z][a-zA-Z\s]+?)(?:\s*[&(,–\-]|$)/);
        if (pm) {
          const candidate = pm[1].trim().split(/\s+/).slice(0, 3).join(' ');
          const lower2 = candidate.toLowerCase();
          if (!INVALID_CITIES.has(lower2) && candidate.length > 2) {
            foundCity = candidate;
          }
        }
      }

      // 3. Skip days without a valid city (don't fall back to generic words)
      if (!foundCity || INVALID_CITIES.has(foundCity.toLowerCase())) continue;

      rawDays.push({ day: dayNum, city: foundCity });
    }

    if (rawDays.length === 0) {
      return this.buildFallbackStop(destination, fromDate, toDate);
    }

    // Group consecutive same-city days
    const grouped: Array<{ city: string; dayStart: number; dayEnd: number }> = [];
    for (const rd of rawDays) {
      const last = grouped[grouped.length - 1];
      if (last && last.city.toLowerCase() === rd.city.toLowerCase()) {
        last.dayEnd = rd.day;
      } else {
        grouped.push({ city: rd.city, dayStart: rd.day, dayEnd: rd.day });
      }
    }

    return this.computeDates(grouped, fromDate);
  }

  private computeDates(
    stops: Array<{ city: string; dayStart: number; dayEnd: number }>,
    fromDate: string,
  ): ItineraryStopDto[] {
    const base = new Date(fromDate);
    if (isNaN(base.getTime())) {
      base.setTime(Date.now());
    }

    return stops.map(s => {
      const ci = new Date(base);
      ci.setDate(base.getDate() + s.dayStart - 1);
      const co = new Date(base);
      co.setDate(base.getDate() + s.dayEnd);

      const fmtISO = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
      };
      const fmtDisplay = (d: Date) =>
        d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

      return {
        city: s.city,
        dayStart: s.dayStart,
        dayEnd: s.dayEnd,
        checkin: fmtISO(ci),
        checkout: fmtISO(co),
        displayCheckin: fmtDisplay(ci),
        displayCheckout: fmtDisplay(co),
      };
    });
  }

  private buildFallbackStop(destination: string, fromDate: string, toDate: string): ItineraryStopDto[] {
    const ci = new Date(fromDate || Date.now());
    const co = new Date(toDate || Date.now());
    if (isNaN(co.getTime())) co.setDate(ci.getDate() + 1);

    const fmtISO = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };
    const fmtDisplay = (d: Date) =>
      d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

    return [{
      city: destination,
      dayStart: 1,
      dayEnd: 1,
      checkin: fmtISO(ci),
      checkout: fmtISO(co),
      displayCheckin: fmtDisplay(ci),
      displayCheckout: fmtDisplay(co),
    }];
  }


  async analyzeHotels(hotels: any[], trip: any): Promise<any[]> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey || apiKey.trim() === '') {
      this.logger.warn('No GEMINI_API_KEY. Using heuristic hotel recommendations.');
      return this.heuristicAnalyzeHotels(hotels, trip);
    }

    try {
      const prompt = `
You are JetSet.AI, an expert travel hotel optimization system.
You are given:
1. Trip profile for the traveler:
   - Origin: ${trip.origin}
   - Destination: ${trip.destination}
   - Dates: From ${trip.fromDate} to ${trip.toDate} (Stay duration: ${this.calculateStayDays(trip.fromDate, trip.toDate)} days)
   - Budget Tier: ${trip.budget}
   - Companions: ${trip.companions}
   - Interests: ${trip.interests?.join(', ') || 'General travel'}

2. A list of hotels:
${JSON.stringify(hotels.map(h => ({
  id: h.hotelId,
  name: h.name,
  rating: h.rating,
  price: `$${h.price} per night`,
  distance: h.distance ? `${h.distance} km` : '1.5 km'
})), null, 2)}

Task:
Analyze each hotel and evaluate how well it fits the traveler's itinerary and preferences (stay duration, budget tier, companion type, interests, review score, location/proximity):
- Companions: 
  * "Solo": prefers hostels, central apartments, social zones, close to transit stations.
  * "Couple": prefers romantic, boutique, quiet, top-rated hotels, high scores.
  * "Family": prefers spacious rooms, quiet areas, kid-friendly parks nearby, high ratings.
  * "Friends": prefers central, lively spots, nightlife.
- Interests: Match interests to hotel styles or surroundings (e.g., historical zones for "culture", food hubs for "food").
- Proximity to key places (airport, train station, city center).
- Review Score: High reviews/ratings must be prioritized.
- Price: Lower prices matching their budget are preferred.

For EACH hotel ID in the input list, generate:
1. An AI match score between 0 and 100 representing suitability. Score higher for hotels with better reviews (ratings), better value/prices, and alignment with traveler options.
2. A brief, personalized 1-2 sentence recommendation reason in second person (e.g. "Excellent for your solo trip; budget-friendly and located near the train station and cultural spots").

Output raw JSON format matching this schema. Do not output any markdown code blocks. Just the JSON:
{
  "analyses": [
    {
      "id": "hotel-id-here",
      "score": 95,
      "reason": "explanation text here"
    }
  ]
}
`;

      const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];
      let resultText = '';
      for (const model of geminiModels) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        if (res.ok) {
          const resData = await res.json();
          resultText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (resultText) break;
        }
      }

      if (!resultText) {
        throw new Error('No content returned from Gemini');
      }

      const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      return parsed.analyses;

    } catch (e: any) {
      this.logger.error(`Failed to analyze hotels with Gemini: ${e.message}. Using heuristic fallback.`);
      return this.heuristicAnalyzeHotels(hotels, trip);
    }
  }

  private heuristicAnalyzeHotels(hotels: any[], trip: any): any[] {
    const budget = ((trip?.budget as string) || '').toLowerCase();
    const companions = ((trip?.companions as string) || '').toLowerCase();
    const interests = (trip?.interests as string[]) || [];

    return hotels.map((h) => {
      const price = parseFloat(h.price || '100');
      const rating = h.rating || 8.0;
      
      // Correctly parse distance whether it is a primitive number or nested object
      const distanceVal = typeof h.distance === 'object' && h.distance !== null
        ? (h.distance.value ?? 1.5)
        : (typeof h.distance === 'number' ? h.distance : 1.5);

      let score = 40;
      let reasons: string[] = [];

      // 1. Review Rating contribution (up to 30 points) - prioritizes highest reviews
      score += Math.round(rating * 3.5);
      if (rating >= 9.0) {
        reasons.push('Exceptional guest reviews');
      } else if (rating >= 8.0) {
        reasons.push('Highly recommended guest ratings');
      }

      // 2. Budget price range suitability (up to 20 points)
      let priceScore = 0;
      if (budget.includes('budget') || budget.includes('low')) {
        if (price < 70) {
          priceScore = 20;
          reasons.push('Highly budget-friendly');
        } else if (price < 100) {
          priceScore = 15;
          reasons.push('Good value for budget stay');
        } else if (price < 150) {
          priceScore = 5;
        } else {
          priceScore = 0;
        }
      } else if (budget.includes('luxury') || budget.includes('high')) {
        if (price >= 250) {
          priceScore = 20;
          reasons.push('Premium luxury stay');
        } else if (price >= 180) {
          priceScore = 15;
          reasons.push('Great high-end comfort');
        } else if (price >= 120) {
          priceScore = 10;
        } else {
          priceScore = 2;
        }
      } else { // Moderate / Mid-Range
        if (price >= 80 && price <= 180) {
          priceScore = 20;
          reasons.push('Excellent mid-range pricing');
        } else if (price >= 60 && price <= 220) {
          priceScore = 15;
          reasons.push('Reasonably priced comfortable stay');
        } else {
          priceScore = 5;
        }
      }
      score += priceScore;

      // 3. Companion suitability (up to 15 points)
      let companionScore = 0;
      if (companions.includes('solo')) {
        if (h.name.toLowerCase().includes('hostel') || h.name.toLowerCase().includes('dorm')) {
          companionScore = 15;
          reasons.push('Ideal social hostel atmosphere for solo travelers');
        } else if (distanceVal < 2.0) {
          companionScore = 10;
          reasons.push('Central location keeps you close to transit and walking spots');
        }
      } else if (companions.includes('family')) {
        if (h.name.toLowerCase().includes('resort') || h.name.toLowerCase().includes('apart') || rating >= 8.5) {
          companionScore = 15;
          reasons.push('Spacious stay highly rated for family comfort');
        }
      } else if (companions.includes('couple')) {
        if (h.name.toLowerCase().includes('boutique') || h.name.toLowerCase().includes('plaza') || rating >= 8.5) {
          companionScore = 15;
          reasons.push('Perfect romantic setting with excellent ratings');
        }
      } else if (companions.includes('friends')) {
        if (distanceVal < 2.5) {
          companionScore = 10;
          reasons.push('Great central spot for exploring with friends');
        }
      }
      score += companionScore;

      // 4. Interests (Culture, Nature, Food, etc. up to 10 points)
      let interestScore = 0;
      const matchedInterests = interests.filter(interest => {
        const lowerInterest = interest.toLowerCase();
        if (lowerInterest.includes('nature') && (h.name.toLowerCase().includes('park') || h.name.toLowerCase().includes('lake') || h.name.toLowerCase().includes('oasis') || h.name.toLowerCase().includes('resort'))) return true;
        if (lowerInterest.includes('culture') && (h.name.toLowerCase().includes('plaza') || h.name.toLowerCase().includes('palace') || h.name.toLowerCase().includes('chateau') || h.name.toLowerCase().includes('grand'))) return true;
        if (lowerInterest.includes('shopping') && (h.name.toLowerCase().includes('center') || h.name.toLowerCase().includes('city') || h.name.toLowerCase().includes('mall'))) return true;
        if (lowerInterest.includes('food') && (h.name.toLowerCase().includes('kitchen') || h.name.toLowerCase().includes('bistro') || h.name.toLowerCase().includes('dining'))) return true;
        return false;
      });
      if (matchedInterests.length > 0) {
        interestScore = 10;
        reasons.push(`Suits interest in ${matchedInterests[0]}`);
      }
      score += interestScore;

      score = Math.max(10, Math.min(100, score));
      const reason = reasons.join(', ') || 'Matches search options and parameters';

      return {
        id: h.hotelId,
        score,
        reason: `${reason}.`
      };
    });
  }

  async explainHotelsWithGrok(topHotels: any[], trip: any): Promise<Record<string, { score: number; reason: string }>> {
    const grokKey = this.configService.get<string>('GROK_API_KEY');
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
    
    const prompt = `
You are JetSet.AI, an expert travel hotel optimization system.
The traveler has the following profile:
- Origin: ${trip.origin}
- Destination: ${trip.destination}
- Budget Tier: ${trip.budget}
- Travelers/Companions: ${trip.companions}
- Selected Interests: ${trip.interests?.join(', ') || 'General travel'}

We have selected the following top 3 hotels for them:
${JSON.stringify(topHotels.map(h => ({
  id: h.hotelId,
  name: h.name,
  rating: h.rating,
  price: `$${h.price} per night`,
  distance: h.distance ? `${h.distance} km` : '1.5 km'
})), null, 2)}

Task:
Analyze each hotel using the FOLLOWING PRIORITY ORDER — do NOT rank primarily on review ratings alone:
1. BUDGET FIT (most important, 30%): Does the price match the traveler's selected budget tier? A luxury hotel priced for budget travelers scores LOW, and vice versa. Match the tier precisely.
2. TRAVELER CONVENIENCE & COMPANIONS (25%): Does it genuinely suit the companion type? Family travelers need spacious, child-friendly resorts. Couples need romantic boutique options. Solo travelers need social/central hostels or compact hotels. Friends need proximity to nightlife/attractions.
3. SELECTED INTERESTS (20%): Does the location or hotel type align with their interests (e.g. culture, nature, adventure, food, wellness, shopping)?
4. EASE OF TRAVEL (15%): Is it conveniently located near transport links, walkable zones, or key local landmarks that reduce hassle?
5. REVIEW QUALITY (10%): High reviews are a positive bonus, but never override the above factors.

For EACH hotel, generate:
1. An AI match score between 0 and 100 based on the priority weights above (not just star rating).
2. A brief, personalized 1-2 sentence recommendation in second person that explains why it is or isn't a strong match given their profile. If it's a poor budget fit, say so clearly.

Output your answer in raw JSON format matching this schema. Do not output any markdown code blocks or wrapping. Just the JSON:
{
  "analyses": [
    {
      "id": "hotel-id-here",
      "score": 95,
      "reason": "explanation text here"
    }
  ]
}
`;

    // Try Grok first (with dynamic client routing based on key prefix)
    if (grokKey && grokKey.trim() !== '') {
      try {
        this.logger.log('Generating hotel explanations using Groq/Grok...');
        const config = this.getGrokConfig();
        const res = await fetch(config.url, {
          method: 'POST',
          headers: config.headers,
          body: JSON.stringify({
            model: config.model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'You are a professional travel planner returning strictly raw JSON.' },
              { role: 'user', content: prompt }
            ]
          })
        });

        if (res.ok) {
          const data = await res.json();
          const resultText = data.choices?.[0]?.message?.content || '';
          if (resultText) {
            const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            if (parsed.analyses) {
              const results: Record<string, { score: number; reason: string }> = {};
              for (const a of parsed.analyses) {
                results[a.id] = { score: a.score, reason: a.reason };
              }
              return results;
            }
          }
        }
      } catch (e: any) {
        this.logger.error(`Failed to generate hotel explanations with Grok: ${e.message}. Trying Gemini fallback...`);
      }
    }

    // Try Gemini fallback
    if (geminiKey && geminiKey.trim() !== '') {
      try {
        this.logger.log('Generating hotel explanations using Gemini fallback...');
        const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];
        let resultText = '';
        for (const model of geminiModels) {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          });
          if (res.ok) {
            const resData = await res.json();
            resultText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (resultText) break;
          }
        }

        if (resultText) {
          const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(cleanJson);
          if (parsed.analyses) {
            const results: Record<string, { score: number; reason: string }> = {};
            for (const a of parsed.analyses) {
              results[a.id] = { score: a.score, reason: a.reason };
            }
            return results;
          }
        }
      } catch (e: any) {
        this.logger.error(`Failed to generate hotel explanations with Gemini: ${e.message}`);
      }
    }

    const fallbackExplanations: Record<string, { score: number; reason: string }> = {};
    for (const h of topHotels) {
      fallbackExplanations[h.hotelId] = {
        score: h.matchScore || 80,
        reason: h.matchReason || 'Matches your budget and companion preferences.'
      };
    }
    return fallbackExplanations;
  }

  async analyzeFlightsWithGrok(flights: any[], trip: any): Promise<Record<string, { score: number; reason: string }>> {
    const grokKey = this.configService.get<string>('GROK_API_KEY');
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');

    const prompt = `
You are JetSet.AI, an expert travel optimization system.
The traveler has the following profile:
- Origin: ${trip.origin}
- Destination: ${trip.destination}
- Budget Tier: ${trip.budget}
- Travelers/Companions: ${trip.companions}
- Selected Interests: ${trip.interests?.join(', ') || 'General travel'}

We have the following list of flights:
${JSON.stringify(flights.map(f => ({
  id: f.id,
  flightNumber: f.flightNumber,
  airlineName: f.airlineName,
  duration: f.itineraries?.[0]?.duration || '',
  stops: (f.itineraries?.[0]?.segments?.length || 1) - 1,
  price: `${f.price?.currency || 'USD'} ${f.price?.total || 'Check price'}`,
  departureTime: f.itineraries?.[0]?.segments?.[0]?.departure?.at || ''
})), null, 2)}

Task:
Analyze each flight and evaluate how well it fits the traveler's itinerary and preferences (stay duration, budget tier, companion, travel time, arrival time, convenience, interests).
For EACH flight, generate:
1. An AI match score between 0 and 100 representing how suitable this flight is.
2. A brief, personalized 1-2 sentence recommendation reason explanation highlighting specific reasons related to the trip parameters (refer to the traveler in second person).

Output your answer in raw JSON format matching this schema. Do not output any markdown code blocks or wrapping. Just the JSON:
{
  "analyses": [
    {
      "id": "flight-id-here",
      "score": 95,
      "reason": "explanation text here"
    }
  ]
}
`;

    // Try Grok first
    if (grokKey && grokKey.trim() !== '') {
      try {
        this.logger.log('Analyzing flights using Grok...');
        const config = this.getGrokConfig();
        const res = await fetch(config.url, {
          method: 'POST',
          headers: config.headers,
          body: JSON.stringify({
            model: config.model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'You are a professional travel planner returning strictly raw JSON.' },
              { role: 'user', content: prompt }
            ]
          })
        });

        if (res.ok) {
          const data = await res.json();
          const resultText = data.choices?.[0]?.message?.content || '';
          if (resultText) {
            const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            if (parsed.analyses) {
              const results: Record<string, { score: number; reason: string }> = {};
              for (const a of parsed.analyses) {
                results[a.id] = { score: a.score, reason: a.reason };
              }
              return results;
            }
          }
        }
      } catch (e: any) {
        this.logger.error(`Failed to analyze flights with Grok: ${e.message}. Trying Gemini fallback...`);
      }
    }

    // Try Gemini fallback
    if (geminiKey && geminiKey.trim() !== '') {
      try {
        this.logger.log('Analyzing flights using Gemini fallback...');
        const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash-lite'];
        let resultText = '';
        for (const model of geminiModels) {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          });
          if (res.ok) {
            const resData = await res.json();
            resultText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (resultText) break;
          }
        }

        if (resultText) {
          const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(cleanJson);
          if (parsed.analyses) {
            const results: Record<string, { score: number; reason: string }> = {};
            for (const a of parsed.analyses) {
              results[a.id] = { score: a.score, reason: a.reason };
            }
            return results;
          }
        }
      } catch (e: any) {
        this.logger.error(`Failed to analyze flights with Gemini: ${e.message}`);
      }
    }

    return {};
  }

  private async consumeGrokSseStream(body: any, onChunk: (text: string) => void) {
    if (!body) return;
    const reader = body.getReader ? body.getReader() : body;
    const decoder = new TextDecoder();
    let buffer = '';

    const parseLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === '[DONE]') return;
        try {
          const parsed = JSON.parse(dataStr);
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) onChunk(text);
        } catch {}
      }
    };

    if (typeof reader.read !== 'function') {
      for await (const chunk of reader) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          parseLine(line);
        }
      }
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          parseLine(line);
        }
      }
    }
  }
}
