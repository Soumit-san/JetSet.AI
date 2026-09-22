"use client";

import { useCopilotStore } from "@/store/copilotStore";
import { JettyMascot } from "./assistant/JettyMascot";
import { JettySpeechBubble } from "./assistant/JettySpeechBubble";
import { useJettyState } from "@/hooks/useJettyState";

export function CopilotTrigger() {
  const { setIsOpen, isOpen } = useCopilotStore();
  const { jettyState, speechBubbleText, setHoverState, triggerClickReaction } = useJettyState();

  // Don't render the floating trigger if the sidebar is open
  if (isOpen) return null;

  const handleClick = () => {
    triggerClickReaction();
    // Wait for the reaction animation to play briefly before opening sidebar
    setTimeout(() => {
      setIsOpen(true);
    }, 300);
  };

  return (
    <div 
      className="fixed bottom-4 right-4 md:bottom-6 md:right-6 z-50 flex flex-col items-end"
      onMouseEnter={() => setHoverState(true)}
      onMouseLeave={() => setHoverState(false)}
    >
      <div className="relative">
        <JettySpeechBubble text={speechBubbleText} className="mb-2" />
        
        <button
          onClick={handleClick}
          className="relative group p-0 bg-transparent border-none outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded-full"
          aria-label="Open JetSet AI assistant"
        >
          {/* Subtle glow behind mascot */}
          <div className="absolute inset-0 bg-sky-500/20 rounded-full blur-xl jetty-launcher group-hover:bg-sky-500/30 transition-colors" />
          
          <JettyMascot 
            state={jettyState} 
            size="medium" 
            className="drop-shadow-2xl z-10 relative"
          />
        </button>
      </div>
    </div>
  );
}
