import { create } from 'zustand';
import { CopilotMessage } from '@jetset/shared';

export type JettyState =
  | 'idle'
  | 'greeting'
  | 'hover'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'happy'
  | 'excited'
  | 'confused'
  | 'error'
  | 'sleepy';

interface CopilotState {
  isOpen: boolean;
  messages: CopilotMessage[];
  activeRoute: string;
  jettyState: JettyState;
  isStreaming: boolean;
  activeView: string;
  draftSelections: any;
  hasInteracted: boolean;
  tripId: string;
  setIsOpen: (isOpen: boolean) => void;
  addMessage: (msg: CopilotMessage) => void;
  setActiveRoute: (route: string) => void;
  setActiveView: (view: string) => void;
  setDraftSelections: (selections: any) => void;
  setHasInteracted: (interacted: boolean) => void;
  clearMessages: () => void;
  setJettyState: (state: JettyState) => void;
  setIsStreaming: (val: boolean) => void;
  setTripId: (tripId: string) => void;
}

export const useCopilotStore = create<CopilotState>((set) => ({
  isOpen: false,
  messages: [],
  activeRoute: '/',
  jettyState: 'idle',
  isStreaming: false,
  activeView: '',
  draftSelections: null,
  hasInteracted: false,
  tripId: '',
  setIsOpen: (isOpen) => set({ isOpen, hasInteracted: true }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg], hasInteracted: true })),
  setActiveRoute: (route) => set({ activeRoute: route }),
  setActiveView: (view) => set({ activeView: view }),
  setDraftSelections: (selections) => set({ draftSelections: selections }),
  setHasInteracted: (interacted) => set({ hasInteracted: interacted }),
  clearMessages: () => set({ messages: [] }),
  setJettyState: (jettyState) => set({ jettyState }),
  setIsStreaming: (isStreaming) => set({ isStreaming }),
  setTripId: (tripId) => set({ tripId }),
}));
