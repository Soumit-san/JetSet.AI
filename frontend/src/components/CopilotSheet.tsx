"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useCopilotStore } from '@/store/copilotStore';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { CopilotMessage, CopilotResponsePayload } from '@jetset/shared';
import { Loader2, Plane, Hotel, Map, MapPin, Navigation, Send, CheckSquare } from 'lucide-react';
import { getApiUrl } from '@/utils/api';
import { JettyMascot } from './assistant/JettyMascot';
import { useJettyState } from '@/hooks/useJettyState';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const getSuggestedQuestions = (route: string, view: string) => {
  if (route.includes('/results')) {
    if (view === 'flights') {
      return ["Filter for non-stop only", "Find flights departing after 10 AM", "What is the cheapest day to fly?"];
    }
    if (view === 'hotels') {
      return ["Show me hotels with free breakfast", "Which of these is closest to the airport?", "Sort these by highest rating"];
    }
    if (view === 'itinerary') {
      return ["Swap Day 2 outdoor activities due to rain", "Summarize my final itinerary and generate the packing list", "Are there any good local restaurants near my hotel?"];
    }
    // Default for results page (e.g. summary tab) - showing current things
    return ["Hotels", "Itinerary", "Hidden gems", "Local tips"];
  }
  return [
    "Plan a 3-day itinerary for Santorini",
    "Find me the best local food in Kyoto",
    "What are some hidden gems in Bali?"
  ];
};

