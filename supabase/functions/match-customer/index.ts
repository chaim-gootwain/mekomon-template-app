// match-customer — התאמת שם לקוח מהמלל לכרטיס לקוח קיים (חיפוש fuzzy)
// סובלני לשגיאות כתיב, לתחיליות ("ל", "ה") ולסדר מילים שונה.
// לעולם לא מנחש: התאמה יחידה בטוחה → single · כמה דומים → multiple · אחרת none.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

/* ---------- ניקוד דמיון (ללא ספריות חיצוניות) ---------- */
function norm(s) {
  return String(s || '')
    .replace(/["'`״׳]/g, '')
    .replace(/[-–—ـ]/g, ' ')
    .replace(/[^֐-׿a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
/* אותיות סופיות → רגילות, כדי ש"עתון"/"עיתון" ו-ם/מ לא יפריעו */
function foldFinals(s) {
  return s.replace(/ם/g, 'מ').replace(/ן/g, 'נ').replace(/ץ/g, 'צ').replace(/ף/g, 'פ').replace(/ך/g, 'כ');
}
function words(s) { return foldFinals(norm(s)).split(' ').filter(Boolean); }

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function wordSim(a, b) {
  if (!a.length || !b.length) return 0;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}
/* דמיון בין שני שמות: ממוצע ההתאמות הטובות ביותר מילה-מול-מילה,
   אדיש לסדר המילים; מילה בלי בת-זוג מורידה את הציון. */
function nameSim(qWords, cWords) {
  if (!qWords.length || !cWords.length) return 0;
  const scoreOneWay = (from, to) => {
    let sum = 0;
    for (const w of from) {
      let best = 0;
      for (const t of to) { const s = wordSim(w, t); if (s > best) best = s; }
      sum += best;
    }
    return sum / from.length;
  };
  return (scoreOneWay(qWords, cWords) + scoreOneWay(cWords, qWords)) / 2;
}
/* תחיליות יחס נפוצות בתחילת השם מהמלל ("לגן ורדים" → גם "גן ורדים") */
function queryVariants(raw) {
  const base = foldFinals(norm(raw));
  const out = new Set([base]);
  const m = base.match(/^([להב])(.{2,})$/);
  if (m) out.add(m[2].trim());
  return [...out].filter(Boolean);
}
function scoreCustomer(rawQuery, cust) {
  const variants = queryVariants(rawQuery).map(v => v.split(' ').filter(Boolean));
  const names = [cust.name, cust.invoice_name].filter(Boolean).map(words);
  let best = 0;
  for (const q of variants) for (const n of names) {
    const s = nameSim(q, n);
    if (s > best) best = s;
  }
  return best;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = await req.json().catch(() => ({}));

    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'לא מזוהה' }, 401);
    const { data: prof } = await svc.from('profiles').select('role,active').eq('id', user.id).single();
    if (!prof || !prof.active || (prof.role !== 'admin' && prof.role !== 'sales')) return json({ error: 'אין הרשאה' }, 403);

    const name = String(body.name || '').trim();
    if (!name) return json({ error: 'לא התקבל שם לקוח' }, 400);

    const { data: customers, error } = await svc.from('customers')
      .select('id, name, invoice_name, business_id, phone, email');
    if (error) return json({ error: 'שגיאה בטעינת לקוחות: ' + error.message }, 500);

    const scored = (customers || [])
      .map(c => ({ id: c.id, name: c.name, invoice_name: c.invoice_name, business_id: c.business_id, score: Math.round(scoreCustomer(name, c) * 100) / 100 }))
      .filter(c => c.score >= 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    // single: מוביל ברור מעל הסף, עם פער מספיק מהבא אחריו — אחרת לא מנחשים
    let match = 'none';
    if (scored.length === 1 && scored[0].score >= 0.72) match = 'single';
    else if (scored.length > 1) {
      if (scored[0].score >= 0.88 && scored[0].score - scored[1].score >= 0.15) match = 'single';
      else match = 'multiple';
    }
    return json({ ok: true, match, candidates: scored });
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : String(e) }, 500);
  }
});
