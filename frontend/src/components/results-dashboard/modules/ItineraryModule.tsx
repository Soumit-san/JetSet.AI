"use client";

import { getApiUrl } from '@/utils/api';

import React, { useState, useEffect, useRef } from "react";
import { Map, Calendar, ChevronDown, ChevronUp, Loader2, AlertCircle } from "lucide-react";
import { ModuleProps } from "./types";

interface ItineraryDay {
    day: number;
    title: string;
    activities: string[];
    rawContent: string;
}

function parseItinerary(text: string): ItineraryDay[] {
    const days: ItineraryDay[] = [];
    // Split by Day headers like "Day 1", "**Day 1**", "### Day 1", etc.
    const dayRegex = /(?:^|\n)(?:#{1,4}\s*)?(?:\*{0,2})Day\s+(\d+)(?:[:\s–-]*)([^\n]*?)(?:\*{0,2})(?=\n|$)/gi;
    const matches = [...text.matchAll(dayRegex)];

    if (matches.length === 0) {
        // Fallback: show raw text as single block
        return [{
            day: 1,
            title: "Full Itinerary",
            activities: text.split("\n").filter(l => l.trim().length > 0),
            rawContent: text,
        }];
    }

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const dayNum = parseInt(match[1]);
        const title = match[2].replace(/[*#]/g, "").trim() || `Day ${dayNum}`;
        const start = (match.index ?? 0) + match[0].length;
        const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
        const rawContent = text.slice(start, end).trim();

        const activities = rawContent
            .split("\n")
            .map(l => l.replace(/^[\s\-\*\d\.]+/, "").trim())
            .filter(l => l.length > 3);

        days.push({ day: dayNum, title, activities, rawContent });
    }

    return days;
}

export default function ItineraryModule({ tripId, org, dest, dates }: ModuleProps) {
    const [itinerary, setItinerary] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState("");
    const [expandedDays, setExpandedDays] = useState<Set<number>>(new Set([1]));
    const fetchedRef = useRef(false);

    useEffect(() => {
        if (fetchedRef.current) return;
        fetchedRef.current = true;
        fetchItinerary();
    }, [tripId]);

    // Listen for real-time Copilot itinerary updates
    useEffect(() => {
        const handleItineraryUpdated = (e: Event) => {
            const customEvent = e as CustomEvent;
            const updated = customEvent.detail?.updatedItinerary;
            if (updated) {
                setItinerary(updated);
                setIsLoading(false);
                setError("");
                const newDays = parseItinerary(updated);
                setExpandedDays(prev => {
                    const next = new Set(prev);
                    newDays.forEach(d => next.add(d.day));
                    return next;
                });
            } else {
                fetchedRef.current = false;
                fetchItinerary();
            }
        };

        window.addEventListener("copilot-itinerary-updated", handleItineraryUpdated);
        return () => window.removeEventListener("copilot-itinerary-updated", handleItineraryUpdated);
    }, []);

    const fetchItinerary = async () => {
        setIsLoading(true);
        setError("");
        setItinerary("");

        try {
            const baseUrl = getApiUrl();

            const tripDest = dest || "the destination";
            const tripOrg = org || "your origin";
            const tripDates = dates || "the travel dates";

            const prompt = `Generate a detailed day-by-day travel itinerary for a trip from ${tripOrg} to ${tripDest} during ${tripDates}.

Format it strictly as:
Day 1: Arrival & Exploration
- Activity or tip
- Activity or tip

Day 2: [Theme]
- Activity or tip

Continue for the full trip duration (max 7 days if dates are not specified).
Be specific with landmarks, restaurants, transport tips, and timings. Keep it practical and inspiring.`;

            const response = await fetch(`${baseUrl}/ai/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tripId,
                    messages: [{ role: "user", content: prompt }],
                }),
            });

            if (!response.ok) throw new Error(`Backend returned ${response.status}`);
            if (!response.body) throw new Error("No readable stream");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let fullText = "";

            setIsLoading(false);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("data: ")) {
                        const dataStr = trimmed.slice(6).trim();
                        if (dataStr === "[DONE]") break;
                        try {
                            const parsed = JSON.parse(dataStr);
                            if (parsed.text) {
                                fullText += parsed.text;
                                setItinerary(fullText);
                                // Auto-expand days as they stream in
                                const newDays = parseItinerary(fullText);
                                setExpandedDays(prev => {
                                    const next = new Set(prev);
                                    newDays.forEach(d => { if (d.day <= 2) next.add(d.day); });
                                    return next;
                                });
                            }
                        } catch {
                            // Ignore parse errors on partial SSE chunks
                        }
                    }
                }
            }
        } catch (err: any) {
            setIsLoading(false);
            setError(err.message || "Failed to load itinerary. Make sure the backend is running.");
        }
    };

    const toggleDay = (day: number) => {
        setExpandedDays(prev => {
            const next = new Set(prev);
            if (next.has(day)) next.delete(day);
            else next.add(day);
            return next;
        });
    };

    const days = itinerary ? parseItinerary(itinerary) : [];

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-5">
                <div className="relative">
                    <div className="w-16 h-16 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin" />
                    <Map className="absolute inset-0 m-auto w-7 h-7 text-cyan-400" />
                </div>
                <p className="text-white/60 font-sans text-sm">Generating your day-by-day itinerary...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="glass-panel p-8 rounded-2xl flex flex-col items-center gap-4 text-center border border-red-500/20">
                <AlertCircle className="w-10 h-10 text-red-400" />
                <p className="text-white/80 font-sans">{error}</p>
                <button
                    onClick={() => { fetchedRef.current = false; fetchItinerary(); }}
                    className="text-cyan-400 border border-cyan-500/30 rounded-xl px-4 py-2 text-sm hover:bg-cyan-500/10 transition-colors"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="glass-panel p-6 rounded-2xl border-l-4 border-l-cyan-500 flex items-center gap-4">
                <div className="p-3 bg-cyan-500/10 rounded-xl border border-cyan-500/20">
                    <Map className="w-6 h-6 text-cyan-400" />
                </div>
                <div>
                    <h2 className="text-xl font-bold font-syne text-white">Day-by-Day Itinerary</h2>
                    <p className="text-white/50 text-sm font-sans mt-0.5">
                        {dest ? `Your custom plan for ${dest}` : "Your personalized travel plan"}
                    </p>
                </div>
            </div>

            {/* Day Cards */}
            <div className="space-y-3">
                {days.map((day) => {
                    const isExpanded = expandedDays.has(day.day);
                    return (
                        <div
                            key={day.day}
                            className="glass-panel rounded-2xl border border-white/8 overflow-hidden transition-all duration-300"
                        >
                            {/* Day Header */}
                            <button
                                onClick={() => toggleDay(day.day)}
                                className="w-full flex items-center justify-between p-5 hover:bg-white/5 transition-colors text-left"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex flex-col items-center justify-center">
                                        <Calendar className="w-4 h-4 text-cyan-400" />
                                        <span className="text-[10px] font-mono text-cyan-300 font-bold leading-none mt-0.5">{day.day}</span>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-mono text-cyan-400/70 uppercase tracking-widest">Day {day.day}</p>
                                        <h3 className="text-white font-semibold font-syne leading-tight">{day.title}</h3>
                                    </div>
                                </div>
                                <div className="flex-shrink-0 text-white/40">
                                    {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                                </div>
                            </button>

                            {/* Day Content */}
                            {isExpanded && (
                                <div className="px-5 pb-5 pt-1 border-t border-white/5">
                                    <ul className="space-y-2.5">
                                        {day.activities.map((activity, idx) => (
                                            <li key={idx} className="flex gap-3 items-start">
                                                <span className="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-cyan-400/60" />
                                                <p className="text-white/80 font-sans text-sm leading-relaxed">{activity}</p>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Streaming indicator */}
            {itinerary && days.length === 0 && (
                <div className="glass-panel p-6 rounded-2xl">
                    <p className="text-white/70 font-sans text-sm whitespace-pre-wrap leading-relaxed">{itinerary}</p>
                </div>
            )}
        </div>
    );
}
