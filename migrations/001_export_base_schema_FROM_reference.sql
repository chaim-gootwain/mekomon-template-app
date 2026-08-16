-- חילוץ מבנה (schema-only) של סכימת public. מחזיר עמודה אחת full_ddl.
-- גרסה מתוקנת: PK/UNIQUE נוצרים לפני FK/CHECK.
select string_agg(ddl, E'\n\n' order by ord, seq) as full_ddl
from (
  select 1 ord, t.typname seq,
    'CREATE TYPE public.'||quote_ident(t.typname)||' AS ENUM ('||
      (select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder)
         from pg_enum e where e.enumtypid=t.oid)||');' ddl
  from pg_type t join pg_namespace n on n.oid=t.typnamespace
  where n.nspname='public' and t.typtype='e'
  union all
  select 2, c.relname, 'CREATE SEQUENCE IF NOT EXISTS public.'||quote_ident(c.relname)||';'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='S'
    and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype in ('i','e'))
  union all
  select 3, c.relname,
    'CREATE TABLE IF NOT EXISTS public.'||quote_ident(c.relname)||E' (\n'||
    (select string_agg('  '||quote_ident(a.attname)||' '||pg_catalog.format_type(a.atttypid,a.atttypmod)||
       case when a.attidentity in ('a','d') then ' GENERATED '||case a.attidentity when 'a' then 'ALWAYS' else 'BY DEFAULT' end||' AS IDENTITY'
            when a.attgenerated='s' then ' GENERATED ALWAYS AS ('||pg_get_expr(ad.adbin, ad.adrelid)||') STORED'
            when ad.adbin is not null then ' DEFAULT '||pg_get_expr(ad.adbin, ad.adrelid)
            else '' end||
       case when a.attnotnull then ' NOT NULL' else '' end, E',\n' order by a.attnum)
     from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum
     where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)||E'\n);'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r'
    and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')
  union all
  -- 4. PK + UNIQUE (חייבים לבוא לפני FK)
  select 4, rel.relname||'.'||con.conname,
    'ALTER TABLE public.'||quote_ident(rel.relname)||' ADD CONSTRAINT '||quote_ident(con.conname)||' '||pg_get_constraintdef(con.oid)||';'
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
  join pg_namespace n on n.oid=rel.relnamespace where n.nspname='public' and con.contype in ('p','u')
  union all
  -- 5. CHECK + FK (אחרי כל ה-PK/UNIQUE)
  select 5, rel.relname||'.'||con.conname,
    'ALTER TABLE public.'||quote_ident(rel.relname)||' ADD CONSTRAINT '||quote_ident(con.conname)||' '||pg_get_constraintdef(con.oid)||';'
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
  join pg_namespace n on n.oid=rel.relnamespace where n.nspname='public' and con.contype in ('c','f')
  union all
  select 6, ic.relname, pg_get_indexdef(i.indexrelid)||';'
  from pg_index i join pg_class ic on ic.oid=i.indexrelid
  join pg_class tc on tc.oid=i.indrelid join pg_namespace n on n.oid=tc.relnamespace
  where n.nspname='public' and not exists (select 1 from pg_constraint con where con.conindid=i.indexrelid)
  union all
  select 7, p.proname, pg_get_functiondef(p.oid)||';'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f'
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
  union all
  select 8, t.tgname, pg_get_triggerdef(t.oid)||';'
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and not t.tgisinternal
  union all
  select 9, c.relname, 'ALTER TABLE public.'||quote_ident(c.relname)||' ENABLE ROW LEVEL SECURITY;'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relrowsecurity
  union all
  select 10, pol.polname,
    'CREATE POLICY '||quote_ident(pol.polname)||' ON public.'||quote_ident(c.relname)||
    ' AS '||case when pol.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end||
    ' FOR '||case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end||
    ' TO '||coalesce(nullif((select string_agg(r.rolname, ', ' order by r.rolname) from pg_roles r where r.oid = any(pol.polroles)),''),'public')||
    coalesce(' USING ('||pg_get_expr(pol.polqual, pol.polrelid)||')','')||
    coalesce(' WITH CHECK ('||pg_get_expr(pol.polwithcheck, pol.polrelid)||')','')||';'
  from pg_policy pol join pg_class c on c.oid=pol.polrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
  union all
  select 11, c.relname, 'GRANT ALL ON public.'||quote_ident(c.relname)||' TO anon, authenticated, service_role;'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
  union all
  select 12, c.relname, 'GRANT ALL ON SEQUENCE public.'||quote_ident(c.relname)||' TO anon, authenticated, service_role;'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='S'
) x;
