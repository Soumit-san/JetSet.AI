import { Injectable, NotFoundException, Logger, Inject } from '@nestjs/common';

export interface TripData {
  id: string;
  origin: string;
  destination: string;
  fromDate: string;
  toDate: string;
  budget: string;
  companions: string;
  interests: string[];
  currency: string;
  createdAt: string;
  combinedPlan?: string;
  seasonGuide?: string;
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(@Inject('DATABASE_POOL') private readonly pool: any) {
    this.ensureDbExists();
  }

  private async ensureDbExists() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS trips (
          id VARCHAR(255) PRIMARY KEY,
          origin TEXT,
          destination TEXT,
          from_date VARCHAR(255),
          to_date VARCHAR(255),
          budget VARCHAR(255),
          companions VARCHAR(255),
          interests TEXT[],
          currency VARCHAR(255) DEFAULT 'USD',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          combined_plan TEXT,
          season_guide TEXT
        );
      `);
      this.logger.log('Successfully initialized Supabase trips table: trips');
    } catch (err: any) {
      this.logger.error(`Failed to initialize Supabase trips table: ${err.message}`);
    }
  }

  async createTrip(tripData: Partial<TripData>): Promise<TripData> {
    // Generate UUID-like unique identifier
    const rand = Math.random().toString(36).substring(2, 9);
    const time = Date.now().toString(36);
    const tripId = `${rand}-${time}`;

    const newTrip: TripData = {
      id: tripId,
      origin: tripData.origin || '',
      destination: tripData.destination || '',
      fromDate: tripData.fromDate || '',
      toDate: tripData.toDate || '',
      budget: tripData.budget || '',
      companions: tripData.companions || '',
      interests: tripData.interests || [],
      currency: tripData.currency || 'USD',
      createdAt: new Date().toISOString(),
    };

    try {
      await this.pool.query(
        `INSERT INTO trips (id, origin, destination, from_date, to_date, budget, companions, interests, currency, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newTrip.id,
          newTrip.origin,
          newTrip.destination,
          newTrip.fromDate,
          newTrip.toDate,
          newTrip.budget,
          newTrip.companions,
          newTrip.interests,
          newTrip.currency,
          newTrip.createdAt,
        ],
      );
      return newTrip;
    } catch (err: any) {
      this.logger.error(`Failed to insert trip ${tripId} in database: ${err.message}`);
      throw err;
    }
  }

  async getTrip(id: string): Promise<TripData> {
    try {
      const res = await this.pool.query('SELECT * FROM trips WHERE id = $1', [id]);
      if (res.rows.length === 0) {
        throw new NotFoundException(`Trip plan with ID ${id} not found`);
      }
      const row = res.rows[0];
      return {
        id: row.id,
        origin: row.origin,
        destination: row.destination,
        fromDate: row.from_date,
        toDate: row.to_date,
        budget: row.budget,
        companions: row.companions,
        interests: row.interests || [],
        currency: row.currency,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        combinedPlan: row.combined_plan || undefined,
        seasonGuide: row.season_guide || undefined,
      };
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      this.logger.error(`Failed to fetch trip ${id} from database: ${err.message}`);
      throw err;
    }
  }

  async updateTrip(id: string, updates: Partial<TripData>): Promise<TripData> {
    const current = await this.getTrip(id);
    const merged = { ...current, ...updates };

    try {
      await this.pool.query(
        `UPDATE trips
         SET origin = $1, destination = $2, from_date = $3, to_date = $4, budget = $5,
             companions = $6, interests = $7, currency = $8, combined_plan = $9, season_guide = $10
         WHERE id = $11`,
        [
          merged.origin,
          merged.destination,
          merged.fromDate,
          merged.toDate,
          merged.budget,
          merged.companions,
          merged.interests,
          merged.currency,
          merged.combinedPlan || null,
          merged.seasonGuide || null,
          id,
        ],
      );
      return merged;
    } catch (err: any) {
      this.logger.error(`Failed to update trip ${id} in database: ${err.message}`);
      throw err;
    }
  }

  async modifyTrip(
    tripId: string,
    updates: Partial<TripData>,
    aiService?: any,
  ): Promise<{
    trip: TripData;
    updatedFields: string[];
    confirmation: string;
  }> {
    const current = await this.getTrip(tripId);
    const updatedFields: string[] = [];
    const mergedUpdates: Partial<TripData> = {};

    // 1. Origin
    if (updates.origin && updates.origin.trim() && updates.origin.trim() !== current.origin) {
      mergedUpdates.origin = updates.origin.trim();
      updatedFields.push('origin');
    }

    // 2. Destination
    const destChanged =
      updates.destination &&
      updates.destination.trim() &&
      updates.destination.trim().toLowerCase() !== (current.destination || '').toLowerCase();

    if (destChanged) {
      mergedUpdates.destination = updates.destination!.trim();
      updatedFields.push('destination');
      // Invalidate destination-specific caches so all modules regenerate for new destination
      mergedUpdates.combinedPlan = null as any;
      mergedUpdates.seasonGuide = null as any;
    }

    // 3. Dates
    const baseYear = current.fromDate ? new Date(current.fromDate).getFullYear() : 2026;
    const newFrom = updates.fromDate ? parseDateInput(updates.fromDate, baseYear) : current.fromDate;
    const newTo = updates.toDate ? parseDateInput(updates.toDate, baseYear) : current.toDate;

    const datesChanged = (newFrom && newFrom !== current.fromDate) || (newTo && newTo !== current.toDate);
    if (datesChanged) {
      if (newFrom && newFrom !== current.fromDate) {
        mergedUpdates.fromDate = newFrom;
        updatedFields.push('fromDate');
      }
      if (newTo && newTo !== current.toDate) {
        mergedUpdates.toDate = newTo;
        updatedFields.push('toDate');
      }

      // If destination did NOT change, but dates changed, adapt existing itinerary in combinedPlan
      if (!destChanged && current.combinedPlan) {
        try {
          const oldDays = calculateStayDays(current.fromDate, current.toDate);
          const newDays = calculateStayDays(newFrom, newTo);
          if (newDays !== oldDays && aiService) {
            const currentItin = aiService.extractSection(current.combinedPlan, 'itinerary');
            if (currentItin) {
              const adaptedItin = await aiService.adaptItineraryDays(currentItin, current.destination, oldDays, newDays);
              if (adaptedItin) {
                mergedUpdates.combinedPlan = current.combinedPlan.replace(
                  /---ITINERARY_START---[\s\S]*?---ITINERARY_END---/,
                  `---ITINERARY_START---\n${adaptedItin}\n---ITINERARY_END---`
                );
              }
            }
          }
        } catch (e: any) {
          this.logger.warn(`Could not adapt itinerary for date change: ${e.message}`);
        }
      }
    }

    // 4. Budget, companions, interests
    if (updates.budget && updates.budget !== current.budget) {
      mergedUpdates.budget = updates.budget;
      updatedFields.push('budget');
    }
    if (updates.companions && updates.companions !== current.companions) {
      mergedUpdates.companions = updates.companions;
      updatedFields.push('companions');
    }
    if (updates.interests && updates.interests.length > 0) {
      mergedUpdates.interests = updates.interests;
      updatedFields.push('interests');
    }

    // Persist canonical trip updates
    const updatedTrip = await this.updateTrip(tripId, mergedUpdates);

    // Build natural, human confirmation
    let confirmation = "Done — I've updated your trip details.";
    if (datesChanged && updatedFields.includes('toDate') && !destChanged) {
      const displayEnd = formatMonthDayLong(newTo);
      confirmation = `Done — I extended your trip to ${displayEnd} and updated the flights, stays, and itinerary.`;
    } else if (destChanged) {
      confirmation = `Done — I changed your destination to ${mergedUpdates.destination} and updated your flights, stays, and itinerary.`;
    } else if (updatedFields.includes('origin')) {
      confirmation = `Done — I updated your starting city to ${mergedUpdates.origin} and refreshed your flight options.`;
    } else if (updatedFields.length > 0) {
      confirmation = `Done — I've updated your ${updatedFields.join(', ')} and synchronized all tabs.`;
    }

    return {
      trip: updatedTrip,
      updatedFields,
      confirmation,
    };
  }
}

