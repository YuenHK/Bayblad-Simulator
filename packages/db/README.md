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

IP addresses and user agents are diagnostic fields only. They must be cleared
at `diagnostics_expires_at` and must never be used as identity keys. Device
names are retained for the teacher-facing record requested by the product, but
are likewise not authentication or identity keys.

Battle-eligible design snapshots, their layers, completed matches and saved
rounds are immutable. A future audited deletion repository may delete them only
inside the same transaction that records a deletion audit, using:

```sql
SET LOCAL steam_top.allow_audited_delete = 'on';
```
