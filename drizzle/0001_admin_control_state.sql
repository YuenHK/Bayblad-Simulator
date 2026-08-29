create table if not exists platform_settings (
  singleton boolean primary key default true not null,
  paused boolean default false not null,
  updated_at timestamptz default now() not null,
  constraint platform_settings_singleton check (singleton = true)
);
insert into platform_settings(singleton, paused) values(true, false) on conflict(singleton) do nothing;

create table if not exists admin_command_operations (
  operation_id uuid primary key,
  payload_hash text not null,
  status varchar(16) not null,
  http_status smallint not null,
  response_json jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  constraint admin_command_operations_hash check (payload_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_command_operations_status check (status in ('accepted','applied','audit_pending','completed','failed'))
);

alter table match_participant_snapshots add column if not exists display_name_snapshot varchar(80);
