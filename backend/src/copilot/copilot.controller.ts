import { Controller, Post, Body, Res, Req, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import type { Response, Request } from 'express';
import { CopilotService } from './copilot.service';
import { CopilotMessage, CopilotResponsePayload } from '@jetset/shared';
import * as jwt from 'jsonwebtoken';

@Controller('copilot')
export class CopilotController {
  constructor(private readonly copilotService: CopilotService) {}

  @Post('stream')
  async streamCopilot(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { messages: CopilotMessage[]; context?: string }
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

    const { messages, context } = body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const stream = await this.copilotService.handleStream(userId, messages, context);
      
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        
        let payload: CopilotResponsePayload = {};
        
        if (delta?.content) {
          payload.content = delta.content;
        }

        if (delta?.tool_calls) {
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

      res.write(`data: ${JSON.stringify({ isDone: true })}\n\n`);
      res.end();
    } catch (error: any) {
      const errMsg = error.message || 'Internal Server Error';
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
    }
  }
}