export function CopilotSheet() {
  const { isOpen, setIsOpen, messages, addMessage, activeRoute, activeView, draftSelections, setIsStreaming, tripId } = useCopilotStore();
  const { jettyState } = useJettyState();
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  
  const suggestedQuestions = useMemo(() => getSuggestedQuestions(activeRoute, activeView), [activeRoute, activeView]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const handleSend = async (overrideInput?: string) => {
    const textToSend = overrideInput || input;
    if (!textToSend.trim()) return;

    const userMsg: CopilotMessage = { role: 'user', content: textToSend };
    addMessage(userMsg);
    if (!overrideInput) setInput('');
    setIsTyping(true);
    setIsStreaming(true);

    const token = localStorage.getItem('token') || 'dummy-token-for-now';
    const conversation = [...messages, userMsg];

    let currentAssistantContent = '';
    let assistantAdded = false;

    const updateLastMessage = (content: string) => {
      useCopilotStore.setState((state) => {
        const newMsgs = [...state.messages];
        if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'assistant') {
          newMsgs[newMsgs.length - 1] = { ...newMsgs[newMsgs.length - 1], content };
        }
        return { messages: newMsgs };
      });
    };

    const appendContent = (chunk: string) => {
      currentAssistantContent += chunk;
      if (!assistantAdded) {
        setIsTyping(false); // Stop thinking spinner once content starts
        addMessage({ role: 'assistant', content: currentAssistantContent });
        assistantAdded = true;
      } else {
        updateLastMessage(currentAssistantContent);
      }
    };

    try {
      const baseUrl = getApiUrl();
      await fetchEventSource(`${baseUrl}/copilot/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          messages: conversation,
          tripId: tripId || undefined,
          context: JSON.stringify({
            activeRoute,
            activeView,
            draftSelections
          })
        }),
        onmessage(ev) {
          try {
            const payload: CopilotResponsePayload = JSON.parse(ev.data);
            if (payload.isDone) {
              setIsTyping(false);
              setIsStreaming(false);
              return;
            }
            if (payload.error) {
              setIsTyping(false);
              setIsStreaming(false);
              appendContent(`Error: ${payload.error}`);
              return;
            }
            if (payload.content) {
              appendContent(payload.content);
            }
            if (payload.itineraryUpdated && payload.updatedItinerary) {
              window.dispatchEvent(new CustomEvent('copilot-itinerary-updated', {
                detail: { updatedItinerary: payload.updatedItinerary, tripId }
              }));
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('switch-tab', { detail: 'itinerary' }));
              }, 300);
            }
            if (payload.tripUpdated && payload.updatedTrip) {
              window.dispatchEvent(new CustomEvent('copilot-trip-updated', {
                detail: payload.updatedTrip
              }));
            }
            if (payload.toolCalls) {
               const tool = payload.toolCalls[0];
               if (tool.function.name === 'navigate_to_page') {
                 const args = JSON.parse(tool.function.arguments);
                 if (args.path) {
                   router.push(args.path);
                   appendContent(`\n\n*Navigating to ${args.path}...*`);
                 }
               } else if (tool.function.name === 'switch_tab') {
                 const args = JSON.parse(tool.function.arguments);
                 if (args.tabId) {
                   window.dispatchEvent(new CustomEvent('switch-tab', { detail: args.tabId }));
                   appendContent(`\n\n*Opening ${args.tabId} tab...*`);
                 }
               } else if (tool.function.name === 'modify_trip') {
                 const args = JSON.parse(tool.function.arguments);
                 // Dispatch a custom event so the results page can update URL params / trip state
                 window.dispatchEvent(new CustomEvent('copilot-modify-trip', { detail: args }));
                 // Switch to the most relevant tab after modification
                 if (args.fromDate || args.toDate) {
                   setTimeout(() => window.dispatchEvent(new CustomEvent('switch-tab', { detail: 'flights' })), 800);
                 } else if (args.budget || args.companions) {
                   setTimeout(() => window.dispatchEvent(new CustomEvent('switch-tab', { detail: 'hotels' })), 800);
                 }
               } else if (tool.function.name === 'edit_itinerary') {
                 const args = JSON.parse(tool.function.arguments);
                 // Dispatch event so ItineraryModule can pick up the edit instruction
                 window.dispatchEvent(new CustomEvent('copilot-edit-itinerary', { detail: args }));
                 setTimeout(() => window.dispatchEvent(new CustomEvent('switch-tab', { detail: 'itinerary' })), 600);
               } else {
                 appendContent(` [Executing Tool: ${tool.function.name}]`);
               }
            }
          } catch (e) {
            console.error('Failed to parse SSE payload', e);
          }
        },
        onerror(err) {
          console.error('SSE Error:', err);
          setIsTyping(false);
          setIsStreaming(false);
          throw err; 
        }
      });
    } catch (error) {
      console.error(error);
      setIsTyping(false);
      setIsStreaming(false);
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0 border-l-0 shadow-2xl">
        <SheetHeader className="p-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-3 text-xl">
            <JettyMascot state={jettyState} size="small" />
            <div>
              <div className="leading-none">JetSet.AI</div>
              <div className="text-xs text-muted-foreground font-normal mt-1">Personal Copilot</div>
            </div>
          </SheetTitle>
        </SheetHeader>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gradient-to-b from-muted/10 to-transparent">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full space-y-8 animate-in fade-in zoom-in duration-500">
              
              {/* Friendly Welcome Bubble */}
              <div className="flex flex-col items-center relative">
                <JettyMascot state={jettyState} size="large" className="mb-2 z-10" />
                <div className="relative bg-white text-slate-800 p-6 rounded-3xl rounded-tl-sm shadow-xl max-w-[85%] text-center -mt-4 z-0">
                  <p className="text-xl font-bold mb-2">Hey there! 💖</p>
                  <p className="text-sm">Need help planning your next adventure? <strong>I've got you!</strong></p>
                </div>
              </div>

              {/* Capabilities Sticky Note */}
              <div className="bg-amber-100 text-amber-900 p-5 rounded-md shadow-md transform rotate-2 w-3/4 self-end mr-4">
                <p className="font-bold text-sm mb-3 border-b border-amber-900/20 pb-1">I can help with:</p>
                <ul className="space-y-2 text-sm font-medium">
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Flights</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Hotels</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Itinerary</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Hidden gems</li>
                  <li className="flex items-center gap-2"><CheckSquare className="w-4 h-4 text-amber-700" /> Local tips</li>
                </ul>
              </div>

              {/* Suggested Questions */}
              <div className="w-full space-y-2 mt-4">
                <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-2 ml-1">Suggested for you</p>
                {suggestedQuestions.map((q, idx) => (
                  <button 
                    key={idx}
                    onClick={() => handleSend(q)}
                    className="w-full text-left p-3 rounded-xl bg-muted/50 hover:bg-muted border border-transparent hover:border-sky-500/30 transition-all text-sm flex items-center gap-3"
                  >
                    <Navigation className="w-4 h-4 text-sky-500" />
                    {q}
                  </button>
                ))}
              </div>

            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((m, i) => {
                if (m.role === 'assistant' && !m.content.trim()) return null;
                return (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start items-end gap-2'}`}>
                    {m.role === 'assistant' && (
                      <JettyMascot 
                        state={i === messages.length - 1 ? jettyState : 'idle'} 
                        size="small" 
                        className="mb-1 shrink-0" 
                      />
                    )}
                    <div className={`p-4 rounded-2xl max-w-[85%] shadow-sm ${
                      m.role === 'user' 
                        ? 'bg-sky-600 text-white rounded-br-sm' 
                        : 'bg-muted text-foreground rounded-bl-sm border border-border'
                    }`}>
                      {m.role === 'assistant' ? (
                        <div className="prose prose-sm dark:prose-invert max-w-none text-foreground select-text">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        m.content
                      )}
                    </div>
                  </div>
                );
              })}
              {isTyping && (
                <div className="flex justify-start items-end gap-2">
                  <JettyMascot state={jettyState} size="small" className="mb-1 shrink-0" />
                  <div className="p-4 rounded-2xl bg-muted rounded-bl-sm border border-border flex items-center gap-2 shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                    <span className="text-sm text-muted-foreground">Jetty is thinking...</span>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="p-4 bg-background border-t shadow-xl">
          <div className="flex gap-2 relative">
            <Input 
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Ask Jetty anything..."
              className="pr-12 py-6 rounded-full border-muted-foreground/30 focus-visible:ring-sky-500"
            />
            <Button 
              size="icon"
              className="absolute right-1 top-1 h-10 w-10 rounded-full bg-sky-600 hover:bg-sky-700" 
              onClick={() => handleSend()} 
              disabled={isTyping || !input.trim()}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
