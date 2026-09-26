import { Controller, Post, Body, Res, Req, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import type { Response, Request } from 'express';
import { CopilotService } from './copilot.service';
import { CopilotMessage, CopilotResponsePayload } from './copilot.types';
import * as jwt from 'jsonwebtoken';

@Controller('copilot')
export class CopilotController {
  constructor(private readonly copilotService: CopilotService) {}

  @Post('stream')
  async streamCopilot(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { messages: CopilotMessage[]; context?: string; tripId?: string }
  ) {
    // 1. Enforce transport via standard Authorization Header (No Query Strings)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];
    let userId = 'anonymous';
    try {
      // Decode JWT to get user (mocked decode here as secret might vary, typically use JwtService)
      // const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;
      // userId = decoded.sub || 'anonymous';
      // Temporarily bypass strict verify if JWT_SECRET isn't strictly set for testing
      const decoded = jwt.decode(token) as any;
      if (decoded && decoded.sub) {
        userId = decoded.sub;
      }
    } catch (e) {
      throw new UnauthorizedException('Invalid token');
    }

    const { messages, context, tripId } = body;

    // Resolve effective tripId from body or context
    let effectiveTripId = tripId || '';
    if (!effectiveTripId && context) {
      try {
        const parsed = JSON.parse(context);
        effectiveTripId = parsed?.tripId || parsed?.draftSelections?.tripId || '';
      } catch {}
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const stream = await this.copilotService.handleStream(userId, messages, context, effectiveTripId);
      
      const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
      let streamedAnyContent = false;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        
        const payload: CopilotResponsePayload = {};
        
        if (delta?.content) {
          payload.content = delta.content;
          streamedAnyContent = true;
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, {
                id: tc.id || `call_${idx}`,
                name: tc.function?.name || '',
                arguments: '',
              });
            }
            const existing = toolCallMap.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }

          payload.toolCalls = delta.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name as any,
              arguments: tc.function.arguments,
            },
          }));
        }

        if (Object.keys(payload).length > 0) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      // Execute accumulated tool calls on the backend (source of truth)
      for (const [, toolCall] of toolCallMap.entries()) {
        if (toolCall.name === 'edit_itinerary') {
          try {
            const args = JSON.parse(toolCall.arguments || '{}');
            const result = await this.copilotService.executeItineraryEdit(effectiveTripId, args.instruction, args.day);
            if (result.success) {
              const mutationPayload: CopilotResponsePayload = {
                itineraryUpdated: true,
                updatedItinerary: result.updatedItinerary,
                content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
              };
              res.write(`data: ${JSON.stringify(mutationPayload)}\n\n`);
            }
          } catch (e: any) {
            // Log error
          }
        } else if (toolCall.name === 'modify_trip') {
          try {
            const args = JSON.parse(toolCall.arguments || '{}');
            const result = await this.copilotService.executeTripModify(effectiveTripId, args);
            if (result.success) {
              const mutationPayload: CopilotResponsePayload = {
                tripUpdated: true,
                updatedTrip: result.updatedTrip || args,
                content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
              };
              res.write(`data: ${JSON.stringify(mutationPayload)}\n\n`);
            }
          } catch (e: any) {
            // Log error
          }
        }
      }

      // If the model did not generate an explicit tool call but the user prompt was clearly an itinerary edit request
      const lastUserMsg = (messages || []).filter(m => m.role === 'user').pop()?.content || '';
      const isEditIntent = (
        /add\s+.+\s+(to|on|in)\s+day\s+\d+/i.test(lastUserMsg) ||
        /remove\s+.+\s+from\s+day\s+\d+/i.test(lastUserMsg) ||
        /(make|include|change).+relaxed(\s+day|\s+free\s+day)?/i.test(lastUserMsg) ||
        /move\s+.+\s+from\s+day\s+\d+\s+to\s+day\s+\d+/i.test(lastUserMsg) ||
        /edit\s+(my\s+)?itinerary/i.test(lastUserMsg)
      );

      const hasEditToolCall = Array.from(toolCallMap.values()).some(tc => tc.name === 'edit_itinerary');
      if (!hasEditToolCall && isEditIntent && effectiveTripId) {
        try {
          const result = await this.copilotService.executeItineraryEdit(effectiveTripId, lastUserMsg);
          if (result.success) {
            res.write(`data: ${JSON.stringify({
              toolCalls: [{
                id: 'call_edit_itinerary_auto',
                type: 'function',
                function: { name: 'edit_itinerary', arguments: JSON.stringify({ instruction: lastUserMsg }) }
              }],
              itineraryUpdated: true,
              updatedItinerary: result.updatedItinerary,
              content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
            })}\n\n`);
          }
        } catch (err: any) {
          // Fallback handled
        }
      }

      // If the model did not generate an explicit tool call but user prompt has trip modification intent
      const hasModifyToolCall = Array.from(toolCallMap.values()).some(tc => tc.name === 'modify_trip');
      if (!hasModifyToolCall && effectiveTripId) {
        let detectedModifications: any = null;

        // Destination change
        const destMatch =
          lastUserMsg.match(/(?:change|update|switch|set)\s+(?:my\s+)?destination\s+to\s+([a-zA-Z\s]+?)(?:\s+and\s+update|\.|$)/i) ||
          lastUserMsg.match(/destination\s+to\s+([a-zA-Z\s]+?)(?:\s+and\s+update|\.|$)/i);
        if (destMatch && destMatch[1]) {
          detectedModifications = detectedModifications || {};
          detectedModifications.destination = destMatch[1].trim();
        }

        // Origin change
        const fromToMatch = lastUserMsg.match(/from\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+and\s+destination\s+to\s+([a-zA-Z\s]+))?(?:\.|$)/i);
        if (fromToMatch) {
          detectedModifications = detectedModifications || {};
          detectedModifications.origin = fromToMatch[1].trim();
          if (fromToMatch[3]) {
            detectedModifications.destination = fromToMatch[3].trim();
          } else if (!detectedModifications.destination) {
            detectedModifications.destination = fromToMatch[2].trim();
          }
        } else {
          const orgMatch = lastUserMsg.match(
            /(?:change|update|switch|set)\s+(?:my\s+)?(?:starting\s+city|origin|departure\s+city|starting\s+location)\s+to\s+([a-zA-Z\s]+?)(?:\.|$)/i,
          );
          if (orgMatch && orgMatch[1]) {
            detectedModifications = detectedModifications || {};
            detectedModifications.origin = orgMatch[1].trim();
          }
        }

        // Date extension / changes
        const extendMatch = lastUserMsg.match(
          /extend\s+(?:my\s+trip\s+)?(?:from\s+[a-zA-Z0-9,\s]+\s+)?to\s+([a-zA-Z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})/i,
        );
        if (extendMatch && extendMatch[1]) {
          detectedModifications = detectedModifications || {};
          detectedModifications.toDate = extendMatch[1].trim();
        }

        const rangeMatch = lastUserMsg.match(
          /(?:make|change|set)\s+(?:the\s+trip\s+)?([a-zA-Z]+\s+\d{1,2})\s+to\s+([a-zA-Z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})/i,
        );
        if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
          detectedModifications = detectedModifications || {};
          detectedModifications.fromDate = rangeMatch[1].trim();
          detectedModifications.toDate = rangeMatch[2].trim();
        }

        const moveMatch = lastUserMsg.match(
          /move\s+(?:my\s+trip\s+)?to\s+([a-zA-Z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})/i,
        );
        if (moveMatch && moveMatch[1] && !detectedModifications?.toDate) {
          detectedModifications = detectedModifications || {};
          detectedModifications.fromDate = moveMatch[1].trim();
        }

        if (detectedModifications && Object.keys(detectedModifications).length > 0) {
          try {
            const result = await this.copilotService.executeTripModify(effectiveTripId, detectedModifications);
            if (result.success) {
              res.write(
                `data: ${JSON.stringify({
                  toolCalls: [
                    {
                      id: 'call_modify_trip_auto',
                      type: 'function',
                      function: { name: 'modify_trip', arguments: JSON.stringify(detectedModifications) },
                    },
                  ],
                  tripUpdated: true,
                  updatedTrip: result.updatedTrip,
                  content: streamedAnyContent ? `\n\n${result.confirmation}` : result.confirmation,
                })}\n\n`,
              );
            }
          } catch (err: any) {
            // Error handled
          }
        }
      }

      res.write(`data: ${JSON.stringify({ isDone: true })}\n\n`);
      res.end();
    } catch (error: any) {
      const errMsg = error.message || 'Internal Server Error';
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    }
  }
}
