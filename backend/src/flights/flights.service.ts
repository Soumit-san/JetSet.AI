import { Injectable, Inject, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';
import { TripsService } from '../trips/trips.service';
import { AiService } from '../ai/ai.service';
import { normalizeAndHash } from '../common/normalize';

const MAP_TO_AIRLINE: Record<string, string> = {
    "AI": "Air India",
    "6E": "IndiGo",
    "UK": "Vistara",
    "SG": "SpiceJet",
    "QP": "Akasa Air",
    "I5": "AIX Connect",
    "IX": "Air India Express",
    "AA": "American Airlines",
    "DL": "Delta Air Lines",
    "UA": "United Airlines",
    "BA": "British Airways",
    "EK": "Emirates",
    "QR": "Qatar Airways",
    "EY": "Etihad Airways",
    "SQ": "Singapore Airlines",
    "LH": "Lufthansa",
    "AF": "Air France",
    "KL": "KLM",
    "QF": "Qantas",
    "CX": "Cathay Pacific",
    "MH": "Malaysia Airlines",
    "TG": "Thai Airways",
    "JL": "Japan Airlines",
    "NH": "ANA",
    "KE": "Korean Air",
    "NZ": "Air New Zealand",
    "TK": "Turkish Airlines",
    "MS": "EgyptAir",
    "ET": "Ethiopian Airlines",
    "WY": "Oman Air",
    "GF": "Gulf Air",
};

@Injectable()
export class FlightsService {
    private readonly logger = new Logger(FlightsService.name);
    private readonly serpApiBaseUrl = 'https://serpapi.com/search.json';
    private readonly inFlightRequests = new Map<string, Promise<any>>();

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly tripsService: TripsService,
        private readonly aiService: AiService,
    ) { }

    async searchFlights(queryParams: any) {
        const cacheKey = normalizeAndHash('flights_search', queryParams);
        const cachedData = await this.cacheManager.get(cacheKey);
        if (cachedData) {
            this.logger.debug('Returning cached SerpAPI flight search results');
            return cachedData;
        }

        // Deduplicate in-flight requests
        const inFlight = this.inFlightRequests.get(cacheKey);
        if (inFlight) {
            this.logger.debug('Reusing in-flight request for identical flight query');
            return inFlight;
        }

        const promise = (async () => {
            const serpApiKey = this.configService.get<string>('SERPAPI_KEY_FLIGHTS') || this.configService.get<string>('SERPAPI_KEY') || '';
            const depIata = (queryParams.originLocationCode || '').toUpperCase();
            const arrIata = (queryParams.destinationLocationCode || '').toUpperCase();
            const travelDate = queryParams.departureDate || '';
            const currency = queryParams.currencyCode || 'USD';
            const tripId = queryParams.tripId || '';

            if (!depIata || !arrIata) {
                throw new HttpException('Missing origin or destination location code', HttpStatus.BAD_REQUEST);
            }

            if (!serpApiKey) {
                this.logger.warn('SERPAPI_KEY_FLIGHTS is not configured');
                return { data: [], source: 'error', message: 'SerpAPI key not configured.' };
            }

            let tripData: any = null;
            if (tripId) {
                try {
                    tripData = await this.tripsService.getTrip(tripId);
                } catch (err: any) {
                    this.logger.warn(`Could not load trip details for ID ${tripId}: ${err.message}`);
                }
            }

            // 'Any' stops = null (no restriction). Only map to 0 if user explicitly requests direct.
            // IMPORTANT: Do NOT map 'Any' to direct-only. null means no stops restriction.
            const directOnlyRequested = queryParams.directOnly === 'true';
            const maxStopsParam = queryParams.maxStops;
            const maxStopsFilter: number | null =
                directOnlyRequested ? 0
                : (maxStopsParam !== undefined && maxStopsParam !== null && maxStopsParam !== '')
                    ? Number(maxStopsParam)
                    : null; // null = Any = no restriction

            try {
                this.logger.log(`Flight search initiated: ${depIata} → ${arrIata} on ${travelDate} | directOnlyRequested: ${directOnlyRequested} | maxStopsFilter: ${maxStopsFilter ?? 'none (Any)'}`);

                // Build SerpAPI params — never pass a stops restriction unless user explicitly requested direct-only
                const params: Record<string, string> = {
                    engine: 'google_flights',
                    departure_id: depIata,
                    arrival_id: arrIata,
                    outbound_date: travelDate,
                    currency,
                    hl: 'en',
                    type: '2', // one-way
                    api_key: serpApiKey,
                };

                // Only pass stops filter to SerpAPI if the user explicitly requested direct-only
                if (directOnlyRequested) {
                    params['stops'] = '1'; // SerpAPI: 1 = direct only
                }

                let allRawFlights = await this.callSerpApi(params, depIata, arrIata, travelDate);

                // ── Zero-result fallback: retry with alternate hub airports ────────────
                if (allRawFlights.length === 0 && !directOnlyRequested) {
                    const altOrigins = this.getNearbyHubs(depIata);
                    const altDests   = this.getNearbyHubs(arrIata);

                    // Try original dep → each alt dest
                    for (const altArr of altDests) {
                        if (allRawFlights.length > 0) break;
                        this.logger.log(`Zero results for ${depIata}→${arrIata}. Retrying with alt destination: ${altArr}`);
                        const altParams = { ...params, arrival_id: altArr };
                        allRawFlights = await this.callSerpApi(altParams, depIata, altArr, travelDate);
                    }

                    // Try each alt origin → original dest
                    for (const altDep of altOrigins) {
                        if (allRawFlights.length > 0) break;
                        this.logger.log(`Zero results for ${depIata}→${arrIata}. Retrying with alt origin: ${altDep}`);
                        const altParams = { ...params, departure_id: altDep };
                        allRawFlights = await this.callSerpApi(altParams, altDep, arrIata, travelDate);
                    }

                    if (allRawFlights.length === 0) {
                        this.logger.warn(`All fallback searches exhausted — no flights found for ${depIata}→${arrIata} on ${travelDate}.`);
                        return {
                            data: [],
                            source: 'serpapi',
                            message: `No flights found for ${depIata} → ${arrIata} on ${travelDate}. Try booking platforms directly.`,
                        };
                    }
                } else if (allRawFlights.length === 0) {
                    // direct-only with zero results — return empty, don't retry
                    return {
                        data: [],
                        source: 'serpapi',
                        message: `No direct flights found for ${depIata} → ${arrIata} on ${travelDate}. Connecting flights may be available — remove the direct-only filter.`,
                    };
                }

                // Map SerpAPI response to our internal format
                let mappedFlights = allRawFlights.map((entry: any, idx: number) => this.mapSerpApiFlightEntry(entry, idx, depIata, arrIata, travelDate, currency));

                // Apply stops filter ONLY if the user explicitly requested a specific max (not 'Any')
                if (maxStopsFilter !== null) {
                    const preCount = mappedFlights.length;
                    mappedFlights = mappedFlights.filter(f => {
                        const segs = f.itineraries?.[0]?.segments || [];
                        const stops = segs.length > 0 ? segs.length - 1 : 0;
                        return stops <= maxStopsFilter;
                    });
                    this.logger.log(`Stops filter applied (maxStops=${maxStopsFilter}): ${preCount} → ${mappedFlights.length} flights retained.`);

                    // If filtering removes ALL results, return all unfiltered flights with a note
                    if (mappedFlights.length === 0 && preCount > 0) {
                        this.logger.warn(`Stops filter removed all results (maxStops=${maxStopsFilter}). Returning all ${preCount} unfiltered results for client-side display.`);
                        mappedFlights = allRawFlights.map((entry: any, idx: number) => this.mapSerpApiFlightEntry(entry, idx, depIata, arrIata, travelDate, currency));
                    }
                } else {
                    this.logger.log(`All ${mappedFlights.length} flight options retained (stops filter: Any / none)`);
                }

                // Perform backend scoring
                mappedFlights = this.calculateBackendFlightScores(mappedFlights);

                // Apply heuristic AI scoring if trip context is available
                if (tripData) {
                    try {
                        mappedFlights = this.applyHeuristicScores(mappedFlights, tripData);
                    } catch (err: any) {
                        this.logger.warn(`Heuristic scoring failed: ${err.message}`);
                    }
                }

                // Sort by match score descending
                mappedFlights.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

                const result = { data: mappedFlights, source: 'serpapi_google_flights' };
                await this.cacheManager.set(cacheKey, result, 600000); // 10 min cache
                return result;

            } catch (error: any) {
                this.logger.error(`SerpAPI Google Flights search failed: ${error.message}`);
                return {
                    data: [],
                    source: 'error',
                    message: `Could not fetch flights for ${depIata} → ${arrIata}. ${error.message}`,
                };
            }
        })();

        this.inFlightRequests.set(cacheKey, promise);
        try {
            return await promise;
        } finally {
            this.inFlightRequests.delete(cacheKey);
        }
    }

    /**
     * Execute a single SerpAPI Google Flights request and return raw flight entries.
     * Returns an empty array on any error or zero results.
     */
    private async callSerpApi(params: Record<string, string>, depIata: string, arrIata: string, travelDate: string): Promise<any[]> {
        try {
            const response = await firstValueFrom(
                this.httpService.get(this.serpApiBaseUrl, { params, timeout: 20000 })
            );
            const apiData = response.data;
            const all: any[] = [
                ...(apiData.best_flights  || []),
                ...(apiData.other_flights || []),
            ];
            this.logger.log(`SerpAPI [${depIata}→${arrIata} on ${travelDate}]: ${all.length} flights (best=${(apiData.best_flights||[]).length}, other=${(apiData.other_flights||[]).length})`);
            return all;
        } catch (err: any) {
            this.logger.warn(`SerpAPI call failed for ${depIata}→${arrIata}: ${err.message}`);
            return [];
        }
    }

    /**
     * Return known nearby/hub IATA alternatives for a given airport code.
     * Used as fallback when a specific IATA returns zero results from SerpAPI.
     */
    private getNearbyHubs(iata: string): string[] {
        const HUB_MAP: Record<string, string[]> = {
            // India
            'BBI': ['CCU', 'MAA', 'BOM', 'DEL'],
            'CCU': ['BBI', 'BOM', 'DEL'],
            'MAA': ['BOM', 'DEL', 'HYD'],
            'HYD': ['MAA', 'BOM', 'DEL'],
            'BLR': ['BOM', 'MAA', 'DEL'],
            'COK': ['BOM', 'MAA'],
            'IXC': ['DEL', 'ATQ'],
            'ATQ': ['DEL', 'IXC'],
            'JAI': ['DEL', 'BOM'],
            'PNQ': ['BOM', 'DEL'],
            'GOI': ['BOM', 'DEL'],
            // Nepal / Regional
            'KTM': ['DEL', 'CCU', 'BKK'],
            'PKR': ['KTM'],
            // South/SE Asia
            'CMB': ['BOM', 'MAA', 'DEL'],
            'DAC': ['CCU', 'DEL'],
            'BKK': ['SIN', 'KUL', 'HKG'],
            'SIN': ['KUL', 'CGK', 'BKK'],
            'KUL': ['SIN', 'BKK'],
            // Europe
            'LTN': ['LHR', 'LGW', 'STN'],
            'LGW': ['LHR', 'LTN', 'STN'],
            'CDG': ['ORY', 'BVA'],
            'BER': ['HAM', 'MUC', 'FRA'],
            'MXP': ['LIN', 'FCO', 'VCE'],
            // Middle East
            'SHJ': ['DXB', 'AUH'],
            'AUH': ['DXB', 'SHJ'],
            // US
            'EWR': ['JFK', 'LGA'],
            'LGA': ['JFK', 'EWR'],
            'SFO': ['OAK', 'SJC'],
            'OAK': ['SFO', 'SJC'],
        };
        return HUB_MAP[iata] || [];
    }

    /**
     * Maps a single SerpAPI flight entry (which can be a single flight or a multi-leg itinerary)
     * to our internal AmadeusFlight-compatible format.
     */
    private mapSerpApiFlightEntry(entry: any, idx: number, depIata: string, arrIata: string, travelDate: string, currency: string): any {
        const legs: any[] = entry.flights || [];
        const bookingToken: string = entry.booking_token || '';
        const totalDurationMin: number = entry.total_duration || 0;

        // Build segment list from each leg
        const segments = legs.map((leg: any) => {
            const carrierCode = this.extractCarrierCode(leg.airline_logo || '', leg.flight_number || '');
            const airlineName: string = leg.airline || '';
            const flightNumber: string = leg.flight_number || '';

            return {
                departure: {
                    iataCode: leg.departure_airport?.id || depIata,
                    at: leg.departure_airport?.time || `${travelDate}T00:00:00`,
                    name: leg.departure_airport?.name || '',
                },
                arrival: {
                    iataCode: leg.arrival_airport?.id || arrIata,
                    at: leg.arrival_airport?.time || `${travelDate}T00:00:00`,
                    name: leg.arrival_airport?.name || '',
                },
                carrierCode,
                flightNumber,
                airlineName,
                duration: leg.duration || 0,
                operating: { carrierCode },
                airplane: leg.airplane || '',
                travelClass: leg.travel_class || 'Economy',
                legroom: leg.legroom || '',
                overnight: leg.overnight || false,
                carbonEmissions: leg.carbon_emissions?.this_flight || null,
            };
        });

        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];
        const primaryCarrierCode = firstSeg?.carrierCode || '';
        const primaryAirlineName = firstSeg?.airlineName || legs[0]?.airline || MAP_TO_AIRLINE[primaryCarrierCode] || 'Unknown Airline';

        // Build duration ISO string
        const durationIso = totalDurationMin > 0
            ? `PT${Math.floor(totalDurationMin / 60)}H${totalDurationMin % 60}M`
            : this.calculateDuration(firstSeg?.departure?.at || '', lastSeg?.arrival?.at || '');

        // Calculate layover info
        const layovers: any[] = entry.layovers || [];

        // Price from SerpAPI
        const priceRaw: number | null = entry.price ?? null;
        const price = priceRaw !== null ? {
            currency,
            total: priceRaw.toString(),
        } : {
            currency,
            total: null,
        };

        // Build Google Flights redirect URL using booking_token (for step 2 if needed)
        // SerpAPI also provides a direct Google Flights deep-link in some cases
        const googleFlightsUrl = this.buildGoogleFlightsUrl(depIata, arrIata, travelDate, currency);

        const flightId = legs.map((l: any) => l.flight_number || '').join('+') || `SERP-${idx}`;
        const displayFlightNumber = legs.map((l: any) => l.flight_number || '').filter(Boolean).join(' → ') || flightId;

        return {
            id: flightId,
            flightNumber: displayFlightNumber,
            airlineName: primaryAirlineName,
            travelDate,
            flightStatus: 'scheduled',
            bookingToken,
            googleFlightsUrl,
            carbonEmissions: entry.carbon_emissions || null,
            itineraries: [{
                duration: durationIso,
                segments,
                layovers,
            }],
            price,
            extensions: entry.extensions || [],
        };
    }

    /**
     * Fetch booking options for a flight using its booking_token (2nd SerpAPI call).
     * Returns an array of booking provider options with direct URLs.
     */
    async getFlightBookingOptions(bookingToken: string, depIata: string, arrIata: string, outboundDate: string, currency: string) {
        if (!bookingToken) {
            throw new HttpException('Booking token is required', HttpStatus.BAD_REQUEST);
        }

        const cacheKey = `serpapi_booking_${bookingToken.substring(0, 40)}`;
        const cached = await this.cacheManager.get(cacheKey);
        if (cached) return cached;

        const serpApiKey = this.configService.get<string>('SERPAPI_KEY_FLIGHTS') || this.configService.get<string>('SERPAPI_KEY') || '';
        if (!serpApiKey) {
            throw new HttpException('SERPAPI_KEY_FLIGHTS not configured', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        try {
            this.logger.log(`Fetching SerpAPI booking options for token: ${bookingToken.substring(0, 20)}...`);

            const params = {
                engine: 'google_flights',
                departure_id: depIata,
                arrival_id: arrIata,
                outbound_date: outboundDate,
                currency,
                hl: 'en',
                type: '2',
                booking_token: bookingToken,
                api_key: serpApiKey,
            };

            const response = await firstValueFrom(
                this.httpService.get(this.serpApiBaseUrl, { params, timeout: 20000 })
            );

            const bookingOptions = response.data?.booking_options || [];
            this.logger.log(`Got ${bookingOptions.length} booking options`);

            const result = { bookingOptions };
            await this.cacheManager.set(cacheKey, result, 3600000); // 1hr cache
            return result;

        } catch (error: any) {
            this.logger.error(`Booking options fetch failed: ${error.message}`);
            // Fallback to Google Flights direct URL
            return {
                bookingOptions: [{
                    option_title: 'Search on Google Flights',
                    booking_request: {
                        url: this.buildGoogleFlightsUrl(depIata, arrIata, outboundDate, currency),
                    }
                }]
            };
        }
    }

    /**
     * Build a direct Google Flights search URL for a given route and date.
     * This is used as fallback when no booking_token or booking_options available.
     */
    private buildGoogleFlightsUrl(depIata: string, arrIata: string, date: string, currency: string): string {
        // Google Flights URL format
        // https://www.google.com/travel/flights/search?tfs=CBwQAhopEgoyMDI2LTA3LTIwag...
        // Since we can't construct the encrypted tfs param, use the readable search URL:
        const formatted = date ? date : new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        return `https://www.google.com/travel/flights/search?q=Flights+from+${depIata}+to+${arrIata}+on+${formatted}`;
    }

    /**
     * Extract IATA carrier code from SerpAPI flight_number (e.g., "AI 101" → "AI")
     */
    private extractCarrierCode(logoUrl: string, flightNumber: string): string {
        // Try from flight number first: "AI 101" or "6E-5678" 
        if (flightNumber) {
            const match = flightNumber.match(/^([A-Z0-9]{2,3})\s*[-\s]?\d+/);
            if (match) return match[1];
        }
        // Try from logo URL (SerpAPI uses something like ".../2x/AI.png")
        if (logoUrl) {
            const match = logoUrl.match(/\/([A-Z0-9]{2,3})\.png/i);
            if (match) return match[1].toUpperCase();
        }
        return 'XX';
    }

    private calculateDuration(depStr: string, arrStr: string): string {
        try {
            if (!depStr || !arrStr) return 'PT0H0M';
            const dep = new Date(depStr);
            const arr = new Date(arrStr);
            const diffMs = arr.getTime() - dep.getTime();
            if (diffMs <= 0 || isNaN(diffMs)) return 'PT0H0M';
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            return `PT${diffHours}H${diffMins}M`;
        } catch {
            return 'PT0H0M';
        }
    }

    async getFlightStatus(flightIata: string) {
        // With SerpAPI, there's no live flight status endpoint — we return a placeholder
        return { message: `Flight status lookup for ${flightIata} is not supported with the current provider.` };
    }

    private applyHeuristicScores(flights: any[], trip: any): any[] {
        const budget = ((trip?.budget as string) || '').toLowerCase();
        const companions = ((trip?.companions as string) || '').toLowerCase();
        const interests = (trip?.interests as string[]) || [];

        let stayDays = 3;
        if (trip?.fromDate && trip?.toDate) {
            try {
                const d1 = new Date(trip.fromDate);
                const d2 = new Date(trip.toDate);
                const diff = d2.getTime() - d1.getTime();
                stayDays = Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
            } catch { }
        }

        return flights.map((f) => {
            const price = parseFloat(f.price?.total || '500');
            const segments = f.itineraries?.[0]?.segments || [];
            const stops = segments.length > 0 ? segments.length - 1 : 0;

            let score = f.matchScore || 65;
            let reasons: string[] = [];

            if (budget.includes('budget') || budget.includes('low')) {
                if (price < 400) { score += 10; reasons.push('Low-cost flight matching your budget'); }
                else if (price < 700) { score += 5; reasons.push('Affordable pricing'); }
                else { score -= 5; }
            } else if (budget.includes('luxury') || budget.includes('high')) {
                if (stops === 0) { score += 10; reasons.push('Non-stop comfort for luxury travel'); }
            } else {
                if (price < 800) { score += 5; reasons.push('Good value flight'); }
            }

            if (stayDays <= 3 && stops === 0) {
                score += 8;
                reasons.push('Direct flight saves time on short stay');
            }

            if (companions.includes('family') || companions.includes('couple')) {
                if (stops === 0) { score += 8; reasons.push('Non-stop is ideal for traveling with companions'); }
                if (stops >= 2) { score -= 10; reasons.push('Multiple layovers are tiring for groups'); }
            }

            const depHour = new Date(segments[0]?.departure?.at || '').getHours();
            if (!isNaN(depHour) && depHour >= 6 && depHour <= 11) {
                score += 5;
                reasons.push('Morning departure maximizes first-day sightseeing');
            }

            score = Math.max(10, Math.min(100, score));
            const reason = reasons.join(', and ') || f.matchReason || 'Good travel option';
            return { ...f, matchScore: score, matchReason: reason + '.' };
        });
    }

    private calculateBackendFlightScores(flights: any[]): any[] {
        if (!flights || flights.length === 0) return [];

        const parsedFlights = flights.map(f => {
            const price = parseFloat(f.price?.total || '0') || 999;
            const durationStr = f.itineraries?.[0]?.duration || 'PT0H0M';
            const durationMin = this.parseIsoDuration(durationStr) || 180;
            const segments = f.itineraries?.[0]?.segments || [];
            const stops = Math.max(0, segments.length - 1);
            return { flight: f, price, durationMin, stops };
        });

        const prices = parsedFlights.map(pf => pf.price);
        const durations = parsedFlights.map(pf => pf.durationMin);
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const minDuration = Math.min(...durations);
        const maxDuration = Math.max(...durations);

        const scoredFlights = parsedFlights.map(pf => {
            const affordability = maxPrice === minPrice ? 1.0 : 1.0 - (pf.price - minPrice) / (maxPrice - minPrice);
            const convenience = maxDuration === minDuration ? 1.0 : 1.0 - (pf.durationMin - minDuration) / (maxDuration - minDuration);
            const fewerStops = pf.stops === 0 ? 1.0 : pf.stops === 1 ? 0.5 : 0.0;
            const score = 0.4 * affordability + 0.3 * convenience + 0.3 * fewerStops;
            const matchScore = Math.round(75 + score * 24);
            return { ...pf, score, matchScore };
        });

        let cheapestIdx = 0, fastestIdx = 0, bestIdx = 0;
        for (let i = 0; i < scoredFlights.length; i++) {
            if (scoredFlights[i].price < scoredFlights[cheapestIdx].price) cheapestIdx = i;
            if (scoredFlights[i].durationMin < scoredFlights[fastestIdx].durationMin) fastestIdx = i;
            if (scoredFlights[i].score > scoredFlights[bestIdx].score) bestIdx = i;
        }

        return scoredFlights.map((sf, idx) => {
            const tags: string[] = [];
            if (idx === cheapestIdx) tags.push('Cheapest Fare');
            if (idx === fastestIdx) tags.push('Fastest Route');
            if (idx === bestIdx) tags.push('Best Value');

            const durationStr = sf.flight.itineraries?.[0]?.duration?.replace('PT', '').toLowerCase() || '';
            const priceStr = `${sf.flight.price?.currency || 'USD'} ${sf.price.toLocaleString()}`;
            const stopsDesc = sf.stops === 0 ? 'non-stop' : `${sf.stops} stop${sf.stops > 1 ? 's' : ''}`;

            let matchReason = '';
            if (tags.length > 0) {
                matchReason = `${tags.join(' & ')} — ${stopsDesc} route, ${durationStr} total, at ${priceStr}.`;
            } else {
                matchReason = `${stopsDesc} route with ${durationStr} travel time at ${priceStr}.`;
            }

            let finalMatchScore = sf.matchScore;
            if (idx === bestIdx) finalMatchScore = Math.max(98, finalMatchScore);
            else if (idx === cheapestIdx || idx === fastestIdx) finalMatchScore = Math.max(95, finalMatchScore);

            return { ...sf.flight, matchScore: finalMatchScore, matchReason };
        });
    }

    private parseIsoDuration(dur: string): number {
        if (!dur) return 0;
        const timeStr = dur.replace('PT', '');
        let hours = 0, mins = 0;
        const hMatch = timeStr.match(/(\d+)H/);
        const mMatch = timeStr.match(/(\d+)M/);
        if (hMatch) hours = parseInt(hMatch[1]);
        if (mMatch) mins = parseInt(mMatch[1]);
        return hours * 60 + mins;
    }
}
