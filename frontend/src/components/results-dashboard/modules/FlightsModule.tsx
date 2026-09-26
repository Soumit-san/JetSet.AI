"use client";

import { getApiUrl } from '@/utils/api';

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    ExternalLink, Search, Plane, CalendarDays,
    Loader2, RefreshCw,
} from "lucide-react";
import SkeletonLoader from "../SkeletonLoader";
import { ModuleProps } from "./types";
import { useUserCurrency } from "@/hooks/useUserCurrency";
import { FlightCard } from "@/components/flights/FlightCard";
import { FlightFilters, SortOption } from "@/components/flights/FlightFilters";
import { compareFlights } from "@/utils/flight-utils";
import { formatSingleDisplayDate, parseYMD } from "@/lib/dateUtils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FlightLegItem {
    legNum: number;
    from: string;
    fromIata: string;
    to: string;
    toIata: string;
    date: string;
    note?: string;
}

interface FlightLegsData {
    gateway: string;
    gatewayIata: string;
    outbound: FlightLegItem[];
    return: FlightLegItem[];
    groundSegments: string[];
}

interface LegState {
    isLoading: boolean;
    flights: any[];
    error: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtDisplay = (iso: string): string => {
    return formatSingleDisplayDate(iso, "day-month");
};

// ─── Booking Links ────────────────────────────────────────────────────────────

function DirectBookingLinks({ orgCode, destCode, travelDate }: { orgCode: string; destCode: string; travelDate: string }) {
    let y: string, m: string, d: string;
    const p = parseYMD(travelDate);
    if (p) {
        y = String(p.year);
        m = String(p.month).padStart(2, "0");
        d = String(p.day).padStart(2, "0");
    } else {
        const today = new Date();
        const fallback = new Date(today.getTime() + 7 * 86400000);
        y = String(fallback.getFullYear());
        m = String(fallback.getMonth() + 1).padStart(2, "0");
        d = String(fallback.getDate()).padStart(2, "0");
    }

    const links = [
        { name: "MakeMyTrip", url: `https://www.makemytrip.com/flight/search?itinerary=${orgCode}-${destCode}-${d}/${m}/${y}&tripType=O&paxType=A-1_C-0_I-0&intl=true&cabinClass=E` },
        { name: "Ixigo",      url: `https://www.ixigo.com/search/result/flight?from=${orgCode}&to=${destCode}&date=${y}-${m}-${d}&adults=1&children=0&infants=0&class=e` },
        { name: "Goibibo",    url: `https://www.goibibo.com/flights/air-${orgCode}-${destCode}-${y}${m}${d}--1-0-0-E-D/` },
    ];

    return (
        <div className="flex flex-wrap gap-2 mt-2 justify-center">
            {links.map(l => (
                <a key={l.name} href={l.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-white/70 hover:text-white hover:border-white/20 hover:bg-white/10 transition-all text-xs font-semibold">
                    <ExternalLink className="w-3 h-3" />
                    {l.name}
                </a>
            ))}
        </div>
    );
}

// ─── FlightsModule ────────────────────────────────────────────────────────────

export default function FlightsModule({ tripId, org, dest, dates, curr }: ModuleProps) {
    const localeCurrency = useUserCurrency();
    const finalCurrency  = curr || localeCurrency;
    const API = getApiUrl();

    const [legsData,    setLegsData]    = useState<FlightLegsData | null>(null);
    const [legsStatus,  setLegsStatus]  = useState<"idle" | "loading" | "pending" | "ready" | "error">("idle");
    const [legStates,   setLegStates]   = useState<Record<string, LegState>>({});
    const [activeTab,   setActiveTab]   = useState<number>(0);
    const fetchedKeys   = useRef<Set<string>>(new Set());
    const pollTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollCountRef  = useRef(0);
    const MAX_POLL = 15;

    const [sortBy,   setSortBy]   = useState<SortOption>("BEST");
    const [maxStops, setMaxStops] = useState<number | null>(null);

    // ── Fetch flight legs from Gemini endpoint ─────────────────────────────────
    const fetchLegs = useCallback(async () => {
        if (!tripId) return;
        setLegsStatus("loading");
        try {
            const res = await fetch(API + "/trips/" + tripId + "/flight-legs");
            if (!res.ok) throw new Error("endpoint error");
            const data = await res.json();
            if (data.status === "pending") { setLegsStatus("pending"); return; }
            setLegsData(data.legs);
            setLegsStatus("ready");
            setActiveTab(0);
            fetchedKeys.current.clear();
        } catch {
            setLegsStatus("error");
        }
    }, [tripId, API]);

    useEffect(() => { if (tripId) fetchLegs(); }, [tripId, fetchLegs]);

    // ── Poll while plan is generating ─────────────────────────────────────────
    useEffect(() => {
        if (legsStatus !== "pending") {
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            pollCountRef.current = 0;
            return;
        }
        if (pollCountRef.current >= MAX_POLL) { setLegsStatus("error"); return; }
        pollTimerRef.current = setTimeout(async () => { pollCountRef.current++; await fetchLegs(); }, 3000);
        return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
    }, [legsStatus, fetchLegs]);

    // ── Fetch flights for a single leg ─────────────────────────────────────────
    const fetchLegFlights = useCallback(async (key: string, leg: FlightLegItem) => {
        if (fetchedKeys.current.has(key)) return;
        fetchedKeys.current.add(key);

        setLegStates(prev => ({ ...prev, [key]: { isLoading: true, flights: [], error: null } }));

        try {
            const qp = new URLSearchParams({
                originLocationCode:      leg.fromIata,
                destinationLocationCode: leg.toIata,
                departureDate:           leg.date || new Date().toISOString().split("T")[0],
                adults:                  "1",
                currencyCode:            finalCurrency,
            });
            if (tripId) qp.append("tripId", tripId);

            const res = await fetch(API + "/flights/search?" + qp.toString());
            if (!res.ok) throw new Error("Flight search failed");
            const json = await res.json();

            setLegStates(prev => ({
                ...prev,
                [key]: { isLoading: false, flights: json.data || [], error: null },
            }));
        } catch (err: any) {
            setLegStates(prev => ({
                ...prev,
                [key]: { isLoading: false, flights: [], error: err.message || "Failed" },
            }));
        }
    }, [tripId, finalCurrency, API]);

    // ── Get all sequential legs as one array ───────────────────────────────────
    const sequentialLegs = (() => {
        if (!legsData) return [];
        const outLegs = (legsData.outbound || []).map(l => ({ ...l, isReturnLeg: false }));
        const retLegs = (legsData.return || []).map(l => ({ ...l, isReturnLeg: true }));
        return [...outLegs, ...retLegs];
    })();

    // ── Trigger fetch for active leg tab ──────────────────────────────────────
    useEffect(() => {
        if (sequentialLegs.length === 0) return;
        const activeLeg = sequentialLegs[activeTab];
        if (activeLeg) {
            const key = `${activeLeg.legNum}#${activeLeg.fromIata}#${activeLeg.toIata}#${activeLeg.date}`;
            fetchLegFlights(key, activeLeg);
        }
    }, [activeTab, sequentialLegs, fetchLegFlights]);

    // Pre-fetch first tab
    useEffect(() => {
        if (sequentialLegs.length > 0) {
            const activeLeg = sequentialLegs[0];
            const key = `${activeLeg.legNum}#${activeLeg.fromIata}#${activeLeg.toIata}#${activeLeg.date}`;
            fetchLegFlights(key, activeLeg);
        }
    }, [sequentialLegs]); // eslint-disable-line

    // ─── Render loading / pending / error ─────────────────────────────────────

    if (legsStatus === "idle" || legsStatus === "loading") {
        return (
            <div className="space-y-8">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="space-y-4">
                    {[1].map(i => (
                        <div key={i} className="space-y-2">
                            <div className="h-10 w-28 rounded-full bg-white/5 animate-pulse" />
                            <SkeletonLoader type="flights" />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (legsStatus === "pending") {
        return (
            <div className="space-y-8">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="glass-panel rounded-2xl p-10 flex flex-col items-center gap-4 border border-white/10">
                    <div className="w-12 h-12 rounded-full bg-sky-500/15 flex items-center justify-center">
                        <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                    </div>
                    <div className="text-center">
                        <p className="text-white font-semibold">AI Analysing Your Flight Plan…</p>
                        <p className="text-white/50 text-sm mt-1">
                            Finding optimal commercial flights. Stays and domestic connections will load soon.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (legsStatus === "error" || !legsData || sequentialLegs.length === 0) {
        return (
            <div className="space-y-8">
                <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />
                <div className="glass-panel rounded-2xl p-8 flex flex-col items-center gap-4 border border-red-500/20">
                    <p className="text-white/60 text-sm">No commercial flight routes required or found for this destination.</p>
                    <button onClick={() => { fetchedKeys.current.clear(); fetchLegs(); }}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/70 text-sm transition-all">
                        <RefreshCw className="w-4 h-4" /> Retry
                    </button>
                </div>
            </div>
        );
    }

    const activeLeg = sequentialLegs[activeTab];
    const key = activeLeg ? `${activeLeg.legNum}#${activeLeg.fromIata}#${activeLeg.toIata}#${activeLeg.date}` : "";
    const activeState = legStates[key];

    return (
        <div className="space-y-6">
            {/* Global Filters */}
            <FlightFilters sortBy={sortBy} setSortBy={setSortBy} maxStops={maxStops} setMaxStops={setMaxStops} />

            {/* Tab Bar for Flight Legs */}
            <div className="flex flex-wrap gap-2 pb-3 border-b border-white/10">
                {sequentialLegs.map((leg, idx) => {
                    const isActive = idx === activeTab;
                    const isReturnLeg = leg.isReturnLeg;

                    return (
                        <button
                            key={idx}
                            onClick={() => setActiveTab(idx)}
                            className={[
                                "flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-all duration-250 border whitespace-nowrap",
                                isActive
                                    ? isReturnLeg
                                        ? "bg-purple-500/20 border-purple-500/50 text-purple-300 shadow-lg shadow-purple-500/10"
                                        : "bg-sky-500/20 border-sky-500/50 text-sky-300 shadow-lg shadow-sky-500/10"
                                    : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white/80",
                            ].join(" ")}
                        >
                            <Plane className={`w-3.5 h-3.5 ${isActive ? isReturnLeg ? "text-purple-400 -rotate-45" : "text-sky-400 rotate-45" : "text-white/40"}`} />
                            <span>{leg.from} → {leg.to}</span>
                            <span className="text-[10px] opacity-60">({fmtDisplay(leg.date)})</span>
                        </button>
                    );
                })}
            </div>

            {/* Active Flight Leg Content */}
            {activeLeg && (
                <div className="space-y-4">
                    {/* Active Header */}
                    <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${
                            activeLeg.isReturnLeg ? "bg-purple-500/10 border-purple-500/20" : "bg-sky-500/10 border-sky-500/20"
                        }`}>
                            <Plane className={`w-3.5 h-3.5 ${activeLeg.isReturnLeg ? "text-purple-400 -rotate-45" : "text-sky-400 rotate-45"}`} />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold text-white leading-tight">
                                {activeLeg.from} ({activeLeg.fromIata}) to {activeLeg.to} ({activeLeg.toIata})
                            </h3>
                            <div className="flex items-center gap-1.5 text-xs text-white/40 mt-0.5">
                                <CalendarDays className="w-3.5 h-3.5" />
                                <span>{fmtDisplay(activeLeg.date)} {activeLeg.note ? `· ${activeLeg.note}` : ""}</span>
                            </div>
                        </div>
                    </div>

                    {/* Flight Result Options */}
                    {!activeState || activeState.isLoading ? (
                        <SkeletonLoader type="flights" />
                    ) : activeState.error ? (
                        <div className="glass-panel p-6 rounded-xl border border-red-500/10 text-center">
                            <p className="text-red-400 text-sm mb-3">Could not search flights: {activeState.error}</p>
                            <DirectBookingLinks orgCode={activeLeg.fromIata} destCode={activeLeg.toIata} travelDate={activeLeg.date} />
                        </div>
                    ) : (() => {
                        let sorted = [...activeState.flights];
                        if (maxStops !== null) {
                            sorted = sorted.filter(f => {
                                const segs = f.itineraries?.[0]?.segments || [];
                                return (segs.length > 0 ? segs.length - 1 : 0) <= maxStops;
                            });
                        }
                        sorted.sort((a, b) => compareFlights(a, b, sortBy));

                        if (sorted.length === 0) {
                            if (maxStops === 0 && activeState.flights.length > 0) {
                                return (
                                    <div className="space-y-4">
                                        <div className="glass-panel p-5 rounded-xl border border-sky-500/20 bg-sky-500/5 text-center">
                                            <p className="text-white font-medium text-sm mb-1">
                                                No direct flights found for <strong className="text-sky-300">{activeLeg.fromIata} → {activeLeg.toIata}</strong>
                                            </p>
                                            <p className="text-white/60 text-xs mb-3">
                                                Valid 1-stop and connecting flights are available for this route ({activeState.flights.length} options found).
                                            </p>
                                            <button
                                                onClick={() => setMaxStops(null)}
                                                className="px-4 py-2 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 text-xs font-semibold transition-all shadow-md cursor-pointer"
                                            >
                                                Show All {activeState.flights.length} Available Flights
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-center gap-2 pt-1 border-t border-white/5">
                                            <span className="text-[10px] text-white/30 font-medium">Or compare on external platforms:</span>
                                            <DirectBookingLinks orgCode={activeLeg.fromIata} destCode={activeLeg.toIata} travelDate={activeLeg.date} />
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div className="glass-panel p-5 rounded-xl border border-white/5 text-center">
                                    <Search className="w-7 h-7 text-white/20 mx-auto mb-2" />
                                    <p className="text-white/60 text-sm mb-1">
                                        No commercial flights currently found for <strong className="text-white/80">{activeLeg.fromIata} → {activeLeg.toIata}</strong> on {fmtDisplay(activeLeg.date)}
                                    </p>
                                    <p className="text-white/30 text-xs mb-2">Compare on booking platforms directly:</p>
                                    <DirectBookingLinks orgCode={activeLeg.fromIata} destCode={activeLeg.toIata} travelDate={activeLeg.date} />
                                </div>
                            );
                        }

                        return (
                            <div className="space-y-3">
                                <AnimatePresence mode="popLayout">
                                    {sorted.slice(0, 5).map((flight, fIdx) => (
                                        <motion.div key={flight.id || fIdx}
                                            initial={{ opacity: 0, y: 8 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0 }}
                                            transition={{ duration: 0.15 }}>
                                            <FlightCard flight={flight} />
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                                <div className="flex items-center justify-center gap-2 pt-1 border-t border-white/5">
                                    <span className="text-[10px] text-white/30 font-medium">Compare prices:</span>
                                    <DirectBookingLinks orgCode={activeLeg.fromIata} destCode={activeLeg.toIata} travelDate={activeLeg.date} />
                                </div>
                            </div>
                        );
                    })()}
                </div>
            )}
        </div>
    );
}
