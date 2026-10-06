// extract-advertisers — זיהוי מפרסמים בעמוד של עיתון/מגזין/עלון (Claude Vision)
// הדפדפן (js/prospects.js) ממיר כל עמוד PDF לתמונה ושולח עמוד אחד בכל קריאה —
// כך אין מגבלת עמודים ואין חשש מ-timeout. הפונקציה רק מזהה ומחזירה JSON;
// לא כותבת לטבלאות. מנהל בלבד. הסוד ANTHROPIC_API_KEY משותף עם parse-entry.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('PROSPECT_MODEL') || Deno.env.get('INVOICE_PARSE_MODEL') || 'claude-sonnet-4-5';
const MAX_IMAGE_B64 = 7_000_000; // ~5MB תמונה

const SIZES = ['full', 'half', 'third', 'quarter', 'eighth', 'strip', 'small', 'classified'];
const KINDS = ['business', 'editorial', 'own_house', 'public_notice', 'personal', 'other'];
const FITS = ['local', 'serves_area', 'online_national', 'far'];

function buildSystem(paperName: string, region: string, contentRules: string) {
  return `אתה עוזר מכירות של המקומון "${paperName}". האזור שהעיתון משרת: ${region}.
תקבל תמונה של עמוד אחד מעיתון, מגזין או עלון. תפקידך לזהות כל מודעה בעמוד ולחלץ את פרטי המפרסם,
כדי שנוכל להציע לו לפרסם אצלנו. החזר JSON בלבד — בלי טקסט נוסף ובלי גדרות קוד.

מבנה הפלט (בדיוק):
{
  "ads": [
    {
      "business_name": "string",
      "phone": "string | null",
      "phone2": "string | null",
      "email": "string | null",
      "website": "string | null",
      "field": "תחום העסק בעברית, 1-3 מילים",
      "location": "יישוב/כתובת העסק אם מופיע | null",
      "service_area": "אזור השירות אם מצוין (למשל 'כל השומרון', 'משלוחים לכל הארץ') | null",
      "is_online": boolean,
      "size": "${SIZES.join(' | ')}",
      "bbox": [x0, y0, x1, y1],
      "kind": "${KINDS.join(' | ')}",
      "region_fit": "${FITS.join(' | ')}",
      "content_ok": boolean,
      "content_reason": "string | null",
      "summary": "מה המודעה מציעה, עד 12 מילים"
    }
  ]
}

הנחיות:
- מודעה = כל שטח פרסומי נפרד בעמוד, כולל מודעות לוח קטנות. כל מודעה פריט נפרד.
- bbox: מיקום המודעה בעמוד כשברים בין 0 ל-1 ביחס לרוחב ולגובה התמונה (x0,y0 = פינה שמאלית-עליונה, x1,y1 = ימנית-תחתונה). היה מדויק — לפי זה חותכים את צילום המודעה. כלול את כל המודעה עם שוליים קטנים.
- size: לפי החלק היחסי מהעמוד — full=עמוד שלם, half=חצי, third=שליש, quarter=רבע, eighth=שמינית, strip=רצועה/סטריפ, small=קטנה ממש, classified=מודעת לוח מילולית.
- kind: business=מודעה של עסק/נותן שירות/מוסד שמוכר משהו (זה מה שאנחנו מחפשים) · editorial=כתבה/תוכן מערכתי · own_house=מודעה של העיתון עצמו (מנויים, "פרסמו אצלנו") · public_notice=הודעה רשמית של מועצה/רשות, מכרז, הודעת אבל/מזל טוב · personal=מודעה פרטית של אדם (דירה להשכרה, מכירת חפץ יד שנייה) · other.
- טלפונים: העתק בדיוק כפי שמופיעים (ספרות ומקפים). אם יש כמה — הראשי ב-phone והשני ב-phone2. אל תמציא מספר.
- is_online=true כשהעסק מוכר/משרת אונליין או בכל הארץ (אתר, משלוחים ארציים, שירות מקוון).
- region_fit: local=העסק נמצא באזור שלנו · serves_area=נמצא מחוץ לאזור אבל מגיע/משרת אותו (או אזור רחב שכולל אותו) · online_national=עסק אונליין/ארצי שרלוונטי לכל אחד · far=עסק מקומי של אזור אחר שלא מגיע אלינו. כשאין מידע על מיקום — online_national אם יש אתר/משלוחים, אחרת serves_area.
- content_ok: האם המודעה מתאימה לאופי העיתון שלנו. ${contentRules}
  content_ok=false רק כשהמודעה ברורה שאינה מתאימה, ואז content_reason קצר.
- שדה שאינו מופיע → null. אל תנחש פרטי קשר.
- אם אין בעמוד אף מודעה → {"ads": []}.`;
}

