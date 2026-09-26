"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { AnimatePresence, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import Step1Destination from "./Step1Destination";
import Step2Dates from "./Step2Dates";
import Step3Preferences from "./Step3Preferences";
import { Loader2 } from "lucide-react";
import { getApiUrl } from "@/utils/api";
import { formatLocalDateToYMD, formatDisplayDates } from "@/lib/dateUtils";

// Define the form schema
export const tripFormSchema = z.object({
    origin: z.string().min(2, {
        message: "Origin must be at least 2 characters.",
    }),
    destination: z.string().min(2, {
        message: "Destination must be at least 2 characters.",
    }),
    dateRange: z.object({
        from: z.date().optional(),
        to: z.date().optional(),
    }).refine((data) => data.from && data.to, {
        message: "Please select start and end dates.",
    }),
    budget: z.string().min(1, "Please select a budget level"),
    companions: z.string().min(1, "Please select who you are traveling with"),
    interests: z.array(z.string()),
    currency: z.string().optional(),
});

export type TripFormValues = z.infer<typeof tripFormSchema>;

const generatePlaceholderId = () => `trip-${Date.now()}-${Math.random().toString(36).substring(7)}`;

export default function TripWizard() {
    const [step, setStep] = useState(1);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const totalSteps = 3;
    const cardRef = useRef<HTMLDivElement>(null);

    const scrollToWizardTop = () => {
        if (typeof window !== "undefined" && cardRef.current) {
            const yOffset = -100; // Offset to clear the fixed header + add breathing space
            const element = cardRef.current;
            const y = element.getBoundingClientRect().top + window.scrollY + yOffset;
            window.scrollTo({ top: y, behavior: "smooth" });
        }
    };

    // Scroll wizard card to top with header offset on every step change
    useEffect(() => {
        scrollToWizardTop();
    }, [step]);

    const form = useForm<TripFormValues>({
        resolver: zodResolver(tripFormSchema),
        defaultValues: {
            origin: "",
            destination: "",
            dateRange: {
                from: undefined,
                to: undefined,
            },
            budget: "",
            companions: "",
            interests: [],
            currency: "",
        },
        mode: "onChange",
    });

    const router = useRouter();
    const onSubmit = async (data: TripFormValues) => {
        setIsSubmitting(true);
        try {
            const fromDateStr = formatLocalDateToYMD(data.dateRange?.from);
            const toDateStr = formatLocalDateToYMD(data.dateRange?.to);

            const baseUrl = getApiUrl();
            const response = await fetch(`${baseUrl}/trips`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    origin: data.origin,
                    destination: data.destination,
                    fromDate: fromDateStr,
                    toDate: toDateStr,
                    budget: data.budget,
                    companions: data.companions,
                    interests: data.interests,
                    currency: data.currency || "USD",
                }),
            });

            if (!response.ok) {
                throw new Error("Failed to save trip plan to database");
            }

            const savedTrip = await response.json();

            const orgParam = encodeURIComponent(data.origin);
            const destParam = encodeURIComponent(data.destination);

            const displayDates = formatDisplayDates(fromDateStr, toDateStr);

            const exactDates = fromDateStr
                ? `${fromDateStr}${toDateStr ? '_' + toDateStr : ''}`
                : '';

            const displayDatesParam = encodeURIComponent(displayDates);
            const datesParam = encodeURIComponent(exactDates);
            const currParam = (data.currency || "USD") ? `&curr=${data.currency || "USD"}` : '';

            router.push(`/results/${savedTrip.id}?org=${orgParam}&dest=${destParam}&dates=${datesParam}&displayDates=${displayDatesParam}${currParam}`);
        } catch (error) {
            console.error("Submission error:", error);
            alert("Error creating trip blueprint. Please try again.");
            setIsSubmitting(false);
        }
    };

    const [isValidating, setIsValidating] = useState(false);

    const nextStep = async () => {
        // Validate current step before moving
        let fieldsToValidate: (keyof TripFormValues)[] = [];
        if (step === 1) fieldsToValidate = ["origin", "destination"];
        else if (step === 2) fieldsToValidate = ["dateRange", "budget"];
        else if (step === 3) fieldsToValidate = ["companions"];

        const isStepValid = await form.trigger(fieldsToValidate);
        if (!isStepValid) {
            scrollToWizardTop();
            return;
        }

        if (step === 1) {
            setIsValidating(true);
            const origin = form.getValues("origin");
            const destination = form.getValues("destination");
            const baseUrl = getApiUrl();

            try {
                // Validate origin
                const resOrg = await fetch(`${baseUrl}/destinations/search?q=${encodeURIComponent(origin)}`);
                const dataOrg = resOrg.ok ? await resOrg.json() : [];
                if (!Array.isArray(dataOrg) || dataOrg.length === 0) {
                    // Fallback to check if it's a valid place on Earth
                    const validateRes = await fetch(`${baseUrl}/destinations/validate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ location: origin }),
                    });
                    const valData = validateRes.ok ? await validateRes.json() : { isValid: true };
                    if (!valData.isValid) {
                        form.setError("origin", { type: "manual", message: "Origin is not a recognized city/location on Earth. Please select a valid location." });
                        setIsValidating(false);
                        return;
                    }
                    if (valData.resolvedName) {
                        form.setValue("origin", valData.resolvedName, { shouldValidate: true });
                    }
                }

                // Validate destination
                const resDest = await fetch(`${baseUrl}/destinations/search?q=${encodeURIComponent(destination)}`);
                const dataDest = resDest.ok ? await resDest.json() : [];
                if (!Array.isArray(dataDest) || dataDest.length === 0) {
                    // Fallback to check if it's a valid place on Earth
                    const validateRes = await fetch(`${baseUrl}/destinations/validate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ location: destination }),
                    });
                    const valData = validateRes.ok ? await validateRes.json() : { isValid: true };
                    if (!valData.isValid) {
                        form.setError("destination", { type: "manual", message: "Destination is not a recognized city/location on Earth. Please select a valid location." });
                        setIsValidating(false);
                        return;
                    }
                    if (valData.resolvedName) {
                        form.setValue("destination", valData.resolvedName, { shouldValidate: true });
                    }
                }
            } catch (err) {
                console.error("Geocoding validation error:", err);
            } finally {
                setIsValidating(false);
            }
        }

        setStep((prev) => Math.min(prev + 1, totalSteps));
    };

    const prevStep = () => {
        setStep((prev) => Math.max(prev - 1, 1));
    };

    return (
        <div ref={cardRef} className="w-full max-w-2xl mx-auto glass-panel rounded-2xl p-6 md:p-10 relative">
            {/* Progress Bar — own overflow-hidden so it stays inside rounded corners */}
            <div className="absolute top-0 left-0 w-full h-1 rounded-t-2xl overflow-hidden bg-white/10">
                <div
                    className="h-full bg-sky-glow transition-all duration-500 ease-in-out"
                    style={{ width: `${(step / totalSteps) * 100}%` }}
                />
            </div>

            <div className="text-center mb-8">
                <h2 className="text-3xl font-display text-white mb-2">Plan Your Next Escape</h2>
                <p className="text-sky-vivid/80 font-mono text-sm uppercase tracking-widest">
                    Step {step} of {totalSteps}
                </p>
            </div>

            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <div className="relative min-h-[360px] overflow-visible">
                        <AnimatePresence mode="wait">
                            {step === 1 && (
                                <motion.div
                                    key="step1"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    transition={{ duration: 0.3 }}
                                >
                                    <Step1Destination form={form} />
                                </motion.div>
                            )}
                            {step === 2 && (
                                <motion.div
                                    key="step2"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    transition={{ duration: 0.3 }}
                                >
                                    <Step2Dates form={form} />
                                </motion.div>
                            )}
                            {step === 3 && (
                                <motion.div
                                    key="step3"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    transition={{ duration: 0.3 }}
                                >
                                    <Step3Preferences form={form} />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    <div className="flex justify-between mt-8 pt-6 border-t border-white/10">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={prevStep}
                            disabled={isSubmitting || isValidating}
                            className={`text-white/70 hover:text-white hover:bg-white/10 ${step === 1 ? "invisible" : ""
                                }`}
                        >
                            Back
                        </Button>

                        {step < totalSteps ? (
                            <Button
                                type="button"
                                onClick={nextStep}
                                disabled={isSubmitting || isValidating}
                                className="bg-sky-pure hover:bg-sky-deep text-white shadow-[0_0_15px_rgba(96,165,250,0.5)] transition-all flex items-center gap-2"
                            >
                                {isValidating && <Loader2 className="w-4 h-4 animate-spin" />}
                                {isValidating ? "Verifying..." : "Continue"}
                            </Button>
                        ) : (
                            <Button
                                type="submit"
                                disabled={isSubmitting}
                                className="bg-emerald-500 hover:bg-emerald-600 text-white shadow-[0_0_15px_rgba(16,185,129,0.5)] transition-all flex items-center gap-2"
                            >
                                {isSubmitting ? "Generating Blueprint..." : "Find My Trip"}
                            </Button>
                        )}
                    </div>
                </form>
            </Form>
        </div>
    );
}
