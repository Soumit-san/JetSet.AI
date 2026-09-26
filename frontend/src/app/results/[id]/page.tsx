import ResultsDashboard from "@/components/results-dashboard/ResultsDashboard";

export default async function ResultsPage({
    params,
    searchParams
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ org?: string; dest?: string; dates?: string; displayDates?: string; curr?: string }>;
}) {
    // 1. Await Next.js 15 dynamic params
    const resolvedParams = await params;
    const resolvedSearch = await searchParams;

    const tripId = resolvedParams.id;
    const org = resolvedSearch.org || "Unknown Origin";
    const dest = resolvedSearch.dest || "Unknown Destination";
    const dates = resolvedSearch.dates || "Dates Unspecified";
    const displayDates = resolvedSearch.displayDates || dates;
    const curr = resolvedSearch.curr || "";

    return (
        <main className="min-h-screen bg-background relative overflow-hidden flex flex-col items-center py-10 px-4 sm:px-6 lg:px-8">
            {/* Background Glow Effects */}
            <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-sky-deep/10 blur-[120px] pointer-events-none" />
            <div className="absolute top-[40%] right-[-10%] w-[30%] h-[30%] rounded-full bg-violet-600/10 blur-[120px] pointer-events-none" />

            <div className="w-full max-w-6xl z-10">
                {/* Dashboard Client Component with Canonical Trip Blueprint Header */}
                <ResultsDashboard tripId={tripId} org={org} dest={dest} dates={dates} displayDates={displayDates} curr={curr} />
            </div>
        </main>
    );
}
