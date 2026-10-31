# Hourly Virtual Yard sync

The VPS runs `Leads/Scraper.js` once per hour through `virtualyard-sync.timer`.
Its `virtualyard-sync.service` uses `flock` and a 55-minute timeout to prevent
overlapping runs. The timer survives reboots and catches a missed run after boot.

The job shares the sales-floor backend's managed Virtual Yard session. It scrapes
all lead tab/stage combinations and test drives, validates the snapshot, runs the
existing idempotent importer from `byd-leads-backend`, and upserts into the database
specified by `LEAD_CENTER_MONGO_URI` in the backend `.env`.

Runtime files are private and excluded from Git:

- `/var/www/sales-floor/byd-sales-floor-backend/.runtime/virtualyard/both.json`: latest successfully imported snapshot.
- `both.previous.json`: previous successful snapshot.
- `last-run.json`: timestamps, result, record counts, and failure reason.
- `backups/`: pre-import EJSON database backups, retained for seven days after successful runs.

Failed requests, malformed pages, repeated pages, empty scrapes, or failed imports
do not replace the last successful `both.json`. Imports preserve stable Mongo IDs,
staff notes, consent, terminal appointment statuses, and CRM booking references.
CRM-created bookings are matched by their saved Virtual Yard booking ID.

The scraper's direct CLI defaults to `Leads/both.json`; `VY_OUTPUT_FILE` selects a
different path. The scheduled job uses the private runtime path above so hourly
customer data changes never enter Git.

## Server installation

Keep sibling checkouts of `virtual-yard`, `byd-leads-backend`, and
`byd-sales-floor-backend` under `/var/www/sales-floor`. Install root dependencies
with `npm ci --omit=dev` in `virtual-yard` and `byd-leads-backend`.

Copy `deploy/virtualyard-sync.service` and `deploy/virtualyard-sync.timer` to
`/etc/systemd/system/`, then run:

```sh
systemctl daemon-reload
systemctl enable --now virtualyard-sync.timer
systemctl start virtualyard-sync.service
```

Inspect with `systemctl list-timers virtualyard-sync.timer`,
`systemctl status virtualyard-sync.service`, and
`journalctl -u virtualyard-sync.service`. Run it manually through systemctl to
retain overlap protection. Expired/revoked Virtual Yard sessions require
reconnecting in CRM Settings; failed runs are logged and retried on the next hour.
