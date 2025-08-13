/***** تنظیمات کلی *****/
const TZ = 'Asia/Tehran';       // منطقه زمانی
const CALENDAR_ID = 'melipayamak@gmail.com';    // یا ایمیل/ID تقویم
const REMINDER_MINUTES = 30;      // چند دقیقه قبل از شروع رویداد پیامک بده
const DEDUP_STORE_KEY = 'NOTIFIED_KEYS'; // برای جلوگیری از ارسال تکراری

/***** از اینجا به بعد نیازی به تغییر نیست. *****/

function sendUpcomingEventSMS() {
  const props = PropertiesService.getScriptProperties();
  const username = props.getProperty('MELI_USERNAME');
  const password = props.getProperty('MELI_PASSWORD');
  const bodyId   = Number(props.getProperty('MELI_BODY_ID') || 0);

  if (!username || !password || !bodyId) {
    throw new Error('Script properties ناقص است: MELI_USERNAME, MELI_PASSWORD, MELI_BODY_ID');
  }

  const now = new Date();
  const ahead = new Date(now.getTime() + REMINDER_MINUTES * 60 * 1000);

  const events = Calendar.Events.list(CALENDAR_ID, {
    timeMin: now.toISOString(),
    timeMax: ahead.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  }).items || [];

  const dedup = loadDedupSet_();

  events.forEach(ev => {
    const startIso = (ev.start.dateTime || ev.start.date || '').toString();
    const key = ev.id + '|' + startIso + '|' + REMINDER_MINUTES;
    if (dedup.has(key)) return; // قبلاً ارسال شده

    const meta = parseDescription_(ev.description || '');
    const recipients = meta.toList.length ? meta.toList : []; // آرایه شماره‌ها
    if (!recipients.length) return; // شماره نداریم؛ رد شو

    // ساخت متن/مقادیر پترن
    const startText = formatWhen_(ev.start);
    const title = ev.summary || '(بدون عنوان)';
    const vars = meta.vars.length ? meta.vars : buildDefaultVars_(title, startText);

    // --- ارسال با SOAP (SendByBaseNumber) ---
    const okAll = recipients.map(to => sendByBaseNumberSOAP_(username, password, vars, to, bodyId))
                            .every(Boolean);

    if (okAll) {
      dedup.add(key);
      Utilities.sleep(300); // محدودیت نرخ احتمالی
    }
  });

  saveDedupSet_(dedup);
}

/***** کمکی‌ها *****/

// Description را می‌خوانیم: to=09.., vars=val1 | val2 | ...
function parseDescription_(desc) {
  const toMatch = desc.match(/to\s*=\s*([0-9,\s]+)/i);
  const varsMatch = desc.match(/vars\s*=\s*(.+)/i);

  const toList = toMatch ? toMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  const vars = varsMatch ? varsMatch[1].split('|').map(s => s.trim()) : [];
  return { toList, vars };
}

// اگر vars تعریف نشده بود، یک آرایه پیش‌فرض بر اساس پترن خودت بساز
function buildDefaultVars_(summary, startText) {
  // فرض: پترن شما سه متغیر دارد: {name} {title} {time}
  // اگر پترن‌تان فرق دارد، اینجا را تغییر بده
  const name = 'کاربر عزیز';
  return [name, summary, startText];
}

function formatWhen_(start) {
  // start: { dateTime?: string, date?: string }
  const z = Utilities.formatDate;
  if (start.dateTime) {
    const d = new Date(start.dateTime);
    return z(d, TZ, 'yyyy-MM-dd HH:mm');
  } else if (start.date) {
    // رویداد تمام‌روز
    const d = new Date(start.date + 'T00:00:00');
    return z(d, TZ, 'yyyy-MM-dd (All day)');
  }
  return '';
}

/***** ذخیره کلیدهای ارسال‌شده برای جلوگیری از تکرار *****/
function loadDedupSet_() {
  const raw = PropertiesService.getUserProperties().getProperty(DEDUP_STORE_KEY);
  const arr = raw ? JSON.parse(raw) : [];
  return new Set(arr);
}
function saveDedupSet_(setObj) {
  const arr = Array.from(setObj);
  PropertiesService.getUserProperties().setProperty(DEDUP_STORE_KEY, JSON.stringify(arr));
}

/***** ارسال پترنی با SOAP ملی‌پیامک *****/
function sendByBaseNumberSOAP_(username, password, varsArray, to, bodyId) {
  // SOAP 1.1 → text/xml + SOAPAction
  const url = 'http://api.payamak-panel.com/post/Send.asmx';
  const soapAction = 'http://tempuri.org/SendByBaseNumber';

  // آرایه متغیرها در SOAP باید به صورت <string>...</string> تکرار شود
  const varsXml = varsArray.map(v => `<string>${xmlEscape_(v)}</string>`).join('');

  const envelope =
`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SendByBaseNumber xmlns="http://tempuri.org/">
      <username>${xmlEscape_(username)}</username>
      <password>${xmlEscape_(password)}</password>
      <text>
        ${varsXml}
      </text>
      <to>${xmlEscape_(to)}</to>
      <bodyId>${Number(bodyId)}</bodyId>
    </SendByBaseNumber>
  </soap:Body>
</soap:Envelope>`;

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'text/xml; charset=utf-8',
    payload: envelope,
    headers: { 'SOAPAction': soapAction },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  // بسته به پاسخ سرویس، این شرط را دقیق‌تر کن
  const success = (code >= 200 && code < 300) && /SendByBaseNumberResult/i.test(body);
  if (!success) {
    console.warn('SOAP send failed', code, body);
  }
  return success;
}

function xmlEscape_(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
