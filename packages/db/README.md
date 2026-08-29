# `@steam-top/db`

`drizzle/0000_steam_top_pre_first_deploy.sql` is the single squashed baseline
migration for a database that has never been deployed. Do not apply it over an
older schema. After the first deployment, every schema change must be a new,
forward-only migration.

Run the PostgreSQL integration contract with an empty disposable database:

```sh
TEST_DATABASE_URL=postgresql://... pnpm --filter @steam-top/db test:postgres
```

The command intentionally fails when `TEST_DATABASE_URL` is absent. Ordinary
unit tests may skip the PostgreSQL contract locally; CI always supplies a real
PostgreSQL 16 service and runs it.

IP addresses, user agents and device names are diagnostic fields only. They are
retained permanently until an explicit audited administrator deletion or
platform decommission, matching the product retention decision. They must
never be used as authentication or identity keys.

Battle-eligible design snapshots, their layers, completed matches and saved
rounds are immutable. Deletion is allowed only inside the same transaction that
first inserts an immutable `deletion_audit` row and binds its UUID locally:

```sql
SELECT set_config('steam_top.deletion_audit_id', '<audit UUID>', true);
```

Application code must use `withAuditedDeletion`; a missing, invented or
previous-transaction audit UUID cannot unlock deletion.
