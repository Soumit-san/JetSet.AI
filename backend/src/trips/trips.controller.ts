import { Controller, Post, Get, Patch, Body, Param, Inject, forwardRef } from '@nestjs/common';
import { TripsService, TripData } from './trips.service';
import { AiService } from '../ai/ai.service';

@Controller('trips')
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    @Inject(forwardRef(() => AiService)) private readonly aiService: AiService,
  ) {}

  @Post()
  async createTrip(@Body() tripData: Partial<TripData>): Promise<TripData> {
    return await this.tripsService.createTrip(tripData);
  }

  @Get(':id')
  async getTrip(@Param('id') id: string): Promise<TripData> {
    return await this.tripsService.getTrip(id);
  }

  @Patch(':id')
  async modifyTrip(@Param('id') id: string, @Body() updates: Partial<TripData>) {
    return await this.tripsService.modifyTrip(id, updates, this.aiService);
  }

  /**
   * GET /trips/:id/itinerary-stops
   * Uses AI to parse the trip's combinedPlan and extract per-city stays
   * with checkin/checkout dates. Falls back to regex if AI is unavailable.
   */
  @Get(':id/itinerary-stops')
  async getItineraryStops(@Param('id') id: string) {
    const trip = await this.tripsService.getTrip(id);

    if (!trip.combinedPlan) {
      const fallback = this.aiService.buildFallbackStop(trip.destination, trip.fromDate, trip.toDate);
      return { status: 'ready', stops: fallback };
    }

    const stops = await this.aiService.extractItineraryStops(
      trip.combinedPlan,
      trip.fromDate,
      trip.toDate,
      trip.destination,
    );

    return {
      status: 'ready',
      stops: stops && stops.length > 0 ? stops : this.aiService.buildFallbackStop(trip.destination, trip.fromDate, trip.toDate),
    };
  }

  /**
   * GET /trips/:id/flight-legs
   * Uses AI to determine ONLY the commercially flyable legs.
   * AI knows which parts are road/trek/local transport and which need airline tickets.
   * Handles hub routing (e.g., BBI→DEL→KTM) if no direct flight exists.
   */
  @Get(':id/flight-legs')
  async getFlightLegs(@Param('id') id: string) {
    const trip = await this.tripsService.getTrip(id);

    if (!trip.combinedPlan) {
      // Even if AI combined plan is still streaming/generating, immediately provide deterministic flight legs
      // based on trip origin/destination/dates so the user can view commercial flights right away.
      const fallback = this.aiService.fallbackFlightLegs(trip);
      return { status: 'ready', legs: fallback };
    }

    let legs = await this.aiService.extractFlightLegs({
      origin:       trip.origin,
      destination:  trip.destination,
      fromDate:     trip.fromDate,
      toDate:       trip.toDate,
      budget:       trip.budget,
      companions:   trip.companions,
      currency:     trip.currency,
      combinedPlan: trip.combinedPlan,
    });

    if (!legs || !legs.outbound || legs.outbound.length === 0) {
      legs = this.aiService.fallbackFlightLegs(trip);
    }

    return { status: 'ready', legs };
  }

  /**
   * GET /trips/:id/warning
   * Checks destination restricted permissions/season closures using AI
   */
  @Get(':id/warning')
  async getTripWarning(@Param('id') id: string) {
    const trip = await this.tripsService.getTrip(id);
    return await this.aiService.checkDestinationWarning({
      destination: trip.destination,
      fromDate:    trip.fromDate,
      toDate:      trip.toDate,
    });
  }
}

