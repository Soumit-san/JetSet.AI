import { useEffect, useState, useRef } from 'react';
import { useCopilotStore, JettyState } from '../store/copilotStore';

interface JettyStateReturn {
  jettyState: JettyState;
  speechBubbleText: string | null;
  setHoverState: (isHovering: boolean) => void;
  triggerClickReaction: () => void;
}

export function useJettyState(): JettyStateReturn {
  const { isOpen, isStreaming, jettyState, setJettyState, messages } = useCopilotStore();
  const [speechBubbleText, setSpeechBubbleText] = useState<string | null>(null);
  
  // Track if we've already done the initial greeting
  const [hasGreeted, setHasGreeted] = useState(false);
  
  // Timers
  const sleepTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reactionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const bubbleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const resetSleepTimer = () => {
    if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
    // Set sleepy after 2 minutes of inactivity (120000ms)
    sleepTimerRef.current = setTimeout(() => {
      // Only get sleepy if we're currently idle and not open
      const currentState = useCopilotStore.getState().jettyState;
      if (currentState === 'idle' && !useCopilotStore.getState().isOpen) {
        setJettyState('sleepy');
      }
    }, 120000);
  };

  const showBubble = (text: string, duration = 4000) => {
    setSpeechBubbleText(text);
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => {
      setSpeechBubbleText(null);
    }, duration);
  };

  // 1. Initial Greeting Lifecycle
  useEffect(() => {
    if (!hasGreeted) {
      setHasGreeted(true);
      setJettyState('greeting');
      
      // Delay speech bubble slightly after entrance
      setTimeout(() => {
        showBubble("Hey! 👋 Ready for your next adventure?", 4000);
      }, 600);

      // Return to idle after greeting
      setTimeout(() => {
        setJettyState('idle');
        resetSleepTimer();
      }, 5000);
    }
  }, [hasGreeted, setJettyState]);

  // Handle default (Help?) bubble when idle and not interacted
  useEffect(() => {
    const state = useCopilotStore.getState();
    if (!state.hasInteracted && hasGreeted && jettyState === 'idle' && !speechBubbleText) {
      setSpeechBubbleText("Help?");
    }
    if (state.hasInteracted && speechBubbleText === "Help?") {
      setSpeechBubbleText(null);
    }
  }, [hasGreeted, jettyState, speechBubbleText]);

  // 2. Monitor Streaming and Messages for automatic transitions
  useEffect(() => {
    if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);

    if (isStreaming) {
      setJettyState('talking');
      resetSleepTimer();
    } else if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      
      // If user just sent a message (and we're waiting for SSE/fetch to start)
      if (lastMessage.role === 'user') {
        setJettyState('listening');
        resetSleepTimer();
      } 
      // If assistant just finished responding
      else if (lastMessage.role === 'assistant' && lastMessage.content) {
        // If it's an error
        if (lastMessage.content.startsWith('Error:')) {
          setJettyState('error');
          showBubble("Oops! Let me try that again.", 4000);
          
          reactionTimerRef.current = setTimeout(() => {
            setJettyState('idle');
            resetSleepTimer();
          }, 3000);
        } else {
          setJettyState('happy');
          reactionTimerRef.current = setTimeout(() => {
            setJettyState('idle');
            resetSleepTimer();
          }, 2000);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, messages.length]);

  // Handle manual hover state (wakes up if sleepy)
  const setHoverState = (isHovering: boolean) => {
    if (isHovering) {
      if (jettyState === 'idle' || jettyState === 'sleepy') {
        setJettyState('hover');
      }
    } else {
      if (jettyState === 'hover') {
        setJettyState('idle');
        resetSleepTimer();
      }
    }
  };

  const triggerClickReaction = () => {
    setJettyState('happy');
    if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = setTimeout(() => {
      setJettyState('idle');
      resetSleepTimer();
    }, 1500);
  };

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
      if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    };
  }, []);

  return {
    jettyState,
    speechBubbleText,
    setHoverState,
    triggerClickReaction,
  };
}
