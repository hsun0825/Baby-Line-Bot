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
const HEADERS = ['編號', '聊天室', '類型', '開始時間', '結束時間', '數值', '單位', '內容', '記錄者', '建立時間'];

const SLEEP = 'sleep';
const FEED = 'feed';
const DIAPER = 'diaper';
const TEMP = 'temp';
const NOTE = 'note';

// 試算表裡顯示的中文類型名稱
const KIND_LABELS = { sleep: '睡眠', feed: '餵食', diaper: '排泄', temp: '體溫', note: '備註' };
const LABEL_KINDS = { 睡眠: SLEEP, 餵食: FEED, 排泄: DIAPER, 體溫: TEMP, 備註: NOTE };

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

// 每則回覆下方的快速按鈕
const QUICK_ACTIONS = [
  ['🍼 喝奶', '喝奶'],
  ['😴 睡覺', '睡覺'],
  ['☀️ 起床', '起床'],
  ['💧 尿', '尿布 尿'],
  ['💩 便', '尿布 便'],
  ['📋 最近', '最近'],
  ['⏱️ 狀態', '狀態'],
  ['📊 今天', '今天'],
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

function fmtDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return h + '小時' + m + '分';
  if (h) return h + '小時';
  return m + '分鐘';
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
  母乳: '母乳', 親餵: '母乳', 瓶餵: '瓶餵', 配方奶: '配方奶', 配方: '配方奶', 擠奶: '瓶餵母乳',
  喝奶: '喝奶', 吃奶: '喝奶', 奶: '喝奶', 副食品: '副食品', 吃飯: '副食品', 吃: '副食品',
};
const DIAPER_WORDS = ['換尿布', '尿布', '排泄'];
const TEMP_WORDS = ['體溫', '溫度', '量體溫'];
const NOTE_WORDS = ['備註', '備忘', '筆記', '記事'];
const QUERY_WORDS = {
  今天: 'today', 今日: 'today', 昨天: 'yesterday', 昨日: 'yesterday',
  最近: 'recent', 紀錄: 'recent', 記錄: 'recent', 歷史: 'recent',
  狀態: 'status', 現在: 'status', 多久: 'status',
  刪除: 'undo', 復原: 'undo', 取消: 'undo', 刪除上一筆: 'undo',
  說明: 'help', 幫助: 'help', 使用說明: 'help', 指令: 'help', help: 'help', '?': 'help',
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

function parseFeed(word, rest, at) {
  const kind = FEED_WORDS[word];
  const cmd = { action: 'record', kind: FEED, at: at, value: null, unit: null, detail: '' };
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
  const note = rest.split(/\s+/).filter(Boolean).join(' ');
  cmd.detail = [kind, side, note].filter(Boolean).join(' ');
  return cmd;
}

function parseDiaper(rest, at) {
  const pee = /尿|濕|小便|pee/i.test(rest);
  const poo = /便|屎|大|poo/i.test(rest.replace('小便', ''));
  if (!pee && !poo) throw new ParseError('請說明是「尿」還是「便」，例如：尿布 尿、尿布 便、尿布 尿+便');
  const label = pee && poo ? '尿+便' : poo ? '便' : '尿';
  const extra = rest.replace(/尿布|尿|濕|小便|大便|便便|便|屎|pee|poo|[+&和、,，]/gi, ' ')
    .split(/\s+/).filter(Boolean).join(' ');
  return { action: 'record', kind: DIAPER, at: at, value: null, unit: null, detail: label + (extra ? ' ' + extra : '') };
}

function parseTemp(rest, at) {
  const m = rest.match(/(\d{2}(?:\.\d+)?)/);
  if (!m) throw new ParseError('請輸入體溫數字，例如：體溫 37.2');
  const value = Number(m[1]);
  if (value < 30 || value > 45) throw new ParseError('體溫 ' + value + ' 看起來不太對，請輸入攝氏溫度，例如：體溫 37.2');
  const note = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length))
    .replace(/度|°C/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  return { action: 'record', kind: TEMP, at: at, value: value, unit: '°C', detail: note };
}

