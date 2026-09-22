import React from 'react';
import { JettyState } from '../../store/copilotStore';
import './JettyMascot.css';

interface JettyMascotProps {
  state: JettyState;
  size?: 'small' | 'medium' | 'large';
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  className?: string;
}

export const JettyMascot: React.FC<JettyMascotProps> = ({
  state,
  size = 'medium',
  onClick,
  onMouseEnter,
  onMouseLeave,
  className = ''
}) => {
  const sizeClasses = {
    small: 'w-10 h-10',
    medium: 'w-16 h-16 md:w-20 md:h-20',
    large: 'w-24 h-24 md:w-32 md:h-32'
  };

  return (
    <div 
      className={`relative inline-block ${sizeClasses[size]} ${className}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label="Jetty - JetSet.AI's Personal Travel Copilot"
    >
      <div className={`w-full h-full relative jetty-${state} transition-opacity duration-300`}>
        {/* Render the specific mascot state image */}
        <img 
          src={`/mascot/jetty-${state}.png`} 
          alt={`Jetty is ${state}`}
          className="w-full h-full object-contain drop-shadow-2xl"
          onError={(e) => {
            // Fallback to idle if specific state image fails to load
            (e.target as HTMLImageElement).src = '/mascot/jetty-idle.png';
          }}
        />

        {/* State-specific decorations */}
        {state === 'thinking' && (
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 jetty-dots">
            <span></span><span></span><span></span>
          </div>
        )}
        
        {state === 'excited' && (
          <>
            <div className="jetty-sparkle"></div>
            <div className="jetty-sparkle"></div>
            <div className="jetty-sparkle"></div>
          </>
        )}
        
        {state === 'sleepy' && (
          <div className="absolute -top-2 right-0 text-sky-300 font-bold text-xs opacity-70 animate-pulse">
            Zzz
          </div>
        )}
      </div>
    </div>
  );
};
