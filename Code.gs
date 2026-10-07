/**
 * 寶寶生理時鐘 LINE Bot（Google Apps Script 版）
 *
 * 紀錄會存在這個試算表的「紀錄」工作表裡。
 * 安裝方式請看 README.md。
 */

// ======== 設定：只需要改這裡 ========

// LINE Developers Console > Messaging API > Channel access token
const LINE_CHANNEL_ACCESS_TOKEN = '把你的 Channel access token 貼在這裡';

// ===================================

const TZ_NAME = 'Asia/Taipei';
const TZ_OFFSET_HOURS = 8; // 台灣沒有日光節約時間，固定 +8
const SHEET_NAME = '紀錄';
const GROWTH_SHEET_NAME = '成長曲線';
const HEADERS = ['編號', '聊天室', '類型', '開始時間', '結束時間', '數值', '單位', '內容', '記錄者', '建立時間'];

const SLEEP = 'sleep';
const FEED = 'feed';
const DIAPER = 'diaper';
const TEMP = 'temp';
const NOTE = 'note';
const GROWTH = 'growth';
const MED = 'med';
const BATH = 'bath';
const PUMP = 'pump';
const VACCINE = 'vaccine';
const CLINIC = 'clinic';

// 試算表裡顯示的中文類型名稱
const KIND_LABELS = {
  sleep: '睡眠', feed: '餵食', diaper: '排泄', temp: '體溫', note: '備註', growth: '成長',
  med: '吃藥', bath: '洗澡', pump: '擠奶', vaccine: '疫苗', clinic: '看診',
};
const LABEL_KINDS = {};
Object.keys(KIND_LABELS).forEach(function (k) { LABEL_KINDS[KIND_LABELS[k]] = k; });

// ======== LINE webhook 入口 ========

function doPost(e) {
  const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  const service = new BabyService(new SheetStorage());
  (body.events || []).forEach(function (event) {
    try {
      handleEvent(service, event);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      if (event.replyToken) replyText(event.replyToken, '😵 發生錯誤，請稍後再試一次。');
    }
  });
  return ContentService.createTextOutput('OK');
}

// 第一次安裝時在編輯器裡執行一次：建立「紀錄」工作表，並授權程式使用試算表和連網
function setup() {
  new SheetStorage();
  UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    muteHttpExceptions: true,
  });
  console.log('設定完成！接下來請按「部署」。');
}

// 用瀏覽器打開部署網址時會看到這個，用來確認部署成功
function doGet() {
  return ContentService.createTextOutput('寶寶紀錄 bot 運作中 👶');
}

function handleEvent(service, event) {
  if (event.type === 'follow' || event.type === 'join') {
    replyText(event.replyToken, '嗨！我是寶寶生理時鐘小幫手 👶\n\n' + HELP_TEXT);
    return;
  }
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;
  const text = service.handle(chatIdOf(event.source), event.message.text, event.source.userId || '');
  if (text) replyText(event.replyToken, text);
}

// 群組／聊天室共用同一份紀錄，讓爸媽一起記；一對一聊天則以使用者為單位
function chatIdOf(source) {
  return source.groupId || source.roomId || source.userId;
}

// 每則回覆下方的快速按鈕（LINE 最多 13 個）
const QUICK_ACTIONS = [
  ['🍼 喝奶', '喝奶'],
  ['😴 睡覺', '睡覺'],
  ['☀️ 起床', '起床'],
  ['💧 尿', '尿布 尿'],
  ['💩 便', '尿布 便'],
  ['🛁 洗澡', '洗澡'],
  ['⏱️ 狀態', '狀態'],
  ['📊 今天', '今天'],
  ['📋 最近', '最近'],
  ['📏 成長', '成長紀錄'],
  ['↩️ 復原', '復原'],
];

function replyText(replyToken, text) {
  const payload = {
    replyToken: replyToken,
    messages: [{
      type: 'text',
      text: text.slice(0, 5000),
      quickReply: {
        items: QUICK_ACTIONS.map(function (a) {
          return { type: 'action', action: { type: 'message', label: a[0], text: a[1] } };
        }),
      },
    }],
  };
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    console.error('LINE 回覆失敗 ' + res.getResponseCode() + ': ' + res.getContentText());
  }
}

// ======== 時間工具（以台灣時間計算） ========

