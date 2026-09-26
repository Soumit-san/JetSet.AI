"use client";

import { useState, useEffect, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plane, Hotel, CloudSun, Map, Sparkles, AlertTriangle, Pencil, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// Modules
import FlightsModule from "./modules/FlightsModule";
import HotelsModule from "./modules/HotelsModule";
import SeasonModule from "./modules/SeasonModule";
import ItineraryModule from "./modules/ItineraryModule";
import SummaryModule from "./modules/SummaryModule";
import { getApiUrl } from "@/utils/api";
import { useCopilotStore } from "@/store/copilotStore";
import { formatDisplayDates } from "@/lib/dateUtils";

interface ResultsDashboardProps {
    tripId: string;
    org?: string;
    dest?: string;
    dates?: string;
    displayDates?: string;
    curr?: string;
}

const TABS = [
    { id: "summary", label: "AI Summary", icon: Sparkles, color: "text-violet-400" },
    { id: "flights", label: "Flights", icon: Plane, color: "text-sky-vivid" },
    { id: "hotels", label: "Stays", icon: Hotel, color: "text-emerald-400" },
    { id: "season", label: "When to Go", icon: CloudSun, color: "text-amber-400" },
    { id: "itinerary", label: "Itinerary", icon: Map, color: "text-cyan-400" },
];

export default function ResultsDashboard({ tripId, org, dest, dates, displayDates, curr }: ResultsDashboardProps) {
    const [activeTab, setActiveTab] = useState("summary");
    const [visitedTabs, setVisitedTabs] = useState<string[]>(["summary"]);
    
    const { setActiveView, setTripId } = useCopilotStore();

    // Canonical Trip State (Single Source of Truth)
    const [tripState, setTripState] = useState({
        origin: org || "",
        destination: dest || "",
        fromDate: "",
        toDate: "",
        dates: dates || "",
        displayDates: displayDates || dates || "",
    });

    // Version counters for invalidating and refetching modules
    const [flightsVersion, setFlightsVersion] = useState(0);
    const [hotelsVersion, setHotelsVersion] = useState(0);
    const [itineraryVersion, setItineraryVersion] = useState(0);
    const [summaryVersion, setSummaryVersion] = useState(0);
    const [seasonVersion, setSeasonVersion] = useState(0);

    // Manual Edit Modal State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editOrigin, setEditOrigin] = useState("");
    const [editDest, setEditDest] = useState("");
    const [editFromDate, setEditFromDate] = useState("");
    const [editToDate, setEditToDate] = useState("");
    const [isUpdating, setIsUpdating] = useState(false);

    useEffect(() => {
        setActiveView(activeTab);
    }, [activeTab, setActiveView]);

    useEffect(() => {
        if (tripId) setTripId(tripId);
    }, [tripId, setTripId]);

    // Fetch initial canonical trip details from database
    useEffect(() => {
        if (!tripId) return;
        const baseUrl = getApiUrl();
        fetch(`${baseUrl}/trips/${tripId}`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data) {
                    const disp = formatDisplayDates(data.fromDate, data.toDate) || data.fromDate;
                    setTripState(prev => ({
                        origin: data.origin || prev.origin,
                        destination: data.destination || prev.destination,
                        fromDate: data.fromDate || prev.fromDate,
                        toDate: data.toDate || prev.toDate,
                        dates: data.fromDate && data.toDate ? `${data.fromDate} to ${data.toDate}` : prev.dates,
                        displayDates: disp || prev.displayDates,
                    }));
                }
            })
            .catch(err => console.error("Error loading initial trip data:", err));
    }, [tripId]);

    // Sync modal fields when opening
    useEffect(() => {
        if (isEditModalOpen) {
            setEditOrigin(tripState.origin);
            setEditDest(tripState.destination);
            setEditFromDate(tripState.fromDate);
            setEditToDate(tripState.toDate);
        }
    }, [isEditModalOpen, tripState]);

    // Canonical Trip Update Applier (used by both Manual UI and Tuffy Copilot)
    const applyCanonicalTripUpdate = useCallback((updated: any) => {
        setTripState(prev => {
            const newOrigin = updated.origin !== undefined && updated.origin !== null ? updated.origin : prev.origin;
            const newDest = updated.destination !== undefined && updated.destination !== null ? updated.destination : prev.destination;
            const newFrom = updated.fromDate !== undefined && updated.fromDate !== null ? updated.fromDate : prev.fromDate;
            const newTo = updated.toDate !== undefined && updated.toDate !== null ? updated.toDate : prev.toDate;
            const newDisp = formatDisplayDates(newFrom, newTo) || updated.displayDates || prev.displayDates;
            const newDates = newFrom && newTo ? `${newFrom} to ${newTo}` : prev.dates;

            const datesChanged = (updated.fromDate && updated.fromDate !== prev.fromDate) || (updated.toDate && updated.toDate !== prev.toDate);
            const destChanged = updated.destination && updated.destination.toLowerCase() !== prev.destination.toLowerCase();
            const orgChanged = updated.origin && updated.origin !== prev.origin;

            if (datesChanged || destChanged || orgChanged) {
                setFlightsVersion(v => v + 1);
            }
            if (datesChanged || destChanged || updated.budget || updated.companions) {
                setHotelsVersion(v => v + 1);
            }
            if (datesChanged || destChanged || orgChanged) {
                setItineraryVersion(v => v + 1);
            }
            if (destChanged || datesChanged) {
                setSummaryVersion(v => v + 1);
            }
            if (destChanged) {
                setSeasonVersion(v => v + 1);
            }

            return {
                origin: newOrigin,
                destination: newDest,
                fromDate: newFrom,
                toDate: newTo,
                dates: newDates,
                displayDates: newDisp,
            };
        });
    }, []);

    // Manual Save Handler (Calls canonical PATCH /trips/:id)
    const handleSaveTripManual = async () => {
        if (!tripId) return;
        setIsUpdating(true);
        try {
            const baseUrl = getApiUrl();
            const payload: any = {};
            if (editOrigin.trim() && editOrigin.trim() !== tripState.origin) payload.origin = editOrigin.trim();
            if (editDest.trim() && editDest.trim() !== tripState.destination) payload.destination = editDest.trim();
            if (editFromDate && editFromDate !== tripState.fromDate) payload.fromDate = editFromDate;
            if (editToDate && editToDate !== tripState.toDate) payload.toDate = editToDate;

            const res = await fetch(`${baseUrl}/trips/${tripId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!res.ok) throw new Error("Failed to update trip");
            const data = await res.json();
            const updated = data.trip || data;

            applyCanonicalTripUpdate(updated);
            window.dispatchEvent(new CustomEvent("copilot-trip-updated", { detail: updated }));
            setIsEditModalOpen(false);
        } catch (err) {
            console.error("Error saving trip updates:", err);
        } finally {
            setIsUpdating(false);
        }
    };

    // Warning Modal State
    const [warning, setWarning] = useState<{ title: string; message: string } | null>(null);
    const [showWarningModal, setShowWarningModal] = useState(false);

    useEffect(() => {
        if (tripId) {
            const baseUrl = getApiUrl();
            fetch(`${baseUrl}/trips/${tripId}/warning`)
                .then(res => res.ok ? res.json() : null)
                .then(data => {
                    if (data && (data.isSensitive || data.isOffSeason) && data.warningTitle) {
                        setWarning({ title: data.warningTitle, message: data.warningMessage });
                        setShowWarningModal(true);
                    }
                })
                .catch(err => console.error("Error loading destination warning:", err));
        }
    }, [tripId, tripState.destination]);

    useEffect(() => {
        // Pre-fetch all other tabs in the background 100ms after initial mount
        const timer = setTimeout(() => {
            setVisitedTabs(["summary", "flights", "hotels", "season", "itinerary"]);
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        const handleSwitchTab = (e: Event) => {
            const customEvent = e as CustomEvent;
            const targetTab = customEvent.detail;
            if (targetTab && TABS.some(t => t.id === targetTab)) {
                setActiveTab(targetTab);
                if (!visitedTabs.includes(targetTab)) {
                    setVisitedTabs((prev) => [...prev, targetTab]);
                }
            }
        };
        window.addEventListener("switch-tab", handleSwitchTab);
        return () => window.removeEventListener("switch-tab", handleSwitchTab);
    }, [visitedTabs]);

    // Synchronize with Copilot mutations
    useEffect(() => {
        const handleTripUpdated = (e: Event) => {
            const detail = (e as CustomEvent).detail || {};
            applyCanonicalTripUpdate(detail);
        };

        window.addEventListener("copilot-trip-updated", handleTripUpdated);
        window.addEventListener("copilot-modify-trip", handleTripUpdated);
        return () => {
            window.removeEventListener("copilot-trip-updated", handleTripUpdated);
            window.removeEventListener("copilot-modify-trip", handleTripUpdated);
        };
    }, [applyCanonicalTripUpdate]);

    return (
        <div className="w-full flex flex-col items-center relative">
            {/* Canonical Trip Blueprint Header */}
            <div className="w-full flex flex-col md:flex-row md:items-end justify-between gap-4 glass-panel p-6 md:p-8 rounded-2xl mb-8">
                <div>
                    <h1 className="text-3xl md:text-5xl font-display font-bold text-white tracking-tight select-none">
                        Your <span className="text-sky-vivid">Trip Blueprint</span>
                    </h1>
                    <p className="text-white/70 mt-2 font-sans flex items-center gap-2">
                        <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
                        AI is finalizing the smartest routes and best deals.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                    <div className="text-right">
                        <p className="text-white/50 text-xs font-mono uppercase tracking-wider">Origin</p>
                        <p className="text-white font-medium text-lg">{tripState.origin || org || "—"}</p>
                    </div>
                    <div className="w-px h-8 bg-white/10 hidden sm:block" />
                    <div className="text-center">
                        <p className="text-white/50 text-xs font-mono uppercase tracking-wider">Destination</p>
                        <p className="text-white font-medium text-lg">{tripState.destination || dest || "—"}</p>
                    </div>
                    <div className="w-px h-8 bg-white/10 hidden sm:block" />
                    <div className="text-left">
                        <p className="text-white/50 text-xs font-mono uppercase tracking-wider">Dates</p>
                        <p className="text-white font-medium text-lg">{tripState.displayDates || displayDates || dates || "—"}</p>
                    </div>

                    {/* User-facing Edit Trip button */}
                    <button
                        onClick={() => setIsEditModalOpen(true)}
                        className="ml-2 flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 active:scale-95 text-white/90 hover:text-white transition-all text-xs font-semibold border border-white/10 shadow-sm cursor-pointer"
                        title="Edit Origin, Destination, or Dates"
                    >
                        <Pencil className="w-3.5 h-3.5 text-sky-400" />
                        <span>Edit Trip</span>
                    </button>
                </div>
            </div>

            <Tabs
                value={activeTab}
                onValueChange={(v) => {
                    setActiveTab(v);
                    if (!visitedTabs.includes(v)) {
                        setVisitedTabs((prev) => [...prev, v]);
                    }
                }}
                className="w-full relative"
            >
                <div className="sticky top-4 z-50 overflow-x-auto pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
                    <TabsList className="glass-panel h-16 w-full max-w-fit mx-auto bg-ink-900/40 border-white/10 p-2 rounded-2xl flex gap-2">
                        {TABS.map((tab) => {
                            const Icon = tab.icon;
                            const isActive = activeTab === tab.id;
                            return (
                                <TabsTrigger
                                    key={tab.id}
                                    value={tab.id}
                                    className={`
                                        h-full rounded-xl px-4 md:px-6 transition-all duration-300 data-[state=active]:bg-white/10 data-[state=active]:text-white data-[state=active]:shadow-lg
                                        text-white/60 hover:text-white/80 border border-transparent data-[state=active]:border-white/10 relative overflow-hidden group
                                        cursor-pointer
                                    `}
                                >
                                    <div className="flex items-center gap-2 md:gap-3 z-10 relative">
                                        <Icon className={`w-5 h-5 transition-colors ${isActive ? tab.color : 'group-hover:text-white'}`} />
                                        <span className={`font-medium hidden sm:block ${isActive ? 'text-white' : ''}`}>
                                            {tab.label}
                                        </span>
                                    </div>

                                    {isActive && (
                                        <motion.div
                                            layoutId="activeTabGlow"
                                            className="absolute inset-0 bg-white/5 z-0"
                                            initial={false}
                                            transition={{ type: "spring", stiffness: 300, damping: 30 }}
                                        />
                                    )}
                                </TabsTrigger>
                            );
                        })}
                    </TabsList>
                </div>

                {/* All panels are lazy-mounted when visited and keyed canonically so changes propagate */}
                <div className="mt-8 relative min-h-[500px]">
                    {TABS.map((tab) => (
                        <div
                            key={tab.id}
                            style={{
                                display: activeTab === tab.id ? "block" : "none",
                            }}
                        >
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.25 }}
                            >
                                {tab.id === "summary" && visitedTabs.includes("summary") && (
                                    <SummaryModule 
                                        key={`summary-${tripState.destination}-${tripState.fromDate}-${tripState.toDate}-${summaryVersion}`} 
                                        tripId={tripId} 
                                    />
                                )}
                                {tab.id === "flights" && visitedTabs.includes("flights") && (
                                    <FlightsModule 
                                        key={`flights-${tripState.origin}-${tripState.destination}-${tripState.fromDate}-${tripState.toDate}-${flightsVersion}`} 
                                        tripId={tripId} 
                                        org={tripState.origin} 
                                        dest={tripState.destination} 
                                        dates={tripState.dates} 
                                        curr={curr} 
                                    />
                                )}
                                {tab.id === "hotels" && visitedTabs.includes("hotels") && (
                                    <HotelsModule 
                                        key={`hotels-${tripState.destination}-${tripState.fromDate}-${tripState.toDate}-${hotelsVersion}`} 
                                        tripId={tripId} 
                                        dest={tripState.destination} 
                                        dates={tripState.dates} 
                                        curr={curr} 
                                    />
                                )}
                                {tab.id === "season" && visitedTabs.includes("season") && (
                                    <SeasonModule 
                                        key={`season-${tripState.destination}-${seasonVersion}`} 
                                        tripId={tripId} 
                                        dest={tripState.destination} 
                                    />
                                )}
                                {tab.id === "itinerary" && visitedTabs.includes("itinerary") && (
                                    <ItineraryModule 
                                        key={`itinerary-${tripState.origin}-${tripState.destination}-${tripState.fromDate}-${tripState.toDate}-${itineraryVersion}`} 
                                        tripId={tripId} 
                                        org={tripState.origin} 
                                        dest={tripState.destination} 
                                        dates={tripState.dates} 
                                    />
                                )}
                            </motion.div>
                        </div>
                    ))}
                </div>
            </Tabs>

            {/* Custom Origin / Destination / Dates Edit Modal */}
            <AnimatePresence>
                {isEditModalOpen && (
                    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => !isUpdating && setIsEditModalOpen(false)}
                            className="absolute inset-0 bg-ink-950/80 backdrop-blur-md"
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 15 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 15 }}
                            className="relative w-full max-w-lg overflow-hidden glass-panel border border-white/15 bg-ink-900/95 rounded-3xl p-6 sm:p-8 shadow-[0_25px_60px_rgba(0,0,0,0.5)] flex flex-col gap-6"
                        >
                            <div className="flex items-center justify-between pb-3 border-b border-white/10">
                                <div>
                                    <h2 className="text-xl font-bold font-display text-white">Edit Trip Parameters</h2>
                                    <p className="text-xs text-white/60 mt-0.5">Update origin, destination, or travel dates</p>
                                </div>
                                <button
                                    onClick={() => !isUpdating && setIsEditModalOpen(false)}
                                    disabled={isUpdating}
                                    className="text-white/40 hover:text-white transition-colors p-1"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            <div className="space-y-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-mono uppercase text-white/50 mb-1.5">Origin City</label>
                                        <input
                                            type="text"
                                            value={editOrigin}
                                            onChange={(e) => setEditOrigin(e.target.value)}
                                            placeholder="e.g. Coimbatore, Bengaluru"
                                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 text-sm focus:outline-none focus:border-sky-500 transition-colors"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-mono uppercase text-white/50 mb-1.5">Destination City</label>
                                        <input
                                            type="text"
                                            value={editDest}
                                            onChange={(e) => setEditDest(e.target.value)}
                                            placeholder="e.g. Lima, Cusco"
                                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 text-sm focus:outline-none focus:border-sky-500 transition-colors"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-mono uppercase text-white/50 mb-1.5">Departure Date</label>
                                        <input
                                            type="date"
                                            value={editFromDate}
                                            onChange={(e) => setEditFromDate(e.target.value)}
                                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white text-sm focus:outline-none focus:border-sky-500 transition-colors [color-scheme:dark]"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-mono uppercase text-white/50 mb-1.5">Return Date</label>
                                        <input
                                            type="date"
                                            value={editToDate}
                                            onChange={(e) => setEditToDate(e.target.value)}
                                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white text-sm focus:outline-none focus:border-sky-500 transition-colors [color-scheme:dark]"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="flex gap-3 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setIsEditModalOpen(false)}
                                    disabled={isUpdating}
                                    className="flex-1 py-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 hover:text-white font-medium text-sm transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSaveTripManual}
                                    disabled={isUpdating}
                                    className="flex-1 py-3 rounded-xl bg-sky-500 hover:bg-sky-600 active:scale-98 text-ink-950 font-bold text-sm tracking-wide transition-all shadow-[0_0_20px_rgba(14,165,233,0.3)] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                                >
                                    {isUpdating ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            <span>Updating...</span>
                                        </>
                                    ) : (
                                        <span>Save & Update Trip</span>
                                    )}
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* Restricted Access / Seasonal Warning Modal with Blurred Background */}
            <AnimatePresence>
                {showWarningModal && warning && (
                    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
                        {/* Blur Backdrop */}
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-ink-950/70 backdrop-blur-md"
                        />
                        {/* Modal Box */}
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, y: 20 }}
                            className="relative w-full max-w-lg overflow-hidden glass-panel border border-amber-500/30 bg-ink-900/90 rounded-3xl p-8 shadow-[0_20px_50px_rgba(245,158,11,0.15)] flex flex-col items-center text-center gap-6"
                        >
                            {/* Animated Alert Icon */}
                            <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center animate-pulse">
                                <AlertTriangle className="w-8 h-8 text-amber-400" />
                            </div>

                            <div className="space-y-2">
                                <h3 className="text-xl font-bold font-display text-amber-300 leading-tight">
                                    {warning.title}
                                </h3>
                                <p className="text-sm text-white/70 leading-relaxed font-sans">
                                    {warning.message}
                                </p>
                            </div>

                            <button
                                onClick={() => setShowWarningModal(false)}
                                className="w-full py-3.5 rounded-xl bg-amber-500 hover:bg-amber-600 active:scale-[0.98] text-ink-950 font-bold text-sm tracking-wide transition-all shadow-[0_0_20px_rgba(245,158,11,0.3)] cursor-pointer"
                            >
                                OK, I Understand
                            </button>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
}
