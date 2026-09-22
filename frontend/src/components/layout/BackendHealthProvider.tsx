'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Wifi, WifiOff, Loader2 } from 'lucide-react';

import { getApiUrl } from '@/utils/api';

type HealthStatus = 'checking' | 'online' | 'waking' | 'offline';

interface BackendHealthContextType {
    status: HealthStatus;
    wakeUpProgress: number; // approximate progress or duration counter
}

const BackendHealthContext = createContext<BackendHealthContextType>({
    status: 'checking',
    wakeUpProgress: 0,
});

export const useBackendHealth = () => useContext(BackendHealthContext);

export function BackendHealthProvider({ children }: { children: React.ReactNode }) {
    const [status, setStatus] = useState<HealthStatus>('checking');
    const [wakeUpProgress, setWakeUpProgress] = useState(0);

    useEffect(() => {
        const baseUrl = getApiUrl();
        let isMounted = true;
        let pollInterval: NodeJS.Timeout | null = null;
        let progressInterval: NodeJS.Timeout | null = null;

        const checkHealth = async (): Promise<boolean> => {
            try {
                // Fetch with a short 3s timeout for each single health check attempt
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);

                const res = await fetch(`${baseUrl}/health`, {
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);

                if (res.ok) {
                    const data = await res.json();
                    if (data.status === 'ok') {
                        return true;
                    }
                }
                return false;
            } catch (err) {
                return false;
            }
        };

        const startWakingSequence = () => {
            if (status === 'waking') return;
            setStatus('waking');
            setWakeUpProgress(0);

            // Increment progress counter roughly representing HF space boot time (approx 35s)
            progressInterval = setInterval(() => {
                setWakeUpProgress((prev) => {
                    if (prev >= 95) return prev; // stay at 95 until actually online
                    return prev + 5;
                });
            }, 1800);

            // Poll every 3 seconds to check if container is awake
            pollInterval = setInterval(async () => {
                const isAlive = await checkHealth();
                if (isAlive && isMounted) {
                    setStatus('online');
                    setWakeUpProgress(100);
                    cleanup();
                }
            }, 3000);
        };

        const cleanup = () => {
            if (pollInterval) clearInterval(pollInterval);
            if (progressInterval) clearInterval(progressInterval);
        };

        const init = async () => {
            // Initial check
            const isAlive = await checkHealth();
            if (!isMounted) return;

            if (isAlive) {
                setStatus('online');
            } else {
                // If offline or asleep, start waking up the container
                startWakingSequence();
            }
        };

        init();

        return () => {
            isMounted = false;
            cleanup();
        };
    }, []);

    return (
        <BackendHealthContext.Provider value={{ status, wakeUpProgress }}>
            {children}
            
            {/* Global micro-banner when waking up/connecting */}
            {status === 'waking' && (
                <div className="fixed bottom-4 left-4 z-50 max-w-sm bg-ink-950/95 border border-sky-500/30 rounded-xl p-4 shadow-[0_10px_30px_rgba(14,165,233,0.15)] backdrop-blur-md animate-fade-in-up">
                    <div className="flex items-center gap-3">
                        <div className="relative flex items-center justify-center w-8 h-8 rounded-full bg-sky-500/10 text-sky-400">
                            <Loader2 className="w-4.5 h-4.5 animate-spin" />
                        </div>
                        <div className="flex-1">
                            <h4 className="text-xs font-semibold text-white tracking-wide uppercase">
                                Preparing AI Engine
                            </h4>
                            <p className="text-xxs text-white/50 leading-relaxed mt-0.5">
                                Hugging Face container is waking up. First plan might take 20-30s.
                            </p>
                        </div>
                    </div>
                    {/* Progress Bar */}
                    <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden mt-3">
                        <div 
                            className="bg-sky-500 h-full rounded-full transition-all duration-1000 ease-out"
                            style={{ width: `${wakeUpProgress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Offline Error Banner if server can't be reached at all */}
            {status === 'offline' && (
                <div className="fixed bottom-4 left-4 z-50 max-w-sm bg-ink-950/95 border border-red-500/30 rounded-xl p-4 shadow-[0_10px_30px_rgba(239,68,68,0.15)] backdrop-blur-md animate-fade-in-up">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-red-500/10 text-red-400">
                            <WifiOff className="w-4.5 h-4.5" />
                        </div>
                        <div className="flex-1">
                            <h4 className="text-xs font-semibold text-white tracking-wide uppercase">
                                Server Unreachable
                            </h4>
                            <p className="text-xxs text-white/50 leading-relaxed mt-0.5">
                                Unable to establish connection to the backend system.
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </BackendHealthContext.Provider>
    );
}