function localParts(date) {
  const d = new Date(date.getTime() + TZ_OFFSET_HOURS * 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

function makeLocal(y, mo, d, h, mi) {
  return new Date(Date.UTC(y, mo, d, h, mi) - TZ_OFFSET_HOURS * 3600000);
}

function startOfDay(date) {
  const p = localParts(date);
  return makeLocal(p.y, p.mo, p.d, 0, 0);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function roundToMinutes(date, step) {
  const ms = step * 60000;
  return new Date(Math.round(date.getTime() / ms) * ms);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function fmtTime(date) {
  const p = localParts(date);
  return pad2(p.h) + ':' + pad2(p.mi);
}

function fmtDate(date) {
  const p = localParts(date);
  return pad2(p.mo + 1) + '/' + pad2(p.d);
}

function fmtFullDate(date) {
  const p = localParts(date);
  return p.y + '/' + pad2(p.mo + 1) + '/' + pad2(p.d);
}

function fmtDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return h + '小時' + m + '分';
  if (h) return h + '小時';
  return m + '分鐘';
}

function fmtAgo(date, now) {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days <= 0) return '今天稍早';
  return fmtDate(date) + '，' + days + ' 天前';
}

function fmtNum(v) {
  return String(Math.round(v * 100) / 100);
}

// ======== 指令解析 ========

function ParseError(message) {
  this.message = message;
}

const TIME_RE = '(\\d{1,2})[:：](\\d{2})';
const RANGE_SEP = '\\s*[-~～到至]\\s*';

const SLEEP_START_WORDS = ['睡覺', '睡著', '睡了', '入睡', '開始睡', '哄睡'];
const SLEEP_END_WORDS = ['起床', '醒了', '醒來', '睡醒', '醒'];
const FEED_WORDS = {
  母乳: '母乳', 親餵: '母乳', 瓶餵母乳: '瓶餵母乳', 瓶餵: '瓶餵', 配方奶: '配方奶', 配方: '配方奶',
  喝奶: '喝奶', 吃奶: '喝奶', 奶: '喝奶', 副食品: '副食品', 吃飯: '副食品', 吃: '副食品',
};
const DIAPER_WORDS = ['換尿布', '尿布', '排泄'];
const TEMP_WORDS = ['體溫', '溫度', '量體溫'];
const NOTE_WORDS = ['備註', '備忘', '筆記', '記事'];
const GROWTH_WORDS = { 體重: '體重', 身高: '身高', 身長: '身高', 頭圍: '頭圍' };
const MED_WORDS = ['吃藥', '餵藥', '用藥', '藥'];
const BATH_WORDS = ['洗澡', '泡澡'];
const PUMP_WORDS = ['擠奶', '擠母乳', '吸奶'];
const VACCINE_WORDS = ['打疫苗', '疫苗', '預防針', '打針'];
const CLINIC_WORDS = ['看診', '看醫生', '就醫', '門診', '回診'];
const EDIT_WORDS = ['修改', '更正'];
const EXPORT_WORDS = ['匯出', '導出'];

const QUERY_WORDS = {
  今天: 'today', 今日: 'today', 昨天: 'yesterday', 昨日: 'yesterday',
  最近: 'recent', 紀錄: 'recent', 記錄: 'recent', 歷史: 'recent',
  狀態: 'status', 現在: 'status', 多久: 'status',
  刪除: 'undo', 復原: 'undo', 取消: 'undo', 刪除上一筆: 'undo',
  說明: 'help', 幫助: 'help', 使用說明: 'help', 指令: 'help', help: 'help', '?': 'help',
};

// 「疫苗紀錄」這類查詢：列出某一類的所有紀錄
const HISTORY_WORDS = {
  成長: GROWTH, 成長紀錄: GROWTH, 成長曲線: GROWTH, 身高體重: GROWTH, 體重紀錄: GROWTH, 身高紀錄: GROWTH,
  吃藥紀錄: MED, 用藥紀錄: MED, 藥物紀錄: MED,
  洗澡紀錄: BATH,
  擠奶紀錄: PUMP,
  疫苗紀錄: VACCINE, 預防針紀錄: VACCINE,
  看診紀錄: CLINIC, 就醫紀錄: CLINIC,
  體溫紀錄: TEMP,
  備註紀錄: NOTE,
};

function normalizeText(text) {
  // NFKC 會把全形數字、全形冒號轉成半形
  return String(text || '').normalize('NFKC').trim();
}

function resolveTime(hh, mm, now) {
  const h = Number(hh);
  const m = Number(mm);
  if (h > 23 || m > 59) throw new ParseError('時間「' + hh + ':' + mm + '」不正確，請用 24 小時制，例如 14:30');
  const p = localParts(now);
  let t = makeLocal(p.y, p.mo, p.d, h, m);
  // 比現在晚超過 5 分鐘，就當作是昨天
  if (t.getTime() - now.getTime() > 5 * 60000) t = addMinutes(t, -24 * 60);
  return t;
}

// 支援「14:30 喝奶 120」或「尿布 便 09:15」這種加上時間的寫法
function stripTime(text, now) {
  let m = text.match(new RegExp('^' + TIME_RE + '\\s*(.*)$'));
  if (m && !new RegExp('^' + TIME_RE + RANGE_SEP).test(text)) {
    return { at: resolveTime(m[1], m[2], now), body: m[3].trim() };
  }
  m = text.match(new RegExp('^(.*?)\\s+' + TIME_RE + '$'));
  if (m && !new RegExp(TIME_RE + RANGE_SEP + TIME_RE + '$').test(text)) {
    return { at: resolveTime(m[2], m[3], now), body: m[1].trim() };
  }
  return { at: null, body: text };
}

/**
 * text 以 words 其中之一開頭，且後面接的是空白、結尾或 follow 規則允許的字元。
 * 限制後面的字元是為了避免在群組聊天時誤判，例如「吃飽了嗎」、「奶瓶洗了嗎」。
 */
function startsWithWord(text, words, follow) {
  const sorted = words.slice().sort(function (a, b) { return b.length - a.length; });
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (text.toLowerCase().indexOf(w) === 0) {
      const rest = text.slice(w.length);
      if (!rest || /^[\s:：]/.test(rest) || (follow && follow.test(rest))) return w;
    }
  }
  return null;
}

function cleanSpaces(s) {
  return s.split(/\s+/).filter(Boolean).join(' ');
}

function record(kind, at, fields) {
  const cmd = { action: 'record', kind: kind, at: at, value: null, unit: null, detail: '' };
  Object.keys(fields || {}).forEach(function (k) { cmd[k] = fields[k]; });
  return cmd;
}

function parseFeed(word, rest, at) {
  const kind = FEED_WORDS[word];
  const cmd = record(FEED, at);
  let side = null;
  const sides = [['左右', '左右'], ['雙邊', '左右'], ['左', '左'], ['右', '右']];
  for (let i = 0; i < sides.length; i++) {
    if (rest.indexOf(sides[i][0]) >= 0) {
      side = sides[i][1];
      rest = rest.replace(sides[i][0], ' ');
      break;
    }
  }
  const m = rest.match(/(\d+(?:\.\d+)?)\s*(ml|cc|毫升|c\.c\.|分鐘|分|min|g|克|口|匙)?/i);
  if (m) {
    const num = Number(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (['ml', 'cc', '毫升', 'c.c.'].indexOf(unit) >= 0) cmd.unit = 'ml';
    else if (['分鐘', '分', 'min'].indexOf(unit) >= 0) cmd.unit = '分鐘';
    else if (unit === 'g' || unit === '克') cmd.unit = 'g';
    else if (unit === '口' || unit === '匙') cmd.unit = unit;
    else if (kind === '母乳') cmd.unit = '分鐘';
    else if (kind === '副食品') cmd.unit = 'g';
    else cmd.unit = 'ml';
    cmd.value = num;
    rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim();
  }
  cmd.detail = [kind, side, cleanSpaces(rest)].filter(Boolean).join(' ');
  return cmd;
}

function parseDiaper(rest, at) {
  const pee = /尿|濕|小便|pee/i.test(rest);
  const poo = /便|屎|大|poo/i.test(rest.replace('小便', ''));
  if (!pee && !poo) throw new ParseError('請說明是「尿」還是「便」，例如：尿布 尿、尿布 便、尿布 尿+便');
  const label = pee && poo ? '尿+便' : poo ? '便' : '尿';
  const extra = cleanSpaces(rest.replace(/尿布|尿|濕|小便|大便|便便|便|屎|pee|poo|[+&和、,，]/gi, ' '));
  return record(DIAPER, at, { detail: label + (extra ? ' ' + extra : '') });
}

function parseTemp(rest, at) {
  const m = rest.match(/(\d{2}(?:\.\d+)?)/);
  if (!m) throw new ParseError('請輸入體溫數字，例如：體溫 37.2');
  const value = Number(m[1]);
  if (value < 30 || value > 45) throw new ParseError('體溫 ' + value + ' 看起來不太對，請輸入攝氏溫度，例如：體溫 37.2');
  const note = cleanSpaces((rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).replace(/度|°C/g, ' '));
  return record(TEMP, at, { value: value, unit: '°C', detail: note });
}

function parseGrowth(word, rest, at) {
  const what = GROWTH_WORDS[word];
  const m = rest.match(/(\d+(?:\.\d+)?)\s*(kg|公斤|g|克|公克|cm|公分)?/i);
  if (!m) throw new ParseError('請輸入數字，例如：' + (what === '體重' ? '體重 6.2' : what + ' 62'));
  let value = Number(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (what === '體重') {
    // 沒寫單位又大於 30，當作公克
    if (unit === 'g' || unit === '克' || unit === '公克' || (!unit && value > 30)) value = value / 1000;
    if (value < 0.5 || value > 40) throw new ParseError('體重 ' + fmtNum(value) + 'kg 看起來不太對，例如：體重 6.2 或 體重 6200g');
    return record(GROWTH, at, { value: Math.round(value * 1000) / 1000, unit: 'kg', detail: '體重' });
  }
  const range = what === '身高' ? [30, 150] : [25, 60];
  if (value < range[0] || value > range[1]) throw new ParseError(what + ' ' + fmtNum(value) + 'cm 看起來不太對，請用公分，例如：' + what + ' 62');
  return record(GROWTH, at, { value: value, unit: 'cm', detail: what });
}

function parseMed(rest, at) {
  const m = rest.match(/(\d+(?:\.\d+)?)\s*(ml|cc|毫升|mg|毫克|顆|錠|包|滴|匙|格)?/i);
  let value = null;
  let unit = null;
  if (m) {
    value = Number(m[1]);
    unit = (m[2] || 'ml').toLowerCase();
    if (unit === 'cc' || unit === '毫升') unit = 'ml';
    if (unit === '毫克') unit = 'mg';
    rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
  }
  const name = cleanSpaces(rest);
  if (!name) throw new ParseError('請寫上藥名，例如：吃藥 退燒藥 2.5ml');
  return record(MED, at, { value: value, unit: unit, detail: name });
}

function parsePump(rest, at) {
  let total = 0;
  const parts = [];
  const sideRe = /(左|右)\s*(\d+(?:\.\d+)?)\s*(ml|cc|毫升)?/gi;
  let m;
  while ((m = sideRe.exec(rest)) !== null) {
    total += Number(m[2]);
    parts.push(m[1] + fmtNum(Number(m[2])));
  }
  if (parts.length) {
    const note = cleanSpaces(rest.replace(sideRe, ' '));
    return record(PUMP, at, { value: total, unit: 'ml', detail: [parts.join(' '), note].filter(Boolean).join(' ') });
  }
  m = rest.match(/(\d+(?:\.\d+)?)\s*(ml|cc|毫升)?/i);
  if (!m) return record(PUMP, at, { detail: cleanSpaces(rest) });
  const note = cleanSpaces(rest.slice(0, m.index) + rest.slice(m.index + m[0].length));
  return record(PUMP, at, { value: Number(m[1]), unit: 'ml', detail: note });
}

/** 解析訊息本體（時間已經拿掉）。看不懂回傳 null。 */
function parseBody(body, at) {
  let word = startsWithWord(body, NOTE_WORDS);
  if (word) {
    const note = body.slice(word.length).replace(/^[\s:：]+/, '').trim();
    if (!note) throw new ParseError('請在「備註」後面加上內容，例如：備註 今天打預防針');
    return record(NOTE, at, { detail: note });
  }

  word = startsWithWord(body, TEMP_WORDS, /^\d/);
  if (word) return parseTemp(body.slice(word.length), at);

  word = startsWithWord(body, Object.keys(GROWTH_WORDS), /^\d/);
  if (word) return parseGrowth(word, body.slice(word.length), at);

  word = startsWithWord(body, MED_WORDS);
  if (word) return parseMed(body.slice(word.length), at);

  word = startsWithWord(body, BATH_WORDS);
  if (word) return record(BATH, at, { detail: cleanSpaces(body.slice(word.length)) });

  word = startsWithWord(body, PUMP_WORDS, /^(\d|左|右)/);
  if (word) return parsePump(body.slice(word.length), at);

  word = startsWithWord(body, VACCINE_WORDS);
  if (word) {
    const name = cleanSpaces(body.slice(word.length));
    if (!name) throw new ParseError('請寫上疫苗名稱，例如：疫苗 五合一 第一劑');
    return record(VACCINE, at, { detail: name });
  }

  word = startsWithWord(body, CLINIC_WORDS);
  if (word) return record(CLINIC, at, { detail: cleanSpaces(body.slice(word.length)) });

  word = startsWithWord(body, SLEEP_START_WORDS);
  if (word && !body.slice(word.length).trim()) return { action: 'sleep_start', kind: SLEEP, at: at };

  word = startsWithWord(body, SLEEP_END_WORDS);
  if (word && !body.slice(word.length).trim()) return { action: 'sleep_end', kind: SLEEP, at: at };

  word = startsWithWord(body, DIAPER_WORDS, /^[尿濕便大小]/);
  if (word) return parseDiaper(body.slice(word.length), at);
  if (/^(尿尿|小便|尿了|濕了|大便|便便|拉屎|大便了|便便了)/.test(body)) return parseDiaper(body, at);

  word = startsWithWord(body, Object.keys(FEED_WORDS), /^(\d|左|右|雙)/);
  if (word) return parseFeed(word, body.slice(word.length), at);

  // 「37.5」單獨一個數字，在體溫範圍內就當作體溫
  if (/^(3[4-9]|4[0-2])(\.\d)?$/.test(body)) return parseTemp(body, at);

  return null;
}

function parseSleepRange(text, now) {
  const r = text.match(new RegExp('^(睡眠|睡覺|睡)\\s*' + TIME_RE + RANGE_SEP + TIME_RE + '$'));
  if (!r) return null;
  let start = resolveTime(r[2], r[3], now);
  let end = resolveTime(r[4], r[5], now);
  if (end <= start) {
    // 跨夜：例如 22:00-06:00
    if (fmtDate(start) === fmtDate(end)) start = addMinutes(start, -24 * 60);
    else end = addMinutes(end, 24 * 60);
  }
  if (end - start > 24 * 3600000) throw new ParseError('睡眠區間超過 24 小時，請確認時間');
  return { action: 'sleep_range', kind: SLEEP, at: start, end: end, explicitTime: true };
}

/** 解析一筆紀錄（不含查詢指令）。explicitTime 表示使用者有指定時間。 */
function parseRecord(text, now) {
  const range = parseSleepRange(text, now);
  if (range) return range;
  const st = stripTime(text, now);
  if (!st.body) return null;
  const cmd = parseBody(st.body, st.at || now);
  if (cmd) cmd.explicitTime = !!st.at;
  return cmd;
}

/** 解析一則訊息。看不懂就回傳 null（機器人不回應，避免在群組裡吵）。 */
function parseCommand(rawText, now) {
  const text = normalizeText(rawText);
  if (!text) return null;

  const lowered = text.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(QUERY_WORDS, lowered)) return { action: QUERY_WORDS[lowered] };
  if (Object.prototype.hasOwnProperty.call(HISTORY_WORDS, text)) return { action: 'history', kind: HISTORY_WORDS[text] };

  let word = startsWithWord(text, EXPORT_WORDS, /^\d/);
  if (word) {
    const m = text.slice(word.length).match(/(\d+)/);
    const days = m ? Number(m[1]) : 7;
    if (days < 1 || days > 366) throw new ParseError('匯出天數請在 1～366 天之間，例如：匯出 30');
    return { action: 'export', days: days };
  }

  word = startsWithWord(text, EDIT_WORDS);
  if (word) {
    const rest = text.slice(word.length).trim();
    const onlyTime = rest.match(new RegExp('^' + TIME_RE + '$'));
    if (onlyTime) return { action: 'edit', at: resolveTime(onlyTime[1], onlyTime[2], now), timeOnly: true };
    const cmd = rest ? parseRecord(rest, now) : null;
    if (!cmd || (cmd.action !== 'record' && cmd.action !== 'sleep_range')) {
      throw new ParseError('請在「修改」後面寫上正確的內容，例如：\n修改 喝奶 150\n修改 14:30（只改時間）');
    }
    return { action: 'edit', replacement: cmd };
  }

  return parseRecord(text, now);
}

// ======== 試算表儲存 ========

/**
 * 每筆紀錄：{ id, chatId, kind, start, end, value, unit, detail, userId }
 * 試算表的欄位順序見 HEADERS。
 */
function SheetStorage(spreadsheet) {
  this.ss = spreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  this.sheet = this.ss.getSheetByName(SHEET_NAME);
  if (!this.sheet) {
    this.sheet = this.ss.insertSheet(SHEET_NAME);
    this.sheet.appendRow(HEADERS);
    this.sheet.setFrozenRows(1);
    this.sheet.getRange('D:E').setNumberFormat('yyyy/mm/dd hh:mm');
    this.sheet.getRange('J:J').setNumberFormat('yyyy/mm/dd hh:mm:ss');
    this.ss.setSpreadsheetTimeZone(TZ_NAME);
  }
  this._rows = null;
}

SheetStorage.prototype.reset = function () {
  this._rows = null;
};

SheetStorage.prototype._load = function () {
  if (this._rows) return this._rows;
  const values = this.sheet.getDataRange().getValues().slice(1);
  this._rows = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v[0] === '' || v[0] === null) continue;
    this._rows.push({
      row: i + 2,
      id: Number(v[0]),
      chatId: String(v[1]),
      kind: LABEL_KINDS[v[2]] || v[2],
      start: v[3] instanceof Date ? v[3] : new Date(v[3]),
      end: v[4] === '' || v[4] === null ? null : (v[4] instanceof Date ? v[4] : new Date(v[4])),
      value: v[5] === '' || v[5] === null ? null : Number(v[5]),
      unit: v[6] || null,
      detail: String(v[7] || ''),
      userId: String(v[8] || ''),
    });
  }
  return this._rows;
};

