// admin-users — ניהול משתמשים ע"י מנהל (הזמנה במייל + מחיקה)
// דורש service_role. מאמת שהקורא הוא admin פעיל לפני כל פעולה.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json'
    }
  });
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: cors
  });
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    // 1) אימות הקורא — חייב להיות admin פעיל
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(url, anon, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: uData, error: uErr } = await caller.auth.getUser();
    if (uErr || !uData || !uData.user) return json({
      error: 'לא מחובר'
    }, 401);
    const admin = createClient(url, svc);
    const { data: prof } = await admin.from('profiles').select('role, active').eq('id', uData.user.id).single();
    if (!prof || prof.role !== 'admin' || prof.active === false) return json({
      error: 'אין הרשאה — מנהל בלבד'
    }, 403);
    const body = await req.json().catch(()=>({}));
    const action = body.action;
    // 2) הזמנת משתמש חדש במייל
    if (action === 'invite') {
      const email = String(body.email || '').trim().toLowerCase();
      const full_name = String(body.full_name || '').trim();
      const phone = String(body.phone || '').trim();
      const role = String(body.role || 'pending');
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({
        error: 'מייל לא תקין'
      }, 400);
      const { data: inv, error: iErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: {
          full_name
        },
        redirectTo: body.redirectTo || undefined
      });
      if (iErr) return json({
        error: iErr.message
      }, 400);
      // קביעת התפקיד + הפרטים בפרופיל (דורס את ברירת המחדל 'pending')
      const uid = inv.user.id;
      const { error: pErr } = await admin.from('profiles').upsert({
        id: uid,
        full_name,
        phone,
        role,
        active: true
      });
      if (pErr) return json({
        error: 'ההזמנה נשלחה אך נכשל עדכון התפקיד: ' + pErr.message
      }, 400);
      return json({
        ok: true,
        id: uid
      });
    }
    // 3) מחיקת משתמש לצמיתות
    if (action === 'delete') {
      const id = String(body.id || '');
      if (!id) return json({
        error: 'חסר מזהה'
      }, 400);
      if (id === uData.user.id) return json({
        error: 'אי אפשר למחוק את עצמך'
      }, 400);
      await admin.from('profiles').delete().eq('id', id);
      const { error: dErr } = await admin.auth.admin.deleteUser(id);
      if (dErr) return json({
        error: dErr.message
      }, 400);
      return json({
        ok: true
      });
    }
    return json({
      error: 'פעולה לא מוכרת'
    }, 400);
  } catch (e) {
    return json({
      error: String(e && e.message || e)
    }, 500);
  }
});