function extractJson(text: unknown) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { return null; }
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));

function normalizeAd(a: any) {
  if (!a || typeof a !== 'object') return null;
  const name = str(a.business_name);
  if (!name) return null;
  let bbox = Array.isArray(a.bbox) && a.bbox.length === 4 ? a.bbox.map(clamp01) : null;
  if (bbox) {
    const [x0, y0, x1, y1] = bbox;
    bbox = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    if (bbox[2] - bbox[0] < 0.01 || bbox[3] - bbox[1] < 0.01) bbox = null;
  }
  return {
    business_name: name,
    phone: str(a.phone), phone2: str(a.phone2), email: str(a.email), website: str(a.website),
    field: str(a.field), location: str(a.location), service_area: str(a.service_area),
    is_online: a.is_online === true,
    size: SIZES.includes(a.size) ? a.size : 'small',
    bbox,
    kind: KINDS.includes(a.kind) ? a.kind : 'other',
    region_fit: FITS.includes(a.region_fit) ? a.region_fit : 'serves_area',
    content_ok: a.content_ok !== false,
    content_reason: str(a.content_reason),
    summary: str(a.summary)
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body: any = await req.json().catch(() => ({}));

    // הרשאה: מנהל פעיל בלבד
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'לא מזוהה' }, 401);
    const { data: prof } = await svc.from('profiles').select('role,active').eq('id', user.id).single();
    if (!prof || !prof.active || prof.role !== 'admin') return json({ error: 'אין הרשאה' }, 403);

    if (!API_KEY) return json({ error: 'ANTHROPIC_API_KEY לא הוגדר ב-Supabase' }, 500);
    if (body.probe) return json({ probe: true, ok: true });

    const image = String(body.image_b64 || '');
    const mediaType = body.media_type === 'image/png' ? 'image/png' : 'image/jpeg';
    if (!image) return json({ error: 'לא התקבלה תמונת עמוד' }, 400);
    if (image.length > MAX_IMAGE_B64) return json({ error: 'תמונת העמוד גדולה מדי' }, 413);

    const paperName = str(body.paper_name) || '@@PAPER_NAME@@';
    const region = str(body.region) || paperName;
    const contentRules = str(body.content_rules) ||
      'העיתון קהילתי-משפחתי ושמרני: מודעה שאינה צנועה, או שתוכנה לא הולם קהל משפחתי ושמרני — content_ok=false.';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: buildSystem(paperName, region, contentRules),
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'זהה את כל המודעות בעמוד הזה והחזר JSON בלבד.' }
          ]
        }]
      })
    });
    const rText = await r.text();
    if (!r.ok) return json({ error: 'שגיאת זיהוי (' + r.status + ')', detail: rText.slice(0, 300) }, 502);
    let resp: any; try { resp = JSON.parse(rText); } catch (_) { resp = {}; }
    const content = (resp.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    const raw = extractJson(content);
    if (!raw || !Array.isArray(raw.ads)) return json({ error: 'הזיהוי לא החזיר JSON תקין' }, 422);
    const ads = raw.ads.map(normalizeAd).filter(Boolean);
    return json({ ok: true, ads, usage: resp.usage || null });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
