import { HttpException, HttpStatus } from '@nestjs/common';
import { BookingResult } from './booking.dto';

/** Business rejection (not a system failure) -> 409/404, recorded as metric result=<reason>. */
export class BookingRejected extends HttpException {
  constructor(
    readonly result: Exclude<BookingResult, 'success' | 'error'>,
    message: string,
  ) {
    super(
      { statusCode: result === 'not_found' ? 404 : 409, error: result, message },
      result === 'not_found' ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT,
    );
  }
}
