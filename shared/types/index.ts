export type ToolName =
  | 'search_destinations'
  | 'get_transit_schedule'
  | 'fetch_homestays'
  | 'request_booking_confirmation';

export interface CopilotMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: ToolName;
    arguments: string; // JSON string
  };
}

export interface CopilotResponsePayload {
  content?: string;
  toolCalls?: ToolCall[];
  isDone?: boolean;
  error?: string;
}

export interface BookingConfirmationChallenge {
  challengeToken: string; // Signed JWT
  bookingDetails: Record<string, any>;
  expiresAt: string;
}
