"use client";

import { useState, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plane, Hotel, CloudSun, Map, Sparkles, Bot, MessageSquare, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// Modules
import FlightsModule from "./modules/FlightsModule";
import HotelsModule from "./modules/HotelsModule";
import SeasonModule from "./modules/SeasonModule";
import ItineraryModule from "./modules/ItineraryModule";
import SummaryModule from "./modules/SummaryModule";
import { getApiUrl } from "@/utils/api";
import { useCopilotStore } from "@/store/copilotStore";

interface ResultsDashboardProps {
    tripId: string;
    org?: string;
    dest?: string;
    dates?: string;
    curr?: string;
}

const TABS = [
    { id: "summary", label: "AI Summary", icon: Sparkles, color: "text-violet-400" },
    { id: "flights", label: "Flights", icon: Plane, color: "text-sky-vivid" },
    { id: "hotels", label: "Stays", icon: Hotel, color: "text-emerald-400" },
    { id: "season", label: "When to Go", icon: CloudSun, color: "text-amber-400" },
    { id: "itinerary", label: "Itinerary", icon: Map, color: "text-cyan-400" },
];

export default function ResultsDashboard({ tripId, org, dest, dates, curr }: ResultsDashboardProps) {
    const [activeTab, setActiveTab] = useState("summary");
    const [visitedTabs, setVisitedTabs] = useState<string[]>(["summary"]);
    const [showScrollBtn, setShowScrollBtn] = useState(false);
    
    const { setActiveView } = useCopilotStore();

    useEffect(() => {
        setActiveView(activeTab);
    }, [activeTab, setActiveView]);

    // Warning Modal State
    const [warning, setWarning] = useState<{ title: string; message: string } | null>(null);
    const [showWarningModal, setShowWarningModal] = useState(false);

    useEffect(() => {
        const handleScroll = () => {
            if (window.scrollY > 300) {
                setShowScrollBtn(true);
            } else {
                setShowScrollBtn(false);
            }
        };
        window.addEventListener("scroll", handleScroll);

        // Fetch safety/restricted-access warning from the backend
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

        return () => window.removeEventListener("scroll", handleScroll);
    }, [tripId]);

    const handleScrollToChat = () => {
        if (activeTab !== "summary") {
            setActiveTab("summary");
            if (!visitedTabs.includes("summary")) {
                setVisitedTabs((prev) => [...prev, "summary"]);
            }
        }
        setTimeout(() => {
            const chatEl = document.getElementById("copilot-chat-section");
            if (chatEl) {
                chatEl.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }, 100);
    };

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

    return (
        <div className="w-full flex justify-center relative">
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

                {/*
                    All panels are lazy-mounted when visited for the first time so we stagger
                    requests. Once visited, they are shown/hidden via CSS display (block/none)
                    to preserve filter state.
                */}
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
                                {tab.id === "summary" && visitedTabs.includes("summary") && <SummaryModule tripId={tripId} />}
                                {tab.id === "flights" && visitedTabs.includes("flights") && <FlightsModule tripId={tripId} org={org} dest={dest} dates={dates} curr={curr} />}
                                {tab.id === "hotels" && visitedTabs.includes("hotels") && <HotelsModule tripId={tripId} dest={dest} dates={dates} curr={curr} />}
                                {tab.id === "season" && visitedTabs.includes("season") && <SeasonModule tripId={tripId} dest={dest} />}
                                {tab.id === "itinerary" && visitedTabs.includes("itinerary") && <ItineraryModule tripId={tripId} org={org} dest={dest} dates={dates} />}
                            </motion.div>
                        </div>
                    ))}
                </div>
            </Tabs>

            {/* Floating Chat Co-Pilot trigger */}
            <AnimatePresence>
                {showScrollBtn && (
                    <motion.button
                        initial={{ opacity: 0, scale: 0.85, y: 15 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.85, y: 15 }}
                        onClick={handleScrollToChat}
                        className="fixed bottom-6 right-6 z-[999] flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-full shadow-[0_8px_32px_rgba(139,92,246,0.35)] border border-violet-500/20 active:scale-95 transition-all duration-300 group cursor-pointer"
                        title="Scroll down to Chat Co-Pilot"
                    >
                        <div className="relative flex items-center justify-center">
                            <Bot className="w-5 h-5 group-hover:rotate-12 transition-transform duration-300" />
                            <span className="absolute top-[-2px] right-[-2px] w-2 h-2 bg-emerald-400 rounded-full border border-indigo-600 animate-pulse" />
                        </div>
                        <span className="text-sm font-semibold tracking-wide font-display pr-1">Ask Co-Pilot</span>
                    </motion.button>
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