SheetStorage.prototype._chat = function (chatId) {
  return this._load().filter(function (r) { return r.chatId === chatId; });
};

SheetStorage.prototype.add = function (chatId, kind, start, opts) {
  opts = opts || {};
  const rows = this._load();
  const id = rows.reduce(function (max, r) { return Math.max(max, r.id); }, 0) + 1;
  const rec = {
    id: id, chatId: chatId, kind: kind, start: start, end: opts.end || null,
    value: opts.value == null ? null : opts.value, unit: opts.unit || null,
    detail: opts.detail || '', userId: opts.userId || '',
  };
  this.sheet.appendRow([id, chatId, KIND_LABELS[kind], start, rec.end || '', rec.value == null ? '' : rec.value,
    rec.unit || '', rec.detail, rec.userId, new Date()]);
  rec.row = this.sheet.getLastRow();
  rows.push(rec);
  return rec;
};

/** 修改一筆紀錄的類型、時間、數值、單位、內容（第 3～8 欄） */
SheetStorage.prototype.update = function (rec, fields) {
  Object.keys(fields).forEach(function (k) { rec[k] = fields[k]; });
  this.sheet.getRange(rec.row, 3, 1, 6).setValues([[KIND_LABELS[rec.kind], rec.start, rec.end || '',
    rec.value == null ? '' : rec.value, rec.unit || '', rec.detail]]);
  return rec;
};

