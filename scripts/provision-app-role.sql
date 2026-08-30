BEGIN;
SELECT pg_advisory_xact_lock(1937002751);
SELECT format('CREATE ROLE steam_top_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='steam_top_app') \gexec
ALTER ROLE steam_top_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
SELECT format('REVOKE %I FROM steam_top_app',parent.rolname) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname='steam_top_app' \gexec
SELECT format('REVOKE steam_top_app FROM %I',member.rolname) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE parent.rolname='steam_top_app' \gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM steam_top_app',current_database()) \gexec
REVOKE ALL ON SCHEMA public,restore_control FROM steam_top_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public,restore_control FROM steam_top_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public,restore_control FROM steam_top_app;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public,restore_control FROM steam_top_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public,restore_control FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM steam_top_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM steam_top_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM steam_top_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO steam_top_app',current_database()) \gexec
GRANT USAGE ON SCHEMA public TO steam_top_app;
SELECT format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO steam_top_app',tablename) FROM pg_tables WHERE schemaname='public' AND tablename<>'app_schema_migrations' ORDER BY tablename \gexec
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO steam_top_app;
DO $assert$ BEGIN
IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles p ON p.oid=m.roleid WHERE r.rolname='steam_top_app' OR p.rolname='steam_top_app')
 OR has_schema_privilege('PUBLIC','public','CREATE') OR has_schema_privilege('steam_top_app','restore_control','USAGE')
 OR has_table_privilege('steam_top_app','public.app_schema_migrations','SELECT,INSERT,UPDATE,DELETE')
 OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename<>'app_schema_migrations' AND NOT has_table_privilege('steam_top_app',format('%I.%I',schemaname,tablename),'SELECT,INSERT,UPDATE,DELETE'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','restore_control') AND has_function_privilege('steam_top_app',p.oid,'EXECUTE'))
THEN RAISE EXCEPTION 'steam_top_app privilege catalog mismatch';END IF;END $assert$;
COMMIT;
