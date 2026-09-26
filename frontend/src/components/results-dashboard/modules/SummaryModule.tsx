"use client";

import { getApiUrl } from '@/utils/api';

import React, { useState, useEffect, useRef } from "react";
import { Sparkles, Share2 } from "lucide-react";
import SkeletonLoader from "../SkeletonLoader";
import { ModuleProps } from "./types";
import { Button } from "@/components/ui/button";

export default function SummaryModule({ tripId }: ModuleProps) {
    const [summary, setSummary] = useState("");
    const [isStreaming, setIsStreaming] = useState(true);
    const [isSummaryLoading, setIsSummaryLoading] = useState(true);
    const [shareCopied, setShareCopied] = useState(false);

    const summaryLoadedRef = useRef(false);

    useEffect(() => {
        if (summaryLoadedRef.current) return;
        summaryLoadedRef.current = true;
        fetchSummary();
    }, [tripId]);

    const fetchSummary = async () => {
        setIsSummaryLoading(true);
        setIsStreaming(true);
        setSummary("");
        try {
            const baseUrl = getApiUrl();
            const response = await fetch(`${baseUrl}/ai/summary?tripId=${encodeURIComponent(tripId)}`);
            if (!response.ok) throw new Error("Failed to fetch summary");

            if (!response.body) {
                throw new Error("Streaming not supported or no body returned");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            setIsSummaryLoading(false);

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
                        if (dataStr === "[DONE]") {
                            break;
                        }
                        try {
                            const parsed = JSON.parse(dataStr);
                            if (parsed.text) {
                                setSummary((prev) => prev + parsed.text);
                            }
                        } catch {
                            // Suppress json parsing errors on partial chunks
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error loading summary stream:", error);
            setSummary("Could not load travel summary. Please ensure backend is running.");
            setIsSummaryLoading(false);
        } finally {
            setIsStreaming(false);
        }
    };

    const handleCopyShareLink = () => {
        if (typeof window !== "undefined") {
            navigator.clipboard.writeText(window.location.href);
            setShareCopied(true);
            setTimeout(() => setShareCopied(false), 2000);
        }
    };

    // Bold (**text**) and custom tab link ([Link Text](tab:tabId)) formatting helper
    const parseInlineFormatting = (text: string): React.ReactNode[] => {
        const parts = text.split(/(\*\*.*?\*\*|\[.*?\]\(tab:.*?\))/g);
        return parts.map((part, index) => {
            if (part.startsWith("**") && part.endsWith("**")) {
                return <strong key={index} className="font-bold text-sky-200">{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith("[") && part.includes("](tab:")) {
                const linkText = part.substring(1, part.indexOf("]"));
                const tabId = part.substring(part.indexOf("](tab:") + 6, part.length - 1);
                return (
                    <button
                        key={index}
                        onClick={() => {
                            window.dispatchEvent(new CustomEvent("switch-tab", { detail: tabId }));
                        }}
                        className="text-amber-400 hover:text-amber-300 font-bold underline inline-flex items-center gap-0.5 mx-1 hover:scale-105 transition-transform bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 rounded-lg border border-amber-500/20"
                    >
                        {linkText}
                    </button>
                );
            }
            return <span key={index}>{part}</span>;
        });
    };

    /** Render a markdown pipe table as a styled HTML table */
    const renderTable = (tableLines: string[], key: string) => {
        const rows = tableLines
            .filter(l => l.trim().startsWith("|"))
            .map(l =>
                l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim())
            );
        if (rows.length < 2) return null;
        const headerRow = rows[0];
        const dataRows = rows.slice(2); // skip separator row (---|---|---)
        return (
            <div key={key} className="overflow-x-auto rounded-xl border border-white/10 my-3">
                <table className="w-full text-sm font-sans">
                    <thead>
                        <tr className="bg-violet-500/20 border-b border-white/10">
                            {headerRow.map((cell, i) => (
                                <th key={i} className="px-4 py-2.5 text-left text-violet-200 font-bold font-syne text-[13px]">
                                    {cell}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {dataRows.map((row, ri) => (
                            <tr key={ri} className={`border-b border-white/5 ${ri % 2 === 0 ? "bg-white/[0.03]" : ""} hover:bg-white/5 transition-colors`}>
                                {row.map((cell, ci) => (
                                    <td key={ci} className="px-4 py-2.5 text-white/85 font-sans leading-relaxed">
                                        {parseInlineFormatting(cell)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    /** Render body lines, detecting pipe table blocks and rendering them as HTML tables */
    const renderBodyLines = (bodyLines: string[], prefix: string): React.ReactNode[] => {
        const result: React.ReactNode[] = [];
        let tableAccum: string[] = [];
        let tableKey = 0;

        const flushTable = () => {
            if (tableAccum.length >= 2) {
                result.push(renderTable(tableAccum, `${prefix}-tbl-${tableKey++}`));
            }
            tableAccum = [];
        };

        bodyLines.forEach((line, i) => {
            if (line.trim().startsWith("|")) {
                tableAccum.push(line);
            } else {
                if (tableAccum.length > 0) flushTable();
                result.push(renderLine(line, i));
            }
        });
        if (tableAccum.length > 0) flushTable();

        return result;
    };

    const renderLine = (line: string, idx: number): React.ReactNode => {
        const trimmed = line.trim();
        if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) {
            return (
                <div key={idx} className="mt-6 mb-3">
                    <h2 className="text-xl font-bold font-syne text-white flex items-center gap-2">
                        <span className="w-1.5 h-5 rounded-full bg-violet-500 inline-block flex-shrink-0" />
                        {parseInlineFormatting(trimmed.slice(3))}
                    </h2>
                </div>
            );
        }
        if (trimmed.startsWith("### ")) {
            return (
                <h3 key={idx} className="text-[15px] font-bold font-syne text-sky-300 mt-4 mb-1.5">
                    {parseInlineFormatting(trimmed.slice(4))}
                </h3>
            );
        }
        if (trimmed.startsWith("#### ")) {
            return (
                <h4 key={idx} className="text-[14px] font-bold font-syne text-sky-400 mt-3 mb-1">
                    {parseInlineFormatting(trimmed.slice(5))}
                </h4>
            );
        }
        if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
            return (
                <ul key={idx} className="list-disc list-inside ml-4 my-1.5 text-white/90 font-sans leading-relaxed">
                    <li>{parseInlineFormatting(trimmed.slice(2))}</li>
                </ul>
            );
        }
        if (trimmed.startsWith("Estimated Total Budget") || trimmed.startsWith("**Estimated Total Budget")) {
            return (
                <p key={idx} className="text-sm font-bold font-syne text-sky-300 mb-3 mt-1">
                    {parseInlineFormatting(trimmed)}
                </p>
            );
        }
        if (/^\d+\.\s/.test(trimmed)) {
            return (
                <ol key={idx} className="list-decimal list-inside ml-4 my-1.5 text-white/90 font-sans leading-relaxed">
                    <li>{parseInlineFormatting(trimmed.replace(/^\d+\.\s/, ""))}</li>
                </ol>
            );
        }
        if (trimmed === "") return <div key={idx} className="h-2" />;
        return <p key={idx} className="my-2.5 text-white/95 font-sans leading-relaxed text-[15px]">{parseInlineFormatting(trimmed)}</p>;
    };

    /**
     * Markdown renderer supporting:
     * ## → section title with violet pill indicator
     * ### / #### → styled sub-headings
     * Pipe tables → rendered as styled HTML tables
     */
    const renderMarkdown = (text: string) => {
        if (!text) return null;
        const lines = text.split("\n");
        return renderBodyLines(lines, "summary");
    };

    if (isSummaryLoading) {
        return <SkeletonLoader type="summary" />;
    }

    return (
        <div className="w-full flex flex-col gap-6 pb-12">
            {/* AI Summary Card */}
            <div className="glass-panel p-6 md:p-8 rounded-2xl border-l-4 border-l-violet-500 shadow-[0_0_20px_rgba(139,92,246,0.15)] relative overflow-hidden group">
                <div className="absolute top-[-30px] right-[-30px] w-24 h-24 bg-violet-600/10 rounded-full blur-2xl pointer-events-none group-hover:bg-violet-600/25 transition-colors duration-500" />

                <div className="flex justify-between items-center mb-6 border-b border-white/10 pb-4">
                    <div className="flex items-center gap-2.5">
                        <div className="p-2 bg-violet-500/20 rounded-xl">
                            <Sparkles className="w-5 h-5 text-violet-400" />
                        </div>
                        <h2 className="text-xl font-bold font-syne text-white">AI Blueprint Synthesis</h2>
                    </div>

                    <Button
                        variant="outline"
                        onClick={handleCopyShareLink}
                        className="text-xs h-9 bg-white/5 border-white/10 text-white/80 hover:bg-violet-500 hover:text-white hover:border-violet-500 flex items-center gap-1.5 transition-all"
                    >
                        <Share2 className="w-3.5 h-3.5" />
                        {shareCopied ? "Copied!" : "Share Link"}
                    </Button>
                </div>

                {/* Streaming indicator */}
                {isStreaming && (
                    <div className="flex items-center gap-2 mb-4 text-violet-400/70 text-sm font-sans">
                        <span className="inline-flex gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                        </span>
                        <span>Generating your personalized blueprint…</span>
                    </div>
                )}

                <div className="text-white/90 space-y-2 prose max-w-none">
                    {renderMarkdown(summary)}
                </div>
            </div>
        </div>
    );
}
