import { Injectable, OnModuleInit } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PoolClient } from 'pg';
import { Lock } from 'redlock';
import { ChaosService } from '../chaos/chaos.service';
import { DatabaseService } from '../infra/database.service';
import { RedisService } from '../infra/redis.service';
import {
  bookingAttempts,
  bookingDuration,
  lockAcquire,
  lockAcquireDuration,
  overbooked,
  setRemainingSeats,
} from '../telemetry/metrics';
import { withSpan } from '../telemetry/with-span';
import { BookingMode, BookingResult, CreateBookingDto } from './booking.dto';
import { BookingRejected } from './booking.errors';

const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS ?? 5000);
const PAYMENT_DELAY_MS = Number(process.env.PAYMENT_DELAY_MS ?? 50);

const remainingKey = (showtimeId: number) => `showtime:${showtimeId}:remaining`;
const bookedKey = (showtimeId: number) => `showtime:${showtimeId}:booked`;
const lockKey = (showtimeId: number, seat: string) => `lock:showtime:${showtimeId}:seat:${seat}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Booking {
  id: number;
  showtime_id: number;
  seat_code: string;
  user_id: string;
  mode: BookingMode;
  created_at: string;
}

@Injectable()
export class BookingService implements OnModuleInit {
  constructor(
    @InjectPinoLogger(BookingService.name) private readonly logger: PinoLogger,
    private readonly db: DatabaseService,
    private readonly redisService: RedisService,
    private readonly chaos: ChaosService,
  ) {}

  private get redis() {
    return this.redisService.redis;
  }

  /** Warm the Redis inventory from Postgres (source of truth) if Redis has nothing yet. */
  async onModuleInit() {
    const { rows } = await this.db.query<{ id: number }>('SELECT id FROM showtimes');
    for (const { id } of rows) {
      if (!(await this.redis.exists(remainingKey(id)))) await this.syncInventory(id);
      else setRemainingSeats(id, Number(await this.redis.get(remainingKey(id))));
    }
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------
  async book(dto: CreateBookingDto, mode: BookingMode): Promise<Booking> {
    const startedAt = performance.now();
    let result: BookingResult = 'error';
    const ctx = { mode, showtimeId: dto.showtimeId, seatCode: dto.seatCode, userId: dto.userId };
    trace.getActiveSpan()?.setAttributes({
      'booking.mode': mode,
      'booking.showtime_id': dto.showtimeId,
      'booking.seat_code': dto.seatCode,
    });

    try {
      const booking = mode === 'unsafe' ? await this.bookUnsafe(dto) : await this.bookWithRedlock(dto);
      result = 'success';
      this.logger.info({ ...ctx, bookingId: booking.id }, 'Booking confirmed');
      return booking;
    } catch (err) {
      if (err instanceof BookingRejected) {
        result = err.result;
        this.logger.info({ ...ctx, result }, `Booking rejected: ${err.message}`);
      } else {
        this.logger.error({ ...ctx, err }, `Booking failed: ${(err as Error).message}`);
      }
      throw err;
    } finally {
      const seconds = (performance.now() - startedAt) / 1000;
      bookingAttempts.add(1, { mode, result });
      bookingDuration.record(seconds, { mode, result });
      trace.getActiveSpan()?.setAttribute('booking.result', result);
    }
  }

  // ---------------------------------------------------------------------------
  // MODE "unsafe": check-then-act without a lock -> RACE CONDITION -> double-sold seats
  // ---------------------------------------------------------------------------
  private async bookUnsafe(dto: CreateBookingDto): Promise<Booking> {
    const booking = await withSpan('booking.db_transaction', {}, () =>
      this.db.transaction(async (client) => {
        await this.chaos.inject(client);
        await this.assertSeatAvailable(client, dto);
        await this.simulatePayment(); // race window: many requests see the seat as AVAILABLE
        return this.insertBooking(client, dto, 'unsafe');
      }),
    );

    // Detect overbooking: was this seat already booked before this booking?
    const { rows } = await this.db.query<{ before: string }>(
      'SELECT count(*) AS before FROM bookings WHERE showtime_id = $1 AND seat_code = $2 AND id < $3',
      [dto.showtimeId, dto.seatCode, booking.id],
    );
    if (Number(rows[0].before) > 0) {
      overbooked.add(1, { mode: 'unsafe' });
      this.logger.error(
        { showtimeId: dto.showtimeId, seatCode: dto.seatCode, bookingId: booking.id, previous: Number(rows[0].before) },
        `OVERBOOKING detected: seat ${dto.seatCode} sold more than once`,
      );
    }
    await this.syncInventory(dto.showtimeId);
    return booking;
  }

  // ---------------------------------------------------------------------------
  // MODE "redlock": Redis fast reject -> per-seat Redlock -> re-check DB -> write
  // ---------------------------------------------------------------------------
  private async bookWithRedlock(dto: CreateBookingDto): Promise<Booking> {
    const { showtimeId, seatCode } = dto;

    // 1) Redis fast path: reject hopeless requests immediately, no lock, no DB
    await withSpan('booking.redis_fast_check', {}, async () => {
      const res = await this.redis
        .pipeline()
        .get(remainingKey(showtimeId))
        .sismember(bookedKey(showtimeId), seatCode)
        .exec();
      const remaining = res?.[0]?.[1] as string | null;
      const isBooked = res?.[1]?.[1] === 1;
      if (remaining !== null && Number(remaining) <= 0) throw new BookingRejected('sold_out', 'Showtime is sold out');
      if (isBooked) throw new BookingRejected('seat_taken', `Seat ${seatCode} is already booked`);
    });

    // 2) Distributed lock: only one request (across all replicas) may process a seat at a time
    const lock = await this.acquireLock(lockKey(showtimeId, seatCode));

    try {
      // 3) Inside the lock: re-check Postgres (source of truth), then write
      const booking = await withSpan('booking.db_transaction', {}, () =>
        this.db.transaction(async (client) => {
          await this.chaos.inject(client);
          await this.assertSeatAvailable(client, dto);
          await this.simulatePayment();
          return this.insertBooking(client, dto, 'redlock');
        }),
      );

      // 4) Update the Redis cache
      await withSpan('booking.redis_update', {}, async () => {
        const res = await this.redis
          .multi()
          .sadd(bookedKey(showtimeId), seatCode)
          .decr(remainingKey(showtimeId))
          .exec();
        setRemainingSeats(showtimeId, Number(res?.[1]?.[1] ?? 0));
      });
      return booking;
    } catch (err) {
      // DB says the seat is sold but Redis didn't know -> resync the cache
      if (err instanceof BookingRejected && err.result === 'seat_taken') {
        await this.redis.sadd(bookedKey(showtimeId), seatCode);
      }
      throw err;
    } finally {
      await lock.release().catch((e) => this.logger.warn({ err: e }, 'Release lock failed (lock expired?)'));
    }
  }

  private acquireLock(resource: string): Promise<Lock> {
    return withSpan('redlock.acquire', { 'lock.resource': resource, 'lock.ttl_ms': LOCK_TTL_MS }, async () => {
      const startedAt = performance.now();
      try {
        const lock = await this.redisService.redlock.acquire([resource], LOCK_TTL_MS);
        lockAcquire.add(1, { result: 'acquired' });
        lockAcquireDuration.record((performance.now() - startedAt) / 1000, { result: 'acquired' });
        return lock;
      } catch {
        lockAcquire.add(1, { result: 'busy' });
        lockAcquireDuration.record((performance.now() - startedAt) / 1000, { result: 'busy' });
        throw new BookingRejected('lock_busy', 'Seat is being held by another customer, please retry');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private async assertSeatAvailable(client: PoolClient, dto: CreateBookingDto) {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM seats WHERE showtime_id = $1 AND seat_code = $2',
      [dto.showtimeId, dto.seatCode],
    );
    if (!rows[0]) throw new BookingRejected('not_found', `Seat ${dto.seatCode} does not exist for showtime ${dto.showtimeId}`);
    if (rows[0].status === 'BOOKED') throw new BookingRejected('seat_taken', `Seat ${dto.seatCode} is already booked`);
  }

  private async insertBooking(client: PoolClient, dto: CreateBookingDto, mode: BookingMode): Promise<Booking> {
    const { rows } = await client.query<Booking>(
      `INSERT INTO bookings (showtime_id, seat_code, user_id, mode)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [dto.showtimeId, dto.seatCode, dto.userId, mode],
    );
    await client.query(
      `UPDATE seats SET status = 'BOOKED', booked_by = $3, updated_at = now()
       WHERE showtime_id = $1 AND seat_code = $2`,
      [dto.showtimeId, dto.seatCode, dto.userId],
    );
    return rows[0];
  }

  /** Simulated payment-gateway call: this wait is exactly what opens the race window. */
  private simulatePayment() {
    return withSpan('payment.charge', { 'payment.provider': 'fake-gateway' }, () =>
      sleep(PAYMENT_DELAY_MS + Math.random() * PAYMENT_DELAY_MS),
    );
  }

  async syncInventory(showtimeId: number) {
    const { rows } = await this.db.query<{ seat_code: string; status: string }>(
      'SELECT seat_code, status FROM seats WHERE showtime_id = $1',
      [showtimeId],
    );
    const booked = rows.filter((r) => r.status === 'BOOKED').map((r) => r.seat_code);
    const remaining = rows.length - booked.length;
    const tx = this.redis.multi().del(bookedKey(showtimeId)).set(remainingKey(showtimeId), remaining);
    if (booked.length) tx.sadd(bookedKey(showtimeId), ...booked);
    await tx.exec();
    setRemainingSeats(showtimeId, remaining);
  }

  // ---------------------------------------------------------------------------
  // Admin / report
  // ---------------------------------------------------------------------------
  async listShowtimes() {
    const { rows } = await this.db.query(
      `SELECT s.id, s.movie_title, s.starts_at, s.total_seats,
              count(*) FILTER (WHERE st.status = 'AVAILABLE')::int AS available_seats
       FROM showtimes s JOIN seats st ON st.showtime_id = s.id
       GROUP BY s.id ORDER BY s.id`,
    );
    return rows;
  }

  async reset(showtimeId: number) {
    await this.db.transaction(async (client) => {
      await client.query('DELETE FROM bookings WHERE showtime_id = $1', [showtimeId]);
      await client.query(
        `UPDATE seats SET status = 'AVAILABLE', booked_by = NULL, updated_at = now() WHERE showtime_id = $1`,
        [showtimeId],
      );
    });
    await this.syncInventory(showtimeId);
    this.logger.warn({ showtimeId }, 'Showtime reset: all seats AVAILABLE again');
    return this.report(showtimeId);
  }

  async report(showtimeId: number) {
    const { rows } = await this.db.query(
      `SELECT
         (SELECT total_seats FROM showtimes WHERE id = $1)                                    AS total_seats,
         (SELECT count(*) FROM seats WHERE showtime_id = $1 AND status = 'BOOKED')::int       AS booked_seats,
         (SELECT count(*) FROM bookings WHERE showtime_id = $1)::int                          AS total_bookings,
         (SELECT count(*) FROM (SELECT seat_code FROM bookings WHERE showtime_id = $1
                                GROUP BY seat_code HAVING count(*) > 1) d)::int               AS double_booked_seats`,
      [showtimeId],
    );
    const r = rows[0];
    const redisRemaining = await this.redis.get(remainingKey(showtimeId));
    return {
      showtimeId,
      totalSeats: r.total_seats,
      bookedSeats: r.booked_seats,
      totalBookings: r.total_bookings,
      overbookedTickets: r.total_bookings - r.booked_seats,
      doubleBookedSeats: r.double_booked_seats,
      redisRemaining: redisRemaining === null ? null : Number(redisRemaining),
      consistent: r.total_bookings === r.booked_seats && r.total_bookings <= r.total_seats,
    };
  }
}
