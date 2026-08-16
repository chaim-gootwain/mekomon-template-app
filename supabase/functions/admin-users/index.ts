// admin-users — ניהול משתמשים ע"י מנהל (הזמנה במייל + מחיקה)
// דורש service_role. מאמת שהקורא הוא admin פעיל לפני כל פעולה.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    // אימות הקורא — חייב להיות admin פעיל
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uErr } = await caller.auth.getUser();
    if (uErr || !user) return json({ error: 'לא מזוהה' }, 401);
    const { data: prof } = await svc.from('profiles').select('role, active').eq('id', user.id).single();
    if (!prof || prof.role !== 'admin' || prof.active === false) {
      return json({ error: 'אין הרשאה — נדרש מנהל' }, 403);
    }

    const body = await req.json();
    const action = body.action;

    if (action === 'invite') {
      const { email, full_name, phone, role, redirectTo } = body;
      if (!email || !role) return json({ error: 'חסר אימייל או תפקיד' }, 400);
      const { data: inv, error: iErr } = await svc.auth.admin.inviteUserByEmail(email, {
        data: { full_name: full_name || '' },
        redirectTo: redirectTo || undefined,
      });
      if (iErr) return json({ error: iErr.message }, 400);
      const newId = inv?.user?.id;
      if (newId) {
        await svc.from('profiles').update({
          full_name: full_name || '',
          phone: phone || '',
          role,
        }).eq('id', newId);
      }
      return json({ ok: true, id: newId });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) return json({ error: 'חסר מזהה משתמש' }, 400);
      const { error: dErr } = await svc.auth.admin.deleteUser(id);
      if (dErr) return json({ error: dErr.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'פעולה לא מוכרת' }, 400);
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : String(e) }, 500);
  }
});
