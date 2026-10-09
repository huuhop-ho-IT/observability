import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class CreateBookingDto {
  @IsInt()
  @Min(1)
  showtimeId: number;

  @Matches(/^[A-Z]\d{1,2}$/, { message: 'seatCode must look like A1..E10' })
  seatCode: string;

  @IsString()
  userId: string;
}

export type BookingMode = 'redlock' | 'unsafe';

export class BookingQueryDto {
  @IsOptional()
  @IsIn(['redlock', 'unsafe'])
  mode: BookingMode = 'redlock';
}

export type BookingResult = 'success' | 'seat_taken' | 'sold_out' | 'lock_busy' | 'not_found' | 'error';
