#!/usr/bin/env bash
# בונה את app.bundle.js מכל קובצי js/ לפי סדר הטעינה, ומעדכן cache-busting.
set -e
ORDER="api app notifications alerts leads lead-delete lead-deal ai customers customer-picker deals customer-tags customer-contacts customer-merge invoices invoice-charge agents sales ads graphics-proof issues issue-entry issue-expenses pdf-import subscriptions classified import-complete issue-billing monthly-billing approve-import articles billing collections finance finance-hub invoice-reconcile customer-statement ad-proof print-verify ad-status weekly-review customer-comm customer-files customer-tasks attendance reports admin invoice-chat data-entry-chat team-chat pending-invoice-popup"
> app.bundle.js
for name in $ORDER; do
  echo "/* ===== js/$name.js ===== */" >> app.bundle.js
  cat "js/$name.js" >> app.bundle.js
  printf '\n\n' >> app.bundle.js
done
node -c app.bundle.js
# הסרת הערות מהקובץ הנפרס: שרתי סינון (אתרוג וכד') מוחקים שורות מהערות
# עברית עם מרכאות ושוברים את הקוד. ההערות נשארות בקוד המקור — רק לא נשלחות.
if npx --yes terser@5.44.0 app.bundle.js --format comments=false,beautify=true -o app.bundle.stripped.js 2>/dev/null; then
  mv app.bundle.stripped.js app.bundle.js
  node -c app.bundle.js
  echo "✓ comments stripped"
else
  echo "⚠ terser unavailable — deploying with comments"
fi
# טביעת אצבע לבדיקת שלמות בדפדפן (check.html בדיקה 8)
HASH=$(sha256sum app.bundle.js | cut -d' ' -f1)
BYTES=$(wc -c < app.bundle.js)
printf '{"sha256":"%s","bytes":%s}' "$HASH" "$BYTES" > bundle.hash.json
V="${COMMIT_REF:-$(date +%s)}"; V="${V:0:12}"
sed -i "s#app.bundle.js?v=[A-Za-z0-9]*#app.bundle.js?v=$V#" index.html
sed -i "s#css/style.css?v=[A-Za-z0-9]*#css/style.css?v=$V#" index.html
echo "✓ built app.bundle.js  (version $V)"