/** 解析一則訊息。看不懂就回傳 null（機器人不回應，避免在群組裡吵）。 */
function parseCommand(rawText, now) {
  const text = normalizeText(rawText);
  if (!text) return null;

  const lowered = text.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(QUERY_WORDS, lowered)) return { action: QUERY_WORDS[lowered] };

  // 補登睡眠區間：「睡 13:00-14:30」或「睡眠 22:00~06:00」
  const r = text.match(new RegExp('^(睡眠|睡覺|睡)\\s*' + TIME_RE + RANGE_SEP + TIME_RE + '$'));
  if (r) {
    let start = resolveTime(r[2], r[3], now);
    let end = resolveTime(r[4], r[5], now);
    if (end <= start) {
      // 跨夜：例如 22:00-06:00
      if (fmtDate(start) === fmtDate(end)) start = addMinutes(start, -24 * 60);
      else end = addMinutes(end, 24 * 60);
    }
    if (end - start > 24 * 3600000) throw new ParseError('睡眠區間超過 24 小時，請確認時間');
    return { action: 'sleep_range', kind: SLEEP, at: start, end: end };
  }

  const st = stripTime(text, now);
  const at = st.at || now;
  const body = st.body;
  if (!body) return null;

  let word = startsWithWord(body, NOTE_WORDS);
  if (word) {
    const note = body.slice(word.length).replace(/^[\s:：]+/, '').trim();
    if (!note) throw new ParseError('請在「備註」後面加上內容，例如：備註 今天打預防針');
    return { action: 'record', kind: NOTE, at: at, value: null, unit: null, detail: note };
  }

  word = startsWithWord(body, TEMP_WORDS, /^\d/);
  if (word) return parseTemp(body.slice(word.length), at);

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
  const list = this._chat(chatId).filter(function (r) { return r.kind === SLEEP && !r.end; });
  return latest(list);
};

SheetStorage.prototype.lastOfKind = function (chatId, kind) {
  return latest(this._chat(chatId).filter(function (r) { return r.kind === kind; }));
};

SheetStorage.prototype.lastCreated = function (chatId) {
  const list = this._chat(chatId);
  return list.reduce(function (best, r) { return !best || r.id > best.id ? r : best; }, null);
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
  '【睡眠】',
  '睡覺 → 開始睡',
  '起床 → 結束並計算睡了多久',
  '睡 13:00-14:30 → 補登一段睡眠',
  '',
  '【吃】',
  '喝奶 120 / 配方奶 150ml',
  '母乳 左 15（分鐘）',
  '副食品 30g 南瓜粥',
  '',
  '【排泄】',
  '尿布 尿 / 尿布 便 / 尿布 尿+便',
  '（也可以只打：尿尿、大便）',
  '',
  '【體溫】',
  '體溫 37.2',
  '',
  '【備註】',
  '備註 今天打預防針',
  '',
  '【補登時間】',
  '在前面或後面加時間，例如：',
  '14:30 喝奶 120',
  '尿布 便 09:15',
  '',
  '【查詢】',
  '今天 / 昨天 → 當日統計',
  '最近 → 最近 10 筆',
  '狀態 → 距離上次吃、睡、換尿布多久',
  '復原 → 刪除最後一筆',
  '',
  '在群組裡使用，爸爸媽媽可以一起記錄同一個寶寶 ❤️',
].join('\n');

function fmtValue(value, unit) {
  return value == null ? '' : fmtNum(value) + (unit || '');
}

