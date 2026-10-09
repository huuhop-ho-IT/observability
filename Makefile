.PHONY: up down clean logs burst burst-unsafe load load-unsafe chaos-slow chaos-timeout chaos-off report

up:            ## Build & start the whole stack
	docker compose up -d --build

down:          ## Stop the stack (keep data)
	docker compose down

clean:         ## Stop & wipe all data (DB, Prometheus, Loki, Tempo)
	docker compose down -v

logs:
	docker compose logs -f booking-api

burst:         ## 1,000 requests in 1s for 50 seats, redlock mode
	docker compose run --rm k6 run /scripts/burst.js

burst-unsafe:  ## Same, but WITHOUT locking -> double-sold seats
	docker compose run --rm -e MODE=unsafe k6 run /scripts/burst.js

load:          ## Sustained 3-minute load (nicer graphs)
	docker compose run --rm k6 run /scripts/load.js

load-unsafe:
	docker compose run --rm -e MODE=unsafe k6 run /scripts/load.js

chaos-slow:    ## 20% of requests: DB takes 3s
	curl -s -XPOST localhost:8080/api/chaos -H 'content-type: application/json' -d '{"mode":"slow-db","ratio":0.2}'; echo

chaos-timeout: ## 20% of requests: DB statement timeout -> 500
	curl -s -XPOST localhost:8080/api/chaos -H 'content-type: application/json' -d '{"mode":"db-timeout","ratio":0.2}'; echo

chaos-off:
	curl -s -XPOST localhost:8080/api/chaos -H 'content-type: application/json' -d '{"mode":"none","ratio":0}'; echo

report:        ## Result for showtime #1
	curl -s localhost:8080/api/showtimes/1/report; echo
