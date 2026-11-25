-- צ'אט צוות: ערוץ "בעיות לתיקון" (fixes) — עורך וגרפיקה מדווחים למנהל
-- על תקלות ושיפורים במערכת. מנהל רואה הכל ממילא (emu_is_admin).
-- idempotent: drop + create של שתי המדיניות בלבד, בלי נגיעה בנתונים.

drop policy if exists team_messages_select on public.team_messages;
create policy team_messages_select on public.team_messages
  for select to authenticated
  using (
    public.emu_is_admin()
    or ( public.my_role() in ('sales', 'editor', 'graphics') and channel = 'group' )
    or ( public.my_role() in ('editor', 'graphics') and channel = 'fixes' )
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
      or ( public.my_role() in ('editor', 'graphics') and channel = 'fixes' )
      or ( public.my_role() = 'sales'
           and channel = 'dm:' || public.my_agent_id()::text )
    )
  );

-- אילוץ הערוצים בטבלה: להוסיף את 'fixes' (בלי זה השליחה נכשלת ב-team_messages_channel_check)
alter table public.team_messages drop constraint if exists team_messages_channel_check;
alter table public.team_messages add constraint team_messages_channel_check
  check (channel in ('group', 'fixes') or channel like 'dm:%');