function describe(rec, now) {
  const t = fmtTime(rec.start);
  if (rec.kind === SLEEP) {
    if (rec.end) return '😴 睡眠 ' + t + '-' + fmtTime(rec.end) + '（' + fmtDuration(rec.end - rec.start) + '）';
    return '😴 ' + t + ' 入睡（睡眠中' + (now ? '，已睡 ' + fmtDuration(now - rec.start) : '') + '）';
  }
  if (rec.kind === FEED) return ('🍼 ' + t + ' ' + rec.detail + ' ' + fmtValue(rec.value, rec.unit)).trim();
  if (rec.kind === DIAPER) return '🧷 ' + t + ' 尿布 ' + rec.detail;
  if (rec.kind === TEMP) {
    const warn = rec.value != null && rec.value >= 37.5 ? ' ⚠️' : '';
    return '🌡️ ' + t + ' 體溫 ' + fmtValue(rec.value, rec.unit) + warn + (rec.detail ? ' ' + rec.detail : '');
  }
  if (rec.kind === NOTE) return '📝 ' + t + ' ' + rec.detail;
  return t + ' ' + rec.kind + ' ' + rec.detail;
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

BabyService.prototype.do_record = function (chatId, cmd, userId, now) {
  const rec = this.storage.add(chatId, cmd.kind, cmd.at,
    { value: cmd.value, unit: cmd.unit, detail: cmd.detail, userId: userId });
  let reply = '✅ 已記錄\n' + describe(rec, now);
  if (cmd.kind === TEMP && rec.value != null) {
    if (rec.value >= 38.0) reply += '\n寶寶發燒了，請留意精神與食慾，必要時就醫。';
    else if (rec.value >= 37.5) reply += '\n體溫偏高，建議過一陣子再量一次。';
  }
  if (cmd.kind === FEED) {
    const prev = this.storage.between(chatId, addMinutes(rec.start, -2 * 24 * 60), rec.start)
      .filter(function (r) { return r.kind === FEED && r.id !== rec.id; });
    if (prev.length) reply += '\n距離上一餐 ' + fmtDuration(rec.start - prev[prev.length - 1].start);
  }
  return reply;
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

BabyService.prototype.do_help = function () {
  return HELP_TEXT;
};

BabyService.prototype.do_undo = function (chatId, cmd, userId, now) {
  const rec = this.storage.lastCreated(chatId);
  if (!rec) return '目前沒有任何紀錄可以刪除。';
  this.storage.remove(rec);
  return '🗑️ 已刪除最後一筆：\n' + describe(rec, now);
};

BabyService.prototype.do_recent = function (chatId, cmd, userId, now) {
  const records = this.storage.recent(chatId, 10);
  if (!records.length) return '還沒有任何紀錄喔！輸入「說明」看看怎麼用。';
  const lines = ['📋 最近 10 筆紀錄'];
  let lastDate = null;
  records.forEach(function (r) {
    const d = fmtDate(r.start);
    if (d !== lastDate) {
      lastDate = d;
      lines.push('— ' + d + ' —');
    }
    lines.push(describe(r, now));
  });
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
  [[FEED, '上次吃', '🍼'], [DIAPER, '上次換尿布', '🧷'], [TEMP, '上次量體溫', '🌡️']].forEach(function (k) {
    const rec = s.lastOfKind(chatId, k[0]);
    if (!rec) return;
    let line = k[2] + ' ' + k[1] + '：' + fmtTime(rec.start) + '（' + fmtDuration(now - rec.start) + '前）';
    if (k[0] === DIAPER) line += ' ' + rec.detail;
    else line += ' ' + fmtValue(rec.value, rec.unit);
    lines.push(line.trim());
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

BabyService.prototype.daySummary = function (chatId, start, now) {
  const end = addMinutes(start, 24 * 60);
  const records = this.storage.between(chatId, start, end);
  const title = '📊 ' + fmtDate(start) + ' 統計';
  if (!records.length) return title + '\n這天還沒有紀錄。';

  const of = function (kind) { return records.filter(function (r) { return r.kind === kind; }); };
  const feeds = of(FEED);
  const sleeps = of(SLEEP);
  const diapers = of(DIAPER);
  const temps = of(TEMP);
  const sum = function (list, unit) {
    return list.reduce(function (t, r) { return t + (r.unit === unit && r.value ? r.value : 0); }, 0);
  };

  const lines = [title];
  const ml = sum(feeds, 'ml');
  const breast = sum(feeds, '分鐘');
  const extras = [];
  if (ml) extras.push('共 ' + fmtNum(ml) + 'ml');
  if (breast) extras.push('親餵 ' + fmtNum(breast) + ' 分鐘');
  lines.push('🍼 餵食 ' + feeds.length + ' 次' + (extras.length ? '（' + extras.join('，') + '）' : ''));

  let total = 0;
  sleeps.forEach(function (r) {
    const s = Math.max(r.start.getTime(), start.getTime());
    const e = Math.min((r.end || now).getTime(), end.getTime());
    if (e > s) total += e - s;
  });
  lines.push('😴 睡眠 ' + fmtDuration(total) + '（' + sleeps.length + ' 段）');

  const label = function (r) { return r.detail.split(' ')[0]; };
  const pee = diapers.filter(function (r) { return label(r).indexOf('尿') >= 0; }).length;
  const poo = diapers.filter(function (r) { return label(r).indexOf('便') >= 0; }).length;
  lines.push('🧷 尿布 ' + diapers.length + ' 次（尿 ' + pee + '・便 ' + poo + '）');

  if (temps.length) {
    const max = Math.max.apply(null, temps.map(function (r) { return r.value; }));
    lines.push('🌡️ 體溫 ' + temps.length + ' 次（最高 ' + fmtNum(max) + '°C）');
  }

  lines.push('', '— 明細 —');
  records.forEach(function (r) { lines.push(describe(r, now)); });
  return lines.join('\n');
};