SheetStorage.prototype.setEnd = function (rec, end) {
  this.sheet.getRange(rec.row, 5).setValue(end);
  rec.end = end;
  return rec;
};

SheetStorage.prototype.remove = function (rec) {
  this.sheet.deleteRow(rec.row);
  this._rows = null;
};

SheetStorage.prototype.openSleep = function (chatId) {
  return latest(this._chat(chatId).filter(function (r) { return r.kind === SLEEP && !r.end; }));
};

SheetStorage.prototype.ofKind = function (chatId, kind) {
  return byStart(this._chat(chatId).filter(function (r) { return r.kind === kind; }));
};

SheetStorage.prototype.lastOfKind = function (chatId, kind) {
  return latest(this.ofKind(chatId, kind));
};

SheetStorage.prototype.lastCreated = function (chatId) {
  return this._chat(chatId).reduce(function (best, r) { return !best || r.id > best.id ? r : best; }, null);
};

/** 與 [start, end) 有重疊的紀錄（睡眠可能從前一天開始） */
SheetStorage.prototype.between = function (chatId, start, end) {
  return byStart(this._chat(chatId).filter(function (r) {
    if (r.start >= end) return false;
    if (r.start >= start) return true;
    return r.kind === SLEEP && (!r.end || r.end > start);
  }));
};

