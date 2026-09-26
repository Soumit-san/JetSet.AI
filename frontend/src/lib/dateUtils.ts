const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Format a local Date object to YYYY-MM-DD string without UTC shift.
 */
export function formatLocalDateToYMD(date?: Date | null): string {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/**
 * Parse a YYYY-MM-DD string into year, month (1-indexed), day without timezone shifting.
 */
export function parseYMD(ymd?: string | null): { year: number; month: number; day: number } | null {
    if (!ymd || typeof ymd !== "string") return null;
    const clean = ymd.trim().split("T")[0];
    const parts = clean.split("-");
    if (parts.length < 3) return null;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
}

/**
 * Format date range for UI display (e.g. "Dec 24 – Jan 2" or "Jan 10 – 15").
 * Pure calendar component formatting: 100% immune to browser timezone offsets.
 */
export function formatDisplayDates(from?: string | null, to?: string | null): string {
    const p1 = parseYMD(from);
    const p2 = parseYMD(to);
    if (p1 && p2) {
        const m1 = MONTH_NAMES_SHORT[p1.month - 1];
        const m2 = MONTH_NAMES_SHORT[p2.month - 1];
        if (m1 === m2) {
            return `${m1} ${p1.day} – ${p2.day}`;
        }
        return `${m1} ${p1.day} – ${m2} ${p2.day}`;
    }
    if (p1) {
        return `${MONTH_NAMES_SHORT[p1.month - 1]} ${p1.day}`;
    }
    if (p2) {
        return `${MONTH_NAMES_SHORT[p2.month - 1]} ${p2.day}`;
    }
    return from && to ? `${from} – ${to}` : from || to || "";
}

/**
 * Format a single YYYY-MM-DD date for display (e.g. "24 Dec" or "Dec 24").
 */
export function formatSingleDisplayDate(iso?: string | null, format: "day-month" | "month-day" = "day-month"): string {
    if (!iso) return "";
    const p = parseYMD(iso);
    if (!p) return iso;
    const monthName = MONTH_NAMES_SHORT[p.month - 1];
    return format === "day-month" ? `${p.day} ${monthName}` : `${monthName} ${p.day}`;
}
