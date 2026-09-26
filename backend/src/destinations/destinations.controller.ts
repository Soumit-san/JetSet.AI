import { Controller, Get, Post, Body, Query, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { DestinationsService } from './destinations.service';

@Controller('destinations')
export class DestinationsController {
    constructor(private readonly destinationsService: DestinationsService) { }

    @Get('search')
    @UseInterceptors(CacheInterceptor)
    @CacheTTL(604800000) // Cache for 7 days (in milliseconds)
    async search(@Query('q') query: string) {
        if (!query) return [];

        // We can explicitly define the cache key based on the query to prevent collisions
        return this.destinationsService.searchDestinations(query);
    }

    @Get('resolve-airport')
    @UseInterceptors(CacheInterceptor)
    @CacheTTL(604800000)
    async resolveAirport(@Query('location') location: string) {
        if (!location) return { iata: null };
        const iata = await this.destinationsService.resolveIataCode(location);
        return { iata };
    }

    @Post('validate')
    async validate(@Body() body: { location: string }) {
        if (!body.location) return { isValid: false };
        const isValid = await this.destinationsService.validateLocationOnEarth(body.location);
        return { isValid };
    }
}

