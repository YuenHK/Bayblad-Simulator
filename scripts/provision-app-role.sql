BEGIN;
SELECT pg_advisory_xact_lock(1937002751);
DO $dedicated_cluster$ DECLARE bad text; BEGIN
SELECT string_agg(datname,',' ORDER BY datname) INTO bad FROM pg_database
 WHERE datname NOT IN(current_database(),'postgres','template0','template1');
IF bad IS NOT NULL THEN RAISE EXCEPTION 'dedicated PostgreSQL cluster required; unexpected databases: %',bad; END IF;
IF current_database() IN('postgres','template0','template1')
 OR (SELECT count(*) FROM pg_database WHERE datname IN(current_database(),'postgres','template0','template1'))<>4
 OR EXISTS(SELECT 1 FROM pg_database WHERE pg_get_userbyid(datdba)<>current_user)
 OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='template0' AND datistemplate AND NOT datallowconn)
 OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='template1' AND datistemplate AND datallowconn)
 OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='postgres' AND NOT datistemplate AND datallowconn)
 OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND NOT datistemplate AND datallowconn)
THEN RAISE EXCEPTION 'dedicated PostgreSQL cluster catalog invariant failed'; END IF;
END $dedicated_cluster$;
SELECT format('CREATE ROLE steam_top_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='steam_top_app') \gexec
DO $ownership$ BEGIN
IF EXISTS(SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname='steam_top_app')
 OR EXISTS(SELECT 1 FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid WHERE r.rolname='steam_top_app' AND d.deptype='o')
 OR EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname='steam_top_app')
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='steam_top_app')
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname='steam_top_app')
 OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_roles r ON r.oid=t.typowner WHERE r.rolname='steam_top_app')
THEN RAISE EXCEPTION 'steam_top_app owns database objects; audited ownership recovery required';END IF;END $ownership$;
ALTER ROLE steam_top_app RESET ALL;
SELECT format('ALTER ROLE steam_top_app IN DATABASE %I RESET ALL',d.datname) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole JOIN pg_database d ON d.oid=s.setdatabase WHERE r.rolname='steam_top_app' ORDER BY d.datname \gexec
ALTER ROLE steam_top_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity';
SELECT format('REVOKE %I FROM steam_top_app',parent.rolname) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname='steam_top_app' \gexec
SELECT format('REVOKE steam_top_app FROM %I',member.rolname) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE parent.rolname='steam_top_app' \gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM steam_top_app',current_database()) \gexec
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC,steam_top_app;
REVOKE CONNECT ON DATABASE template0 FROM PUBLIC,steam_top_app;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC,steam_top_app;
REVOKE ALL ON SCHEMA public,restore_control FROM steam_top_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()) \gexec
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public,restore_control FROM steam_top_app;
SELECT format('REVOKE %s (%I) ON TABLE %I.%I FROM steam_top_app',privilege,a.attname,n.nspname,c.relname) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege) WHERE n.nspname IN('public','restore_control') AND c.relkind IN('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum \gexec
SELECT format('REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC',privilege,a.attname,n.nspname,c.relname) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege) WHERE n.nspname IN('public','restore_control') AND c.relkind IN('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum \gexec
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
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='steam_top_app' AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls OR rolconnlimit<>-1 OR rolvaliduntil IS DISTINCT FROM 'infinity'::timestamptz OR rolconfig IS NOT NULL))
 OR EXISTS(SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='steam_top_app')
 OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datname<>current_database() AND has_database_privilege('steam_top_app',d.datname,'CONNECT'))
 OR has_database_privilege('steam_top_app',current_database(),'CREATE,TEMPORARY') OR EXISTS(SELECT 1 FROM pg_namespace n,aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE') OR has_schema_privilege('steam_top_app','restore_control','USAGE')
 OR has_table_privilege('steam_top_app','public.app_schema_migrations','SELECT,INSERT,UPDATE,DELETE')
 OR EXISTS(SELECT 1 FROM pg_tables CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE')) required(privilege) WHERE schemaname='public' AND tablename<>'app_schema_migrations' AND NOT has_table_privilege('steam_top_app',format('%I.%I',schemaname,tablename),required.privilege))
 OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND has_table_privilege('steam_top_app',format('%I.%I',schemaname,tablename),'TRUNCATE,REFERENCES,TRIGGER'))
 OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace,unnest(coalesce(a.attacl,'{}'::aclitem[])) acl WHERE n.nspname IN('public','restore_control') AND a.attnum>0 AND NOT a.attisdropped AND (acl::text LIKE 'steam_top_app=%' OR acl::text LIKE '=%'))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('USAGE'),('SELECT'),('UPDATE')) required(privilege) WHERE n.nspname='public' AND c.relkind='S' AND NOT has_sequence_privilege('steam_top_app',c.oid,required.privilege))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','restore_control') AND has_function_privilege('steam_top_app',p.oid,'EXECUTE'))
 OR EXISTS(SELECT 1 FROM pg_default_acl d,aclexplode(coalesce(d.defaclacl,acldefault(d.defaclobjtype,d.defaclrole))) a JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname='steam_top_app')
THEN RAISE EXCEPTION 'steam_top_app privilege catalog mismatch';END IF;END $assert$;
COMMIT;
