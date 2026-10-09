/**
 * Sustained load for a few minutes so Grafana graphs have enough data points
 * (a 1-second burst is just a single dot). The showtime is reset every 15s,
 * so there are always 50 fresh seats to fight over.
 *
 *   docker compose run --rm k6 run /scripts/load.js
 *   docker compose run --rm -e MODE=unsafe -e DURATION=3m k6 run /scripts/load.js
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const MODE = __ENV.MODE || 'redlock';
const SHOWTIME_ID = Number(__ENV.SHOWTIME_ID || 1);
const DURATION = __ENV.DURATION || '3m';
const PEAK_RPS = Number(__ENV.PEAK_RPS || 300);

const SEATS = ['A', 'B', 'C', 'D', 'E'].flatMap((r) => Array.from({ length: 10 }, (_, i) => `${r}${i + 1}`));

export const options = {
  scenarios: {
    reset_every_15s: {
      executor: 'constant-arrival-rate',
      exec: 'resetShowtime',
      rate: 1,
      timeUnit: '15s',
      duration: DURATION,
      preAllocatedVUs: 1,
    },
    bookings: {
      executor: 'ramping-arrival-rate',
      exec: 'book',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { target: PEAK_RPS, duration: '30s' },
        { target: PEAK_RPS, duration: DURATION },
        { target: 0, duration: '15s' },
      ],
    },
  },
};

// 409 is a valid business outcome, not a failure
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export function resetShowtime() {
  http.post(`${BASE_URL}/api/showtimes/${SHOWTIME_ID}/reset`, null, { tags: { name: 'reset' } });
}

export function book() {
  const seatCode = SEATS[Math.floor(Math.random() * SEATS.length)];
  const res = http.post(
    `${BASE_URL}/api/bookings?mode=${MODE}`,
    JSON.stringify({ showtimeId: SHOWTIME_ID, seatCode, userId: `user-${__VU}-${__ITER}` }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /api/bookings', mode: MODE } },
  );
  check(res, { 'status is 201 or 409': (r) => r.status === 201 || r.status === 409 });
}
