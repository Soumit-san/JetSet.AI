import React from 'react';
import './JettyMascot.css';

interface JettySpeechBubbleProps {
  text: string | null;
  className?: string;
}

export const JettySpeechBubble: React.FC<JettySpeechBubbleProps> = ({ text, className = '' }) => {
  if (!text) return null;

  return (
    <div className={`absolute bottom-[110%] right-1/2 translate-x-1/4 jetty-speech-bubble z-50 pointer-events-none ${className}`}>
      <div className="relative bg-[#0c1528] text-white px-4 py-3 rounded-2xl rounded-br-sm shadow-xl border border-sky-500/20 max-w-[200px] min-w-[120px] backdrop-blur-md">
        <p className="text-sm font-medium leading-tight">{text}</p>
        
        {/* Tail */}
        <div className="absolute -bottom-2 right-4 w-4 h-4 bg-[#0c1528] border-b border-r border-sky-500/20 transform rotate-45"></div>
      </div>
    </div>
  );
};
