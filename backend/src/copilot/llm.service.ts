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
          model: 'openai/gpt-oss-120b',
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
            {
              type: 'function',
              function: {
                name: 'modify_trip',
                description: 'Modify trip parameters when the user wants to change their origin / starting city, destination, dates (extend, shorten, or move trip dates), budget, companions, or interests. Only include the fields that need to change.',
                parameters: {
                  type: 'object',
                  properties: {
                    origin: { type: 'string', description: 'New departure / starting city or airport (e.g., "Bengaluru", "New York")' },
                    destination: { type: 'string', description: 'New destination city or country (e.g., "Cusco", "Paris")' },
                    fromDate: { type: 'string', description: 'New departure/start date (ISO format YYYY-MM-DD or readable date)' },
                    toDate: { type: 'string', description: 'New return/end date (ISO format YYYY-MM-DD or readable date)' },
                    budget: { type: 'string', description: 'New budget level (e.g., "budget", "moderate", "luxury")' },
                    companions: { type: 'string', description: 'Updated travel companions (e.g., "solo", "couple", "family with kids")' },
                    interests: { type: 'array', items: { type: 'string' }, description: 'Updated list of travel interests' },
                  },
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'edit_itinerary',
                description: 'Edit or regenerate the travel itinerary based on user instructions. Use when the user wants to add activities, remove items, swap days, change pace, or fully regenerate their itinerary.',
                parameters: {
                  type: 'object',
                  properties: {
                    instruction: { type: 'string', description: 'The user\'s edit instruction (e.g., "add a museum visit on day 2", "make it more relaxed", "swap day 1 and day 3")' },
                    regenerate: { type: 'boolean', description: 'Set to true to fully regenerate the itinerary from scratch' },
                  },
                  required: ['instruction'],
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
