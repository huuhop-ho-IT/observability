import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { BookingQueryDto, CreateBookingDto } from './booking.dto';
import { BookingService } from './booking.service';

@Controller('api')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  /** POST /api/bookings?mode=redlock|unsafe */
  @Post('bookings')
  @HttpCode(201)
  book(@Body() dto: CreateBookingDto, @Query() query: BookingQueryDto) {
    return this.bookings.book(dto, query.mode ?? 'redlock');
  }

  @Get('showtimes')
  list() {
    return this.bookings.listShowtimes();
  }

  @Get('showtimes/:id/report')
  report(@Param('id', ParseIntPipe) id: number) {
    return this.bookings.report(id);
  }

  @Post('showtimes/:id/reset')
  @HttpCode(200)
  reset(@Param('id', ParseIntPipe) id: number) {
    return this.bookings.reset(id);
  }
}
