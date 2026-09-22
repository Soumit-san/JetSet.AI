import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LlmService {
  private groq: Groq;
  private readonly logger = new Logger(LlmService.name);

  constructor(private configService: ConfigService) {
    this.groq = new Groq({
      apiKey: this.configService.get<string>('GROQ_API_KEY'),
    });
  }

  async getChatCompletionStream(
    messages: any[],
    systemPrompt: string,
    abortSignal?: AbortSignal,
  ): Promise<any> {
    try {
      this.logger.log('Starting Groq chat completion stream');
      const stream = await this.groq.chat.completions.create(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
          ],
          model: 'openai/gpt-oss-20b',
          stream: true,
          tools: [
            {
              type: 'function',
              function: {
                name: 'search_destinations',
                description: 'Search for travel destinations based on query',
                parameters: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'The search query' },
                  },
                  required: ['query'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'get_transit_schedule',
                description: 'Get transit schedule for a route',
                parameters: {
                  type: 'object',
                  properties: {
                    origin: { type: 'string' },
                    destination: { type: 'string' },
                    date: { type: 'string' },
                  },
                  required: ['origin', 'destination', 'date'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'fetch_homestays',
                description: 'Fetch homestays for a destination',
                parameters: {
                  type: 'object',
                  properties: {
                    location: { type: 'string' },
                    checkIn: { type: 'string' },
                    checkOut: { type: 'string' },
                  },
                  required: ['location', 'checkIn', 'checkOut'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'request_booking_confirmation',
                description: 'Request confirmation to book a trip or homestay',
                parameters: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['flight', 'homestay'] },
                    itemId: { type: 'string' },
                  },
                  required: ['type', 'itemId'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'navigate_to_page',
                description: 'Navigate the user to a specific page or route in the application if their request falls outside the current view',
                parameters: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'The path to navigate to, e.g., /flights, /hotels, /results' },
                  },
                  required: ['path'],
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'switch_tab',
                description: 'Switch the dashboard tab if the user wants to view flights, hotels, or their itinerary.',
                parameters: {
                  type: 'object',
                  properties: {
                    tabId: { type: 'string', enum: ['summary', 'flights', 'hotels', 'season', 'itinerary'] },
                  },
                  required: ['tabId'],
                },
              },
            },
          ],
        },
        {
          signal: abortSignal,
        },
      );
      return stream;
    } catch (error) {
      this.logger.error('Error in Groq stream', error);
      throw error;
    }
  }
}
