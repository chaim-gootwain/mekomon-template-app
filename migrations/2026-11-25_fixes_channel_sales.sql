-- ערוץ "בעיות לתיקון" (fixes) פתוח גם לסוכנים (sales).
-- מחליף את 2026-11-25_team_chat_fixes_channel.sql (מדיניות בלבד; האילוץ לא משתנה).
-- idempotent: drop + create.

drop policy if exists team_messages_select on public.team_messages;
create policy team_messages_select on public.team_messages
  for select to authenticated
  using (
    public.emu_is_admin()
    or ( public.my_role() in ('sales', 'editor', 'graphics') and channel = 'group' )
    or ( public.my_role() in ('sales', 'editor', 'graphics') and channel = 'fixes' )
    or ( public.my_role() = 'sales'
         and channel = 'dm:' || public.my_agent_id()::text )
  );

drop policy if exists team_messages_insert on public.team_messages;
create policy team_messages_insert on public.team_messages
  for insert to authenticated
  with check (
    sender_user = auth.uid()
    and (
      public.emu_is_admin()
      or ( public.my_role() in ('sales', 'editor', 'graphics') and channel = 'group' )
      or ( public.my_role() in ('sales', 'editor', 'graphics') and channel = 'fixes' )
      or ( public.my_role() = 'sales'
           and channel = 'dm:' || public.my_agent_id()::text )
    )
  );
