#!/bin/bash
# First-boot only: create the PostgREST login role `authenticator`, let it assume
# the (no-login) `anon` role from schema.sql, and set its password to the value
# Coolify injects (also given to PostgREST as PGPASSWORD). Runs as the superuser
# against the freshly-initialized `distvis` database.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname distvis <<-SQL
  do \$\$
  begin
    if not exists (select 1 from pg_roles where rolname = 'authenticator') then
      create role authenticator login noinherit;
    end if;
  end
  \$\$;
  alter role authenticator login password '${AUTHENTICATOR_PASSWORD}';
  grant anon to authenticator;
SQL
