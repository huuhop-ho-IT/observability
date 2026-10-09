-- Cinema: every showtime has exactly 50 seats (A1..E10)
CREATE TABLE showtimes (
  id          SERIAL PRIMARY KEY,
  movie_title TEXT        NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  total_seats INT         NOT NULL
);

CREATE TABLE seats (
  showtime_id INT  NOT NULL REFERENCES showtimes(id),
  seat_code   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'BOOKED')),
  booked_by   TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (showtime_id, seat_code)
);

-- DELIBERATELY no UNIQUE(showtime_id, seat_code) so the "unsafe" mode exposes the race condition
-- (one seat sold to many people). The "redlock" mode must guarantee correctness on its own.
CREATE TABLE bookings (
  id          BIGSERIAL PRIMARY KEY,
  showtime_id INT  NOT NULL REFERENCES showtimes(id),
  seat_code   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  mode        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bookings_showtime_seat ON bookings (showtime_id, seat_code);

INSERT INTO showtimes (movie_title, starts_at, total_seats) VALUES
  ('Interstellar (IMAX)', now() + interval '1 day', 50),
  ('Dune: Part Two',      now() + interval '2 day', 50);

INSERT INTO seats (showtime_id, seat_code)
SELECT s.id, r.row_letter || n.num
FROM showtimes s
CROSS JOIN (VALUES ('A'), ('B'), ('C'), ('D'), ('E')) AS r(row_letter)
CROSS JOIN generate_series(1, 10) AS n(num);