function formatMonthDayLong(ymd: string): string {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const parts = ymd ? ymd.split('-') : [];
  if (parts.length >= 3) {
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (!isNaN(m) && !isNaN(d) && m >= 1 && m <= 12) {
      return `${MONTHS[m - 1]} ${d}`;
    }
  }
  return ymd;
}

function parseDateInput(val: string, baseYear?: number): string {
  if (!val) return '';
  const trimmed = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const currentYear = baseYear || new Date().getFullYear();
  const m = trimmed.match(/^([a-zA-Z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (m) {
    const monthStr = m[1];
    const day = parseInt(m[2], 10);
    const yr = m[3] ? parseInt(m[3], 10) : currentYear;
    const dateObj = new Date(`${monthStr} ${day}, ${yr}`);
    if (!isNaN(dateObj.getTime())) {
      const y = dateObj.getFullYear();
      const mo = String(dateObj.getMonth() + 1).padStart(2, '0');
      const dd = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${mo}-${dd}`;
    }
  }

  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${dd}`;
  }
  return trimmed;
}

function calculateStayDays(from: string, to: string): number {
  try {
    const d1 = new Date(from);
    const d2 = new Date(to);
    const diff = d2.getTime() - d1.getTime();
    return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)) + 1);
  } catch {
    return 7;
  }
}
