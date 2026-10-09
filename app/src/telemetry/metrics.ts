import { metrics, trace } from '@opentelemetry/api';

/**
 * Custom business metrics. The Collector exposes them to Prometheus as:
 *   booking_attempts_total{mode,result}
 *   booking_duration_seconds_bucket{mode,result}
 *   booking_overbooked_total{mode}
 *   redlock_acquire_total{result}
 *   redlock_acquire_duration_seconds_bucket{result}
 *   booking_seats_remaining{showtime_id}
 */
const meter = metrics.getMeter('booking-api');
export const tracer = trace.getTracer('booking-api');

const BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10];

export const bookingAttempts = meter.createCounter('booking.attempts', {
  description: 'Booking attempts by mode and result',
});

export const bookingDuration = meter.createHistogram('booking.duration', {
  description: 'Time taken to process one booking attempt',
  unit: 's',
  advice: { explicitBucketBoundaries: BUCKETS },
});

export const overbooked = meter.createCounter('booking.overbooked', {
  description: 'Tickets sold for a seat that was already sold (race condition)',
});

export const lockAcquire = meter.createCounter('redlock.acquire', {
  description: 'Redlock acquire attempts by result',
});

export const lockAcquireDuration = meter.createHistogram('redlock.acquire.duration', {
  description: 'Time taken to acquire a Redlock',
  unit: 's',
  advice: { explicitBucketBoundaries: BUCKETS },
});

// Initialise every series to 0 at startup. If a series first appears AFTER a burst (value 50),
// Prometheus increase()/rate() treat that as the starting point and silently "lose" those 50 bookings.
for (const mode of ['redlock', 'unsafe']) {
  for (const result of ['success', 'seat_taken', 'sold_out', 'lock_busy', 'not_found', 'error']) {
    bookingAttempts.add(0, { mode, result });
  }
}
overbooked.add(0, { mode: 'unsafe' });
lockAcquire.add(0, { result: 'acquired' });
lockAcquire.add(0, { result: 'busy' });

// Remaining-seats gauge (value is refreshed after every booking/reset)
const remainingSeats = new Map<number, number>();
export function setRemainingSeats(showtimeId: number, value: number) {
  remainingSeats.set(showtimeId, value);
}
meter
  .createObservableGauge('booking.seats.remaining', { description: 'Seats still available' })
  .addCallback((result) => {
    for (const [showtimeId, value] of remainingSeats) {
      result.observe(value, { showtime_id: String(showtimeId) });
    }
  });
