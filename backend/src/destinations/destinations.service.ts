import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';
import { OpenRouterService } from '../openrouter/openrouter.service';

@Injectable()
export class DestinationsService {
    private readonly logger = new Logger(DestinationsService.name);
    private readonly airportMappingsPath = path.join(process.cwd(), 'data', 'airport_mappings_cache.json');

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
        private readonly openRouterService: OpenRouterService,
    ) { }

    private ensureCacheFileExists() {
        const dir = path.dirname(this.airportMappingsPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.airportMappingsPath)) {
            fs.writeFileSync(this.airportMappingsPath, JSON.stringify({}), 'utf-8');
        }
    }

    private readCache(): Record<string, string> {
        try {
            this.ensureCacheFileExists();
            const data = fs.readFileSync(this.airportMappingsPath, 'utf-8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    }

    private writeCache(key: string, value: string) {
        try {
            this.ensureCacheFileExists();
            const cache = this.readCache();
            cache[key.toUpperCase()] = value.toUpperCase();
            fs.writeFileSync(this.airportMappingsPath, JSON.stringify(cache, null, 2), 'utf-8');
        } catch (err: any) {
            this.logger.error(`Failed to write airport mappings cache: ${err.message}`);
        }
    }

    private getStaticIataCode(location: string): string | null {
        if (!location) return null;
        const cleanLocation = location.trim().toLowerCase();
        
        // If it's already a 3-letter airport code format (e.g. LHR)
        if (cleanLocation.length === 3 && /^[a-z]{3}$/.test(cleanLocation)) {
            return cleanLocation.toUpperCase();
        }

        const staticMap: Record<string, string> = {
            // US & Americas
            "new york": "JFK", "los angeles": "LAX", "chicago": "ORD", "miami": "MIA", "san francisco": "SFO",
            "dallas": "DFW", "houston": "IAH", "texas": "DFW", "austin": "AUS", "san antonio": "SAT",
            "seattle": "SEA", "denver": "DEN", "boston": "BOS", "atlanta": "ATL", "phoenix": "PHX",
            "las vegas": "LAS", "orlando": "MCO", "washington": "IAD", "minneapolis": "MSP",
            "toronto": "YYZ", "vancouver": "YVR", "mexico city": "MEX", "sao paulo": "GRU",
            "rio de janeiro": "GIG", "buenos aires": "EZE", "lima": "LIM", "bogota": "BOG", "santiago": "SCL",
            "cancun": "CUN", "honolulu": "HNL", "detroit": "DTW", "philadelphia": "PHL", "charlotte": "CLT",
            "salt lake city": "SLC",
            // Europe
            "london": "LHR", "paris": "CDG", "frankfurt": "FRA", "amsterdam": "AMS", "rome": "FCO",
            "madrid": "MAD", "barcelona": "BCN", "berlin": "BER", "munich": "MUC", "zurich": "ZRH",
            "manchester": "MAN", "birmingham": "BHX", "edinburgh": "EDI", "glasgow": "GLA", "dublin": "DUB",
            "nice": "NCE", "lyon": "LYS", "marseille": "MRS", "milan": "MXP", "venice": "VCE",
            "florence": "FLR", "naples": "NAP", "vienna": "VIE", "brussels": "BRU", "geneva": "GVA",
            "prague": "PRG", "budapest": "BUD", "lisbon": "LIS", "porto": "OPO", "athens": "ATH",
            "hamburg": "HAM", "dusseldorf": "DUS", "stuttgart": "STR", "copenhagen": "CPH", "stockholm": "ARN",
            "oslo": "OSL", "helsinki": "HEL", "warsaw": "WAW",
            // Asia/Pacific
            "tokyo": "HND", "kyoto": "ITM", "osaka": "KIX", "seoul": "ICN", "beijing": "PEK",
            "shanghai": "PVG", "hong kong": "HKG", "singapore": "SIN", "bangkok": "BKK",
            "kuala lumpur": "KUL", "jakarta": "CGK", "taipei": "TPE", "manila": "MNL",
            "phuket": "HKT", "krabi": "KBV", "koh samui": "USM", "penang": "PEN", "langkawi": "LGK",
            "cebu": "CEB", "hanoi": "HAN", "ho chi minh": "SGN", "da nang": "DAD", "nagoya": "NGO",
            "fukuoka": "FUK", "sapporo": "CTS", "jeju": "CJU", "busan": "PUS", "macau": "MFM",
            "guangzhou": "CAN", "shenzhen": "SZX", "chengdu": "CTU", "sydney": "SYD", "melbourne": "MEL",
            "brisbane": "BNE", "perth": "PER", "adelaide": "ADL", "auckland": "AKL", "christchurch": "CHC",
            "wellington": "WLG",
            // India (Comprehensive)
            "delhi": "DEL", "new delhi": "DEL", "mumbai": "BOM", "bangalore": "BLR", "bengaluru": "BLR",
            "chennai": "MAA", "madras": "MAA", "hyderabad": "HYD", "kolkata": "CCU", "calcutta": "CCU",
            "ahmedabad": "AMD", "pune": "PNQ", "goa": "GOI", "mopa": "GOX", "kochi": "COK", "cochin": "COK",
            "bhubaneswar": "BBI", "odisha": "BBI", "jaipur": "JAI", "lucknow": "LKO", "guwahati": "GAU",
            "thiruvananthapuram": "TRV", "trivandrum": "TRV", "kozhikode": "CCJ", "calicut": "CCJ",
            "patna": "PAT", "bagdogra": "IXB", "chandigarh": "IXC", "madurai": "IXM", "port blair": "IXZ",
            "srinagar": "SXR", "amritsar": "ATQ", "varanasi": "VNS", "coimbatore": "CJB", "visakhapatnam": "VTZ",
            "nagpur": "NAG", "bhopal": "BHO", "indore": "IDR", "ranchi": "IXR", "vadodara": "BDQ",
            "mangalore": "IXE", "mangaluru": "IXE", "tiruchirappalli": "TRZ", "trichy": "TRZ",
            "tirupati": "TIR", "raipur": "RPR", "jammu": "IXJ", "dehradun": "DED", "agartala": "IXA",
            "imphal": "IMF", "surat": "STV", "udaipur": "UDR", "jodhpur": "JDH", "gaya": "GAY",
            "dibrugarh": "DIB", "silchar": "IXS", "dimapur": "DMU", "aurangabad": "IXU", "rajkot": "RAJ",
            "tuticorin": "TCR", "hubli": "HBX", "belgaum": "IXG", "mysore": "MYQ",
            // Middle East & Africa
            "dubai": "DXB", "doha": "DOH", "abu dhabi": "AUH", "istanbul": "IST", "cairo": "CAI",
            "johannesburg": "JNB", "cape town": "CPT", "nairobi": "NBO", "lagos": "LOS", "addis ababa": "ADD",
            "muscat": "MCT", "riyadh": "RUH", "jeddah": "JED", "kuwait": "KWI", "amman": "AMM",
            "beirut": "BEY", "casablanca": "CMN", "marrakech": "RAK",
            // Country fallbacks
            "india": "DEL", "usa": "JFK", "uk": "LHR", "united states": "JFK", "united kingdom": "LHR",
            "australia": "SYD", "canada": "YYZ", "germany": "FRA", "france": "CDG", "japan": "HND",
            "qatar": "DOH", "saudi arabia": "RUH", "bahrain": "BAH", "colombo": "CMB",
            "sri lanka": "CMB", "dhaka": "DAC", "bangladesh": "DAC", "kathmandu": "KTM", "nepal": "KTM",
            "karachi": "KHI", "islamabad": "ISB"
        };

        // 1. Exact match first
        if (staticMap[cleanLocation]) {
            return staticMap[cleanLocation];
        }

        const countries = [
            "india", "usa", "uk", "united states", "united kingdom", "australia",
            "canada", "germany", "france", "japan", "qatar", "saudi arabia", "kuwait",
            "bahrain", "colombo", "sri lanka", "dhaka", "bangladesh", "kathmandu", "nepal",
            "karachi", "islamabad", "lagos", "nairobi", "addis ababa"
        ];

        // 2. Longest substring match excluding countries to stop pre-emption
        const sortedKeys = Object.keys(staticMap).sort((a, b) => b.length - a.length);
        for (const key of sortedKeys) {
            if (countries.includes(key)) continue;
            if (cleanLocation.includes(key)) {
                return staticMap[key];
            }
        }

        return null;
    }

    private getGenericFallback(location: string): string {
        const lower = location.toLowerCase();
        if (lower.includes('india')) return 'DEL';
        if (lower.includes('usa') || lower.includes('america') || lower.includes('states')) return 'JFK';
        if (lower.includes('uk') || lower.includes('london') || lower.includes('britain') || lower.includes('kingdom')) return 'LHR';
        if (lower.includes('france') || lower.includes('paris')) return 'CDG';
        if (lower.includes('japan') || lower.includes('tokyo')) return 'HND';
        if (lower.includes('germany') || lower.includes('berlin') || lower.includes('frankfurt')) return 'FRA';
        if (lower.includes('spain') || lower.includes('madrid') || lower.includes('barcelona')) return 'MAD';
        if (lower.includes('italy') || lower.includes('rome') || lower.includes('milan')) return 'FCO';
        return 'LHR'; // absolute fallback
    }

    async resolveIataCode(location: string): Promise<string | null> {
        if (!location) return null;
        const cleanLocation = location.trim();
        const cacheKey = cleanLocation.toUpperCase();

        // 1. Try Static Mapping First
        const staticIata = this.getStaticIataCode(cleanLocation);
        if (staticIata) {
            this.logger.log(`Resolved airport IATA for ${cleanLocation} from static map: ${staticIata}`);
            return staticIata;
        }

        const cache = this.readCache();
        if (cache[cacheKey]) {
            this.logger.log(`Resolved airport IATA for ${cleanLocation} from cache: ${cache[cacheKey]}`);
            return cache[cacheKey];
        }

        if (!this.openRouterService.hasKey) {
            this.logger.warn('OPENROUTER_API_KEY is not configured. Returning generic fallback.');
            return this.getGenericFallback(cleanLocation);
        }

        const prompt = `Identify the nearest major commercial airport with a 3-letter IATA code for the following location: "${cleanLocation}".
Return ONLY the 3-letter IATA code in uppercase. Do not include any other text, explanation, or punctuation. Example: CDG`;

        try {
            this.logger.log(`Resolving nearest airport for "${cleanLocation}" via OpenRouter`);
            const text = await this.openRouterService.chatCompletion({
                messages: [
                    { role: 'system', content: 'You are an airport IATA code resolver. Respond ONLY with the 3-letter IATA code in uppercase.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
            });

            this.logger.log(`OpenRouter response for airport resolution of ${cleanLocation}: ${text}`);

            const match = text?.match(/\b([A-Z]{3})\b/);
            if (match) {
                const iata = match[1];
                this.writeCache(cacheKey, iata);
                return iata;
            }
        } catch (error: any) {
            this.logger.error(`Failed to resolve airport IATA for ${cleanLocation} via OpenRouter: ${error.message}`);
        }

        return this.getGenericFallback(cleanLocation);
    }

    async searchDestinations(query: string) {
        if (!query || query.length < 2) {
            return [];
        }

        const cleanQuery = query.trim().toLowerCase();

        const countryToCapital: Record<string, { city: string; country: string; lat: number; lon: number }> = {
            "switzerland": { city: "Bern", country: "Switzerland", lat: 46.9480, lon: 7.4474 },
            "india": { city: "New Delhi", country: "India", lat: 28.6139, lon: 77.2090 },
            "france": { city: "Paris", country: "France", lat: 48.8566, lon: 2.3522 },
            "japan": { city: "Tokyo", country: "Japan", lat: 35.6762, lon: 139.6503 },
            "germany": { city: "Berlin", country: "Germany", lat: 52.5200, lon: 13.4050 },
            "italy": { city: "Rome", country: "Italy", lat: 41.9028, lon: 12.4964 },
            "spain": { city: "Madrid", country: "Spain", lat: 40.4168, lon: -3.7038 },
            "united kingdom": { city: "London", country: "United Kingdom", lat: 51.5074, lon: -0.1278 },
            "uk": { city: "London", country: "United Kingdom", lat: 51.5074, lon: -0.1278 },
            "united states": { city: "Washington, D.C.", country: "United States", lat: 38.9072, lon: -77.0369 },
            "usa": { city: "Washington, D.C.", country: "United States", lat: 38.9072, lon: -77.0369 },
            "us": { city: "Washington, D.C.", country: "United States", lat: 38.9072, lon: -77.0369 },
            "canada": { city: "Ottawa", country: "Canada", lat: 45.4215, lon: -75.6972 },
            "australia": { city: "Canberra", country: "Australia", lat: -35.2809, lon: 149.1300 },
            "new zealand": { city: "Wellington", country: "New Zealand", lat: -41.2865, lon: 174.7762 },
            "brazil": { city: "Brasilia", country: "Brazil", lat: -15.7938, lon: -47.8828 },
            "china": { city: "Beijing", country: "China", lat: 39.9042, lon: 116.4074 },
            "nepal": { city: "Kathmandu", country: "Nepal", lat: 27.7172, lon: 85.3240 },
            "bhutan": { city: "Thimphu", country: "Bhutan", lat: 27.4712, lon: 89.6377 },
            "sri lanka": { city: "Colombo", country: "Sri Lanka", lat: 6.9271, lon: 79.8612 },
            "bangladesh": { city: "Dhaka", country: "Bangladesh", lat: 23.8103, lon: 90.4125 },
            "thailand": { city: "Bangkok", country: "Thailand", lat: 13.7563, lon: 100.5018 },
            "malaysia": { city: "Kuala Lumpur", country: "Malaysia", lat: 3.1390, lon: 101.6869 },
            "indonesia": { city: "Jakarta", country: "Indonesia", lat: -6.2088, lon: 106.8456 },
            "singapore": { city: "Singapore", country: "Singapore", lat: 1.3521, lon: 103.8198 },
            "south korea": { city: "Seoul", country: "South Korea", lat: 37.5665, lon: 126.9780 },
            "vietnam": { city: "Hanoi", country: "Vietnam", lat: 21.0285, lon: 105.8542 },
            "maldives": { city: "Male", country: "Maldives", lat: 4.1755, lon: 73.5093 },
            "egypt": { city: "Cairo", country: "Egypt", lat: 30.0444, lon: 31.2357 },
            "turkey": { city: "Ankara", country: "Turkey", lat: 39.9334, lon: 32.8597 },
            "greece": { city: "Athens", country: "Greece", lat: 37.9838, lon: 23.7275 },
            "sweden": { city: "Stockholm", country: "Sweden", lat: 59.3293, lon: 18.0686 },
            "norway": { city: "Oslo", country: "Norway", lat: 59.9139, lon: 10.7522 },
            "finland": { city: "Helsinki", country: "Finland", lat: 60.1699, lon: 24.9384 },
            "denmark": { city: "Copenhagen", country: "Denmark", lat: 55.6761, lon: 12.5683 },
            "austria": { city: "Vienna", country: "Austria", lat: 48.2082, lon: 16.3738 },
            "netherlands": { city: "Amsterdam", country: "Netherlands", lat: 52.3676, lon: 4.9041 },
            "belgium": { city: "Brussels", country: "Belgium", lat: 50.8503, lon: 4.3517 },
            "portugal": { city: "Lisbon", country: "Portugal", lat: 38.7223, lon: -9.1393 },
            "ireland": { city: "Dublin", country: "Ireland", lat: 53.3498, lon: -6.2603 },
            "russia": { city: "Moscow", country: "Russia", lat: 55.7558, lon: 37.6173 },
            "south africa": { city: "Pretoria", country: "South Africa", lat: -25.7479, lon: 28.2293 },
            "mexico": { city: "Mexico City", country: "Mexico", lat: 19.4326, lon: -99.1332 },
            "argentina": { city: "Buenos Aires", country: "Argentina", lat: -34.6037, lon: -58.3816 },
            "colombia": { city: "Bogota", country: "Colombia", lat: 4.7110, lon: -74.0721 },
            "peru": { city: "Lima", country: "Peru", lat: -12.0464, lon: -77.0428 },
            "chile": { city: "Santiago", country: "Chile", lat: -33.4489, lon: -70.6693 },
            "saudi arabia": { city: "Riyadh", country: "Saudi Arabia", lat: 24.7136, lon: 46.6753 },
            "united arab emirates": { city: "Abu Dhabi", country: "United Arab Emirates", lat: 24.4539, lon: 54.3773 },
            "uae": { city: "Abu Dhabi", country: "United Arab Emirates", lat: 24.4539, lon: 54.3773 },
            "philippines": { city: "Manila", country: "Philippines", lat: 14.5995, lon: 120.9842 },
            "taiwan": { city: "Taipei", country: "Taiwan", lat: 25.0330, lon: 121.5654 }
        };

        const matchingCapital = countryToCapital[cleanQuery];
        const prependedResults = [];
        if (matchingCapital) {
            prependedResults.push({
                id: `capital_${cleanQuery}`,
                name: `${matchingCapital.city}, ${matchingCapital.country}`,
                country: matchingCapital.country,
                lat: matchingCapital.lat,
                lon: matchingCapital.lon
            });
        }

        const apiKey = this.configService.get<string>('GEOAPIFY_API_KEY');
        if (!apiKey) {
            this.logger.error('Missing GEOAPIFY_API_KEY configuration');
            throw new Error('Destination search configuration is missing.');
        }

        const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(
            query,
        )}&type=city&format=json&apiKey=${apiKey}`;

        try {
            const { data } = await firstValueFrom(this.httpService.get(url, { timeout: 5000 }));

            // Geoapify returns an array of objects inside `data.results`.
            // Let's map it to a clean UI-friendly format for our autocomplete dropdown.
            if (data && data.results) {
                const apiResults = data.results.map((item: any) => {
                    // We want strings like "Indianapolis, United States" or "Paris, France"
                    const name = item.city || item.name || '';
                    const state = item.state ? `, ${item.state}` : '';
                    const country = item.country ? `, ${item.country}` : '';
                    const displayName = `${name}${state}${country}`.trim().replace(/^,|,$/g, '');

                    return {
                        id: item.place_id,
                        name: displayName,
                        country: item.country || '',
                        lat: item.lat,
                        lon: item.lon,
                    };
                }).filter((item: any) => item.name.length > 0); // Drop any malformed empty results

                // Combine prepended capitals with API results (filtering out duplicates if any)
                const combined = [...prependedResults];
                for (const item of apiResults) {
                    if (!combined.some(c => c.name.toLowerCase() === item.name.toLowerCase())) {
                        combined.push(item);
                    }
                }
                return combined;
            }

            return prependedResults;

        } catch (error: any) {
            this.logger.error(`Failed to fetch destinations from Geoapify: ${error.message}`);
            return []; // Return empty array so the frontend UI doesn't crash on network failure
        }
    }

    async validateLocationOnEarth(location: string): Promise<{ isValid: boolean; resolvedName?: string }> {
        if (!location) return { isValid: false };
        const clean = location.trim().toLowerCase();

        const countryToCapital: Record<string, string> = {
            "switzerland": "Bern, Switzerland",
            "india": "New Delhi, India",
            "france": "Paris, France",
            "japan": "Tokyo, Japan",
            "germany": "Berlin, Germany",
            "italy": "Rome, Italy",
            "spain": "Madrid, Spain",
            "united kingdom": "London, United Kingdom",
            "uk": "London, United Kingdom",
            "united states": "Washington, D.C., United States",
            "usa": "Washington, D.C., United States",
            "us": "Washington, D.C., United States",
            "canada": "Ottawa, Canada",
            "australia": "Canberra, Australia",
            "new zealand": "Wellington, New Zealand",
            "brazil": "Brasilia, Brazil",
            "china": "Beijing, China",
            "nepal": "Kathmandu, Nepal",
            "bhutan": "Thimphu, Bhutan",
            "sri lanka": "Colombo, Sri Lanka",
            "bangladesh": "Dhaka, Bangladesh",
            "thailand": "Bangkok, Thailand",
            "malaysia": "Kuala Lumpur, Malaysia",
            "indonesia": "Jakarta, Indonesia",
            "singapore": "Singapore",
            "south korea": "Seoul, South Korea",
            "vietnam": "Hanoi, Vietnam",
            "maldives": "Male, Maldives",
            "egypt": "Cairo, Egypt",
            "turkey": "Ankara, Turkey",
            "greece": "Athens, Greece",
            "sweden": "Stockholm, Sweden",
            "norway": "Oslo, Norway",
            "finland": "Helsinki, Finland",
            "denmark": "Copenhagen, Denmark",
            "austria": "Vienna, Austria",
            "netherlands": "Amsterdam, Netherlands",
            "belgium": "Brussels, Belgium",
            "portugal": "Lisbon, Portugal",
            "ireland": "Dublin, Ireland",
            "russia": "Moscow, Russia",
            "south africa": "Pretoria, South Africa",
            "mexico": "Mexico City, Mexico",
            "argentina": "Buenos Aires, Argentina",
            "colombia": "Bogota, Colombia",
            "peru": "Lima, Peru",
            "chile": "Santiago, Chile",
            "saudi arabia": "Riyadh, Saudi Arabia",
            "united arab emirates": "Abu Dhabi, United Arab Emirates",
            "uae": "Abu Dhabi, United Arab Emirates",
            "philippines": "Manila, Philippines",
            "taiwan": "Taipei, Taiwan",
            "hong kong": "Hong Kong",
            "macau": "Macau"
        };

        if (countryToCapital[clean]) {
            return { isValid: true, resolvedName: countryToCapital[clean] };
        }

        for (const [country, capital] of Object.entries(countryToCapital)) {
            if (clean === country || clean === `visit ${country}` || clean === `go to ${country}` || clean === `trip to ${country}`) {
                return { isValid: true, resolvedName: capital };
            }
        }

        // Quick check local lists first (fastest)
        const commonKnownPlaces = [
            'kailash', 'mansarovar', 'mansrovar', 'antarctica', 'tibet', 'everest',
            'lhasa', 'darchen', 'hilsa', 'simikot', 'nepalgunj', 'kathmandu'
        ];
        if (commonKnownPlaces.some(place => clean.includes(place))) {
            return { isValid: true };
        }

        if (!this.openRouterService.hasKey) {
            // If no API key, check if standard string is obviously fake
            const fakePlanets = ['moon', 'mars', 'jupiter', 'saturn', 'venus', 'mercury', 'neptune', 'uranus', 'pluto', 'sun', 'galaxy', 'universe'];
            const isPlanet = fakePlanets.some(p => clean.includes(p));
            return { isValid: !isPlanet };
        }

        try {
            const prompt = `Determine if the following input: "${location}" is a real, valid city, travel destination, region, landmark, or location on planet Earth.
Examples of real places: 'Kailash Mansarovar', 'Antarctica', 'Tibet', 'Svalbard', 'London', 'Bhutan', 'Mount Everest'.
Examples of fake/non-Earth places: 'Moon', 'Mars', 'Narnia', 'Asgard', 'Delhi to Moon', 'Gotham'.

Return ONLY valid JSON matching this schema (no markdown, no explanations):
{
  "isValid": true or false,
  "isCountry": true or false,
  "capitalCity": "Name of the capital city and country, e.g. 'Bern, Switzerland', or null if not a country"
}
`;

            const text = await this.openRouterService.chatCompletion({
                messages: [
                    { role: 'system', content: 'You are a geolocation validity analyzer. Output strictly JSON.' },
                    { role: 'user', content: prompt }
                ],
                expectJson: true,
                temperature: 0.1,
            });

            if (text) {
                const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
                const parsed = JSON.parse(cleanJson);
                if (parsed.isValid && parsed.isCountry && parsed.capitalCity) {
                    return { isValid: true, resolvedName: parsed.capitalCity };
                }
                return { isValid: !!parsed.isValid };
            }
        } catch (e: any) {
            this.logger.error(`Error validating destination on Earth via OpenRouter: ${e.message}`);
        }

        // Default to true if OpenRouter fails to avoid blocking users on network errors
        return { isValid: true };
    }
}

