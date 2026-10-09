/**
 * MAIN SCENARIO: 1,000 booking requests arrive within ~1 second; the cinema only has 50 seats.
 *
 *   docker compose run --rm k6 run /scripts/burst.js                 # mode=redlock (correct)
 *   docker compose run --rm -e MODE=unsafe k6 run /scripts/burst.js  # mode=unsafe (double-selling)
 *
 * Expected for mode=redlock: at most 50 successful bookings, 0 double-sold seats.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const MODE = __ENV.MODE || 'redlock';
const SHOWTIME_ID = Number(__ENV.SHOWTIME_ID || 1);
const TOTAL = Number(__ENV.TOTAL || 1000);

const ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS = ROWS.flatMap((r) => Array.from({ length: 10 }, (_, i) => `${r}${i + 1}`)); // 50 seats

const booked = new Counter('booking_success');
const rejected = new Counter('booking_rejected');
const failed = new Counter('booking_failed');

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: TOTAL, // 1,000 iterations ...
      timeUnit: '1s', // ... per second
      duration: '1s',
      preAllocatedVUs: TOTAL,
      maxVUs: TOTAL,
    },
  },
  thresholds: {
    booking_failed: ['count==0'], // no 5xx errors
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

// 409 (sold out / seat taken / seat held) is a valid business outcome, not a failure
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export function setup() {
  const res = http.post(`${BASE_URL}/api/showtimes/${SHOWTIME_ID}/reset`);
  check(res, { 'reset OK': (r) => r.status === 200 });
  console.log(`Showtime ${SHOWTIME_ID} reset. Mode=${MODE}. Firing ${TOTAL} requests in 1s at 50 seats...`);
}

export default function () {
  const seatCode = SEATS[Math.floor(Math.random() * SEATS.length)];
  const res = http.post(
    `${BASE_URL}/api/bookings?mode=${MODE}`,
    JSON.stringify({ showtimeId: SHOWTIME_ID, seatCode, userId: `user-${__VU}-${__ITER}` }),
    { headers: { 'Content-Type': 'application/json' }, tags: { mode: MODE } },
  );

  if (res.status === 201) booked.add(1);
  else if (res.status === 409) rejected.add(1);
  else failed.add(1);

  check(res, { 'status is 201 or 409': (r) => r.status === 201 || r.status === 409 });
}

export function teardown() {
  const report = http.get(`${BASE_URL}/api/showtimes/${SHOWTIME_ID}/report`).json();
  console.log('================ RESULT =================');
  console.log(JSON.stringify(report, null, 2));
  check(report, {
    'no overselling (totalBookings <= totalSeats)': (r) => r.totalBookings <= r.totalSeats,
    'no double-sold seats (doubleBookedSeats == 0)': (r) => r.doubleBookedSeats === 0,
    'DB consistent (bookings == BOOKED seats)': (r) => r.consistent === true,
  });
}