SheetStorage.prototype.recent = function (chatId, limit) {
  const list = byStart(this._chat(chatId));
  return list.slice(Math.max(0, list.length - limit));
};

/** 重畫「成長曲線」工作表：每天一列，加上體重、身高、頭圍三張折線圖 */
SheetStorage.prototype.updateGrowthSheet = function (chatId) {
  const byDay = {};
  this.ofKind(chatId, GROWTH).forEach(function (r) {
    const key = fmtFullDate(r.start);
    if (!byDay[key]) byDay[key] = { date: startOfDay(r.start), 體重: '', 身高: '', 頭圍: '' };
    byDay[key][r.detail] = r.value;
  });
  const rows = Object.keys(byDay).sort().map(function (k) {
    const d = byDay[k];
    return [d.date, d.體重, d.身高, d.頭圍];
  });

  let sheet = this.ss.getSheetByName(GROWTH_SHEET_NAME);
  if (!sheet) sheet = this.ss.insertSheet(GROWTH_SHEET_NAME);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 4).setValues([['日期', '體重(kg)', '身高(cm)', '頭圍(cm)']]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 4).setValues(rows);
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy/mm/dd');
  }
  if (sheet.getCharts().length === 0 && typeof Charts !== 'undefined') {
    [['B', '體重 (kg)', 1], ['C', '身高 (cm)', 21], ['D', '頭圍 (cm)', 41]].forEach(function (c) {
      sheet.insertChart(sheet.newChart()
        .setChartType(Charts.ChartType.LINE)
        .addRange(sheet.getRange('A1:A1000'))
        .addRange(sheet.getRange(c[0] + '1:' + c[0] + '1000'))
        .setOption('title', c[1])
        .setOption('interpolateNulls', true)
        .setOption('pointSize', 5)
        .setOption('legend', { position: 'none' })
        .setPosition(c[2], 6, 0, 0)
        .build());
    });
  }
};

/** 建立一個新的試算表檔案（存在雲端硬碟），回傳網址 */
SheetStorage.prototype.createExport = function (name, sheets) {
  const file = SpreadsheetApp.create(name);
  file.setSpreadsheetTimeZone(TZ_NAME);
  sheets.forEach(function (s, i) {
    const sheet = i === 0 ? file.getSheets()[0].setName(s.name) : file.insertSheet(s.name);
    sheet.getRange(1, 1, s.rows.length, s.rows[0].length).setValues(s.rows);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, s.rows[0].length);
  });
  return file.getUrl();
};

function byStart(list) {
  return list.slice().sort(function (a, b) { return a.start - b.start || a.id - b.id; });
}

function latest(list) {
  const sorted = byStart(list);
  return sorted.length ? sorted[sorted.length - 1] : null;
}

// ======== 記錄邏輯與回覆文字 ========

const HELP_TEXT = [
  '👶 寶寶生理時鐘紀錄 使用說明',
  '',
  '【睡眠】睡覺 → 起床（自動算睡多久）',
  '補登：睡 13:00-14:30',
  '',
  '【吃】喝奶 120 / 配方奶 150ml',
  '母乳 左 15（分鐘）/ 副食品 30g',
  '記錄後會預測下一餐時間和奶量 🔮',
  '',
  '【排泄】尿布 尿 / 尿布 便 / 尿布 尿+便',
  '【體溫】體溫 37.2',
  '【洗澡】洗澡',
  '【擠奶】擠奶 120 / 擠奶 左 60 右 50',
  '【吃藥】吃藥 退燒藥 2.5ml',
  '【身高體重】體重 6.2 / 身高 62 / 頭圍 40',
  '【疫苗】疫苗 五合一 第一劑',
  '【看診】看診 小兒科 感冒',
  '【備註】備註 今天第一次翻身',
  '',
  '【補登時間】前面或後面加時間：',
  '14:30 喝奶 120 / 尿布 便 09:15',
  '',
  '【查詢】',
  '今天 / 昨天 → 當日統計',
  '最近 → 最近 10 筆',
  '狀態 → 距離上次吃、睡、換尿布多久',
  '成長紀錄 → 身高體重變化',
  '疫苗紀錄 / 看診紀錄 / 吃藥紀錄',
  '擠奶紀錄 / 洗澡紀錄 / 體溫紀錄',
  '',
  '【修改】',
  '修改 喝奶 150 → 改最後一筆',
  '修改 14:30 → 只改最後一筆的時間',
  '復原 → 刪除最後一筆',
  '',
  '【匯出】匯出 / 匯出 30 → 最近 7 天或 30 天整理成試算表',
  '',
  '成長曲線圖在試算表的「成長曲線」分頁 📈',
].join('\n');

function fmtValue(value, unit) {
  return value == null ? '' : fmtNum(value) + (unit || '');
}

function describe(rec, now) {
  const t = fmtTime(rec.start);
  const tail = rec.detail ? ' ' + rec.detail : '';
  switch (rec.kind) {
    case SLEEP:
      if (rec.end) return '😴 睡眠 ' + t + '-' + fmtTime(rec.end) + '（' + fmtDuration(rec.end - rec.start) + '）';
      return '😴 ' + t + ' 入睡（睡眠中' + (now ? '，已睡 ' + fmtDuration(now - rec.start) : '') + '）';
    case FEED:
      return ('🍼 ' + t + ' ' + rec.detail + ' ' + fmtValue(rec.value, rec.unit)).trim();
    case DIAPER:
      return '🧷 ' + t + ' 尿布 ' + rec.detail;
    case TEMP: {
      const warn = rec.value != null && rec.value >= 37.5 ? ' ⚠️' : '';
      return '🌡️ ' + t + ' 體溫 ' + fmtValue(rec.value, rec.unit) + warn + tail;
    }
    case GROWTH:
      return (rec.detail === '體重' ? '⚖️ ' : '📏 ') + t + ' ' + rec.detail + ' ' + fmtValue(rec.value, rec.unit);
    case MED:
      return ('💊 ' + t + ' ' + rec.detail + ' ' + fmtValue(rec.value, rec.unit)).trim();
    case BATH:
      return '🛁 ' + t + ' 洗澡' + tail;
    case PUMP:
      if (rec.value == null) return '🥛 ' + t + ' 擠奶' + tail;
      return '🥛 ' + t + ' 擠奶 ' + fmtValue(rec.value, rec.unit) + (rec.detail ? '（' + rec.detail + '）' : '');
    case VACCINE:
      return '💉 ' + t + ' 疫苗' + tail;
    case CLINIC:
      return '🏥 ' + t + ' 看診' + tail;
    case NOTE:
      return '📝 ' + t + tail;
    default:
      return t + ' ' + rec.kind + tail;
  }
}

function median(sorted) {
  return quantile(sorted, 0.5);
}

function quantile(sorted, p) {
  return sorted[Math.round(p * (sorted.length - 1))];
}

function isNight(date) {
  const h = localParts(date).h;
  return h >= 22 || h < 6;
}

function BabyService(storage) {
  this.storage = storage;
}

BabyService.prototype.handle = function (chatId, text, userId, now) {
  now = now || new Date();
  let cmd;
  try {
    cmd = parseCommand(text, now);
  } catch (e) {
    if (e instanceof ParseError) return '⚠️ ' + e.message;
    throw e;
  }
  if (!cmd) return null;
  const self = this;
  // 兩個人同時記錄時避免互相覆蓋
  return withLock(function () {
    if (self.storage.reset) self.storage.reset(); // 拿到鎖之後重新讀取，才看得到別人剛寫入的紀錄
    return self['do_' + cmd.action](chatId, cmd, userId, now);
  });
};

function withLock(fn) {
  if (typeof LockService === 'undefined') return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * 根據最近 3 天的餵奶紀錄，預測下一餐的時間與奶量。
 * 紀錄太少時回傳 null。夜間（22:00～06:00）與白天的間隔分開計算。
 */
BabyService.prototype.predictNextFeed = function (chatId, last) {
  const feeds = this.storage.between(chatId, addMinutes(last.start, -3 * 24 * 60), addMinutes(last.start, 1))
    .filter(function (r) { return r.kind === FEED; });
  const intervals = [];
  for (let i = 1; i < feeds.length; i++) {
    const gap = (feeds[i].start - feeds[i - 1].start) / 60000;
    if (gap >= 60 && gap <= 8 * 60) intervals.push({ gap: gap, night: isNight(feeds[i - 1].start) });
  }
  if (intervals.length < 5) return null;

  const night = isNight(last.start);
  let gaps = intervals.filter(function (x) { return x.night === night; }).map(function (x) { return x.gap; });
  if (gaps.length < 3) gaps = intervals.map(function (x) { return x.gap; });
  gaps.sort(function (a, b) { return a - b; });

  const result = {
    at: roundToMinutes(addMinutes(last.start, median(gaps)), 5),
    from: roundToMinutes(addMinutes(last.start, quantile(gaps, 0.25)), 5),
    to: roundToMinutes(addMinutes(last.start, quantile(gaps, 0.75)), 5),
    amount: null,
  };
  const bottles = feeds.filter(function (r) { return r.unit === 'ml' && r.value; }).slice(-6);
  if (bottles.length >= 3) {
    const avg = bottles.reduce(function (t, r) { return t + r.value; }, 0) / bottles.length;
    result.amount = Math.round(avg / 10) * 10;
  }
  return result;
};

function describePrediction(p) {
  let line = '🔮 預計下一餐：約 ' + fmtTime(p.at);
  if (p.to - p.from >= 15 * 60000) line += '（' + fmtTime(p.from) + '～' + fmtTime(p.to) + '）';
  if (p.amount) line += '\n   建議準備：約 ' + p.amount + 'ml';
  return line;
}

BabyService.prototype.do_record = function (chatId, cmd, userId, now) {
  const rec = this.storage.add(chatId, cmd.kind, cmd.at,
    { value: cmd.value, unit: cmd.unit, detail: cmd.detail, userId: userId });
  let reply = '✅ 已記錄\n' + describe(rec, now);
  const extra = this.afterRecord(chatId, rec, now);
  return extra ? reply + '\n' + extra : reply;
};

/** 記錄後附加的資訊：距離上一餐、預測、體重變化、發燒提醒…… */
BabyService.prototype.afterRecord = function (chatId, rec, now) {
  const s = this.storage;
  const lines = [];
  const previous = function (kind, filter) {
    return s.ofKind(chatId, kind).filter(function (r) {
      return r.id !== rec.id && r.start < rec.start && (!filter || filter(r));
    });
  };

  if (rec.kind === TEMP && rec.value != null) {
    if (rec.value >= 38.0) lines.push('寶寶發燒了，請留意精神與食慾，必要時就醫。');
    else if (rec.value >= 37.5) lines.push('體溫偏高，建議過一陣子再量一次。');
  }

  if (rec.kind === FEED) {
    const prev = previous(FEED);
    if (prev.length) lines.push('距離上一餐 ' + fmtDuration(rec.start - prev[prev.length - 1].start));
    const p = this.predictNextFeed(chatId, rec);
    lines.push('');
    lines.push(p ? describePrediction(p) : '🔮 再多記錄幾餐（約 1～2 天），就會開始預測下一餐');
  }

  if (rec.kind === GROWTH) {
    const prev = previous(GROWTH, function (r) { return r.detail === rec.detail; });
    if (prev.length) {
      const p = prev[prev.length - 1];
      const diff = rec.value - p.value;
      const sign = diff > 0 ? '增加 ' : diff < 0 ? '減少 ' : '';
      lines.push('比上次（' + fmtAgo(p.start, rec.start) + '）' +
        (sign ? sign + fmtNum(Math.abs(diff)) + rec.unit : '沒有變化'));
    }
    if (s.updateGrowthSheet) {
      try {
        s.updateGrowthSheet(chatId);
        lines.push('📈 成長曲線圖已更新（試算表「成長曲線」分頁）');
      } catch (e) {
        console.error('更新成長曲線失敗：' + (e && e.stack ? e.stack : e));
      }
    }
  }

  if (rec.kind === MED) {
    const same = previous(MED, function (r) { return r.detail === rec.detail; });
    if (same.length) lines.push('距離上次吃' + rec.detail + ' ' + fmtDuration(rec.start - same[same.length - 1].start));
    const dayStart = startOfDay(rec.start);
    const today = same.filter(function (r) { return r.start >= dayStart; }).length + 1;
    lines.push('今天第 ' + today + ' 次');
  }

  if (rec.kind === PUMP) {
    const dayStart = startOfDay(rec.start);
    const total = s.ofKind(chatId, PUMP)
      .filter(function (r) { return r.start >= dayStart && r.start < addMinutes(dayStart, 24 * 60); })
      .reduce(function (t, r) { return t + (r.value || 0); }, 0);
    if (total) lines.push('今天共擠 ' + fmtNum(total) + 'ml');
  }

  return lines.join('\n');
};

BabyService.prototype.do_sleep_start = function (chatId, cmd, userId, now) {
  const opened = this.storage.openSleep(chatId);
  if (opened) {
    return '寶寶 ' + fmtTime(opened.start) + ' 就開始睡了（尚未起床）。\n' +
      '如果那筆是錯的，可以輸入「復原」刪掉，再重新輸入「睡覺」。';
  }
  const rec = this.storage.add(chatId, SLEEP, cmd.at, { userId: userId });
  return '😴 ' + fmtTime(rec.start) + ' 開始睡覺，晚安～\n醒來時輸入「起床」';
};

BabyService.prototype.do_sleep_end = function (chatId, cmd, userId, now) {
  const opened = this.storage.openSleep(chatId);
  if (!opened) return '找不到還沒結束的睡眠 🤔\n請先輸入「睡覺」，或用「睡 13:00-14:30」補登。';
  if (cmd.at <= opened.start) {
    return '起床時間 ' + fmtTime(cmd.at) + ' 早於入睡時間 ' + fmtTime(opened.start) + '，請確認時間。';
  }
  const rec = this.storage.setEnd(opened, cmd.at);
  return '☀️ ' + fmtTime(rec.end) + ' 起床！\n這次睡了 ' + fmtDuration(rec.end - rec.start);
};

BabyService.prototype.do_sleep_range = function (chatId, cmd, userId, now) {
  const rec = this.storage.add(chatId, SLEEP, cmd.at, { end: cmd.end, userId: userId });
  return '✅ 已補登\n' + describe(rec, now);
};

BabyService.prototype.do_edit = function (chatId, cmd, userId, now) {
  const rec = this.storage.lastCreated(chatId);
  if (!rec) return '目前沒有任何紀錄可以修改。';
  const before = describe(rec, now);
  const wasGrowth = rec.kind === GROWTH;
  if (cmd.timeOnly) {
    let fields = { start: cmd.at };
    if (rec.end) {
      const end = new Date(rec.end.getTime() + (cmd.at - rec.start));
      fields = { start: cmd.at, end: end };
    }
    this.storage.update(rec, fields);
  } else {
    const r = cmd.replacement;
    this.storage.update(rec, {
      kind: r.kind,
      start: r.explicitTime ? r.at : rec.start,
      end: r.end || null,
      value: r.value == null ? null : r.value,
      unit: r.unit || null,
      detail: r.detail || '',
    });
  }
  if ((wasGrowth || rec.kind === GROWTH) && this.storage.updateGrowthSheet) this.storage.updateGrowthSheet(chatId);
  return '✏️ 已修改最後一筆\n修改前：' + before + '\n修改後：' + describe(rec, now);
};

BabyService.prototype.do_help = function () {
  return HELP_TEXT;
};

BabyService.prototype.do_undo = function (chatId, cmd, userId, now) {
  const rec = this.storage.lastCreated(chatId);
  if (!rec) return '目前沒有任何紀錄可以刪除。';
  this.storage.remove(rec);
  if (rec.kind === GROWTH && this.storage.updateGrowthSheet) this.storage.updateGrowthSheet(chatId);
  return '🗑️ 已刪除最後一筆：\n' + describe(rec, now);
};

function listByDate(records, now) {
  const lines = [];
  let lastDate = null;
  records.forEach(function (r) {
    const d = fmtDate(r.start);
    if (d !== lastDate) {
      lastDate = d;
      lines.push('— ' + d + ' —');
    }
    lines.push(describe(r, now));
  });
  return lines;
}

BabyService.prototype.do_recent = function (chatId, cmd, userId, now) {
  const records = this.storage.recent(chatId, 10);
  if (!records.length) return '還沒有任何紀錄喔！輸入「說明」看看怎麼用。';
  return ['📋 最近 10 筆紀錄'].concat(listByDate(records, now)).join('\n');
};

BabyService.prototype.do_history = function (chatId, cmd, userId, now) {
  const label = KIND_LABELS[cmd.kind];
  const all = this.storage.ofKind(chatId, cmd.kind);
  if (!all.length) return '還沒有' + label + '紀錄。';
  if (cmd.kind === GROWTH) return this.growthHistory(all);
  const shown = all.slice(-20);
  const title = '📋 ' + label + '紀錄（共 ' + all.length + ' 筆' + (all.length > shown.length ? '，顯示最近 20 筆' : '') + '）';
  return [title].concat(listByDate(shown, now)).join('\n');
};

BabyService.prototype.growthHistory = function (all) {
  const lines = ['📏 成長紀錄'];
  ['體重', '身高', '頭圍'].forEach(function (what) {
    const list = all.filter(function (r) { return r.detail === what; }).slice(-8);
    if (!list.length) return;
    lines.push('', '【' + what + '】');
    list.forEach(function (r, i) {
      let line = fmtFullDate(r.start) + '  ' + fmtValue(r.value, r.unit);
      if (i > 0) {
        const diff = r.value - list[i - 1].value;
        line += '（' + (diff >= 0 ? '+' : '-') + fmtNum(Math.abs(diff)) + '）';
      }
      lines.push(line);
    });
  });
  lines.push('', '📈 曲線圖在試算表的「成長曲線」分頁');
  return lines.join('\n');
};

BabyService.prototype.do_status = function (chatId, cmd, userId, now) {
  const s = this.storage;
  const lines = ['⏱️ 目前狀態'];
  const opened = s.openSleep(chatId);
  if (opened) {
    lines.push('😴 睡眠中：' + fmtTime(opened.start) + ' 入睡，已睡 ' + fmtDuration(now - opened.start));
  } else {
    const lastSleep = s.lastOfKind(chatId, SLEEP);
    if (lastSleep && lastSleep.end) {
      lines.push('☀️ 醒著：' + fmtTime(lastSleep.end) + ' 起床，已醒 ' + fmtDuration(now - lastSleep.end));
    }
  }
  const self = this;
  [[FEED, '上次吃', '🍼'], [DIAPER, '上次換尿布', '🧷'], [MED, '上次吃藥', '💊'], [TEMP, '上次量體溫', '🌡️']]
    .forEach(function (k) {
      const rec = s.lastOfKind(chatId, k[0]);
      if (!rec) return;
      let line = k[2] + ' ' + k[1] + '：' + fmtTime(rec.start) + '（' + fmtDuration(now - rec.start) + '前）';
      if (k[0] === DIAPER || k[0] === MED) line += ' ' + rec.detail;
      if (k[0] !== DIAPER) line += ' ' + fmtValue(rec.value, rec.unit);
      lines.push(line.trim());
      if (k[0] === FEED) {
        const p = self.predictNextFeed(chatId, rec);
        if (p) {
          const left = p.at - now;
          const when = left >= 0 ? '還有 ' + fmtDuration(left) : '已超過 ' + fmtDuration(-left);
          lines.push('🔮 預計下一餐：約 ' + fmtTime(p.at) + '（' + when + '）' + (p.amount ? '，約 ' + p.amount + 'ml' : ''));
        }
      }
    });
  if (lines.length === 1) return '還沒有任何紀錄喔！輸入「說明」看看怎麼用。';
  return lines.join('\n');
};

BabyService.prototype.do_today = function (chatId, cmd, userId, now) {
  return this.daySummary(chatId, startOfDay(now), now);
};

BabyService.prototype.do_yesterday = function (chatId, cmd, userId, now) {
  return this.daySummary(chatId, addMinutes(startOfDay(now), -24 * 60), now);
};

/** 一天的統計數字（給每日統計和匯出共用） */
BabyService.prototype.dayStats = function (chatId, start, now) {
  const end = addMinutes(start, 24 * 60);
  const records = this.storage.between(chatId, start, end);
  const of = function (kind) { return records.filter(function (r) { return r.kind === kind; }); };
  const sum = function (list, unit) {
    return list.reduce(function (t, r) { return t + ((!unit || r.unit === unit) && r.value ? r.value : 0); }, 0);
  };
  const label = function (r) { return r.detail.split(' ')[0]; };
  const feeds = of(FEED);
  const diapers = of(DIAPER);
  const temps = of(TEMP).map(function (r) { return r.value; }).filter(function (v) { return v != null; });
  let sleepMs = 0;
  of(SLEEP).forEach(function (r) {
    const s = Math.max(r.start.getTime(), start.getTime());
    const e = Math.min((r.end || now).getTime(), end.getTime());
    if (e > s) sleepMs += e - s;
  });
  return {
    records: records,
    feeds: feeds.length,
    ml: sum(feeds, 'ml'),
    breast: sum(feeds, '分鐘'),
    sleepMs: sleepMs,
    sleeps: of(SLEEP).length,
    diapers: diapers.length,
    pee: diapers.filter(function (r) { return label(r).indexOf('尿') >= 0; }).length,
    poo: diapers.filter(function (r) { return label(r).indexOf('便') >= 0; }).length,
    maxTemp: temps.length ? Math.max.apply(null, temps) : null,
    temps: temps.length,
    pumpMl: sum(of(PUMP)),
    pumps: of(PUMP).length,
    baths: of(BATH).length,
    meds: of(MED).length,
  };
};

BabyService.prototype.daySummary = function (chatId, start, now) {
  const st = this.dayStats(chatId, start, now);
  const title = '📊 ' + fmtDate(start) + ' 統計';
  if (!st.records.length) return title + '\n這天還沒有紀錄。';

  const lines = [title];
  const extras = [];
  if (st.ml) extras.push('共 ' + fmtNum(st.ml) + 'ml');
  if (st.breast) extras.push('親餵 ' + fmtNum(st.breast) + ' 分鐘');
  lines.push('🍼 餵食 ' + st.feeds + ' 次' + (extras.length ? '（' + extras.join('，') + '）' : ''));
  lines.push('😴 睡眠 ' + fmtDuration(st.sleepMs) + '（' + st.sleeps + ' 段）');
  lines.push('🧷 尿布 ' + st.diapers + ' 次（尿 ' + st.pee + '・便 ' + st.poo + '）');
  if (st.temps) lines.push('🌡️ 體溫 ' + st.temps + ' 次（最高 ' + fmtNum(st.maxTemp) + '°C）');
  if (st.pumps) lines.push('🥛 擠奶 ' + st.pumps + ' 次' + (st.pumpMl ? '（共 ' + fmtNum(st.pumpMl) + 'ml）' : ''));
  if (st.meds) lines.push('💊 吃藥 ' + st.meds + ' 次');
  if (st.baths) lines.push('🛁 洗澡 ' + st.baths + ' 次');

  lines.push('', '— 明細 —');
  st.records.forEach(function (r) { lines.push(describe(r, now)); });
  return lines.join('\n');
};

BabyService.prototype.do_export = function (chatId, cmd, userId, now) {
  const today = startOfDay(now);
  const first = addMinutes(today, -(cmd.days - 1) * 24 * 60);
  const daily = [['日期', '餵食次數', '奶量(ml)', '親餵(分鐘)', '睡眠(小時)', '尿布', '尿', '便',
    '最高體溫', '擠奶(ml)', '吃藥次數', '洗澡']];
  for (let i = 0; i < cmd.days; i++) {
    const day = addMinutes(first, i * 24 * 60);
    const st = this.dayStats(chatId, day, now);
    daily.push([fmtFullDate(day), st.feeds, st.ml, st.breast, Math.round(st.sleepMs / 360000) / 10, st.diapers,
      st.pee, st.poo, st.maxTemp == null ? '' : st.maxTemp, st.pumpMl, st.meds, st.baths]);
  }
  const detail = [['日期', '時間', '類型', '內容', '數值', '單位', '結束時間']];
  this.storage.between(chatId, first, addMinutes(today, 24 * 60)).forEach(function (r) {
    detail.push([fmtFullDate(r.start), fmtTime(r.start), KIND_LABELS[r.kind] || r.kind, r.detail,
      r.value == null ? '' : r.value, r.unit || '', r.end ? fmtTime(r.end) : '']);
  });
  const name = '寶寶紀錄 ' + fmtFullDate(first) + '-' + fmtFullDate(today);
  const url = this.storage.createExport(name, [{ name: '每日統計', rows: daily }, { name: '明細', rows: detail }]);
  return '📤 已匯出最近 ' + cmd.days + ' 天（' + (detail.length - 1) + ' 筆紀錄）\n' + url +
    '\n\n檔案存在你的 Google 雲端硬碟。要給醫生看的話，打開後按「共用與匯出」可以下載成 PDF 或 Excel。';
};
