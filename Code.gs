/**
 * 寶寶生理時鐘 LINE Bot（Google Apps Script 版）
 *
 * 紀錄會存在這個試算表的「紀錄」工作表裡。
 * 安裝方式請看 README.md。
 */

// ======== 設定：第一次安裝時填這裡 ========

// LINE Developers Console > Messaging API > Channel access token
// 執行一次 setup 之後 token 會存進「指令碼屬性」，以後更新程式時這行不用再填。
const LINE_CHANNEL_ACCESS_TOKEN = '把你的 Channel access token 貼在這裡';

// ===================================

// 程式版本：用瀏覽器打開部署網址會顯示，用來確認 LINE 用的是不是新程式
const APP_VERSION = '2026-10-09 表單版';
const TZ_NAME = 'Asia/Taipei';
const TZ_OFFSET_HOURS = 8; // 台灣沒有日光節約時間，固定 +8
const SHEET_NAME = '紀錄';
const GROWTH_SHEET_NAME = '成長曲線';
const HEADERS = ['編號', '聊天室', '類型', '開始時間', '結束時間', '數值', '單位', '內容', '記錄者', '建立時間'];
const WEB_RECORDER = '網頁補登';

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

// ======== 指令碼屬性（token、寶寶資料、報表連結、記錄者名字） ========

function props() {
  return typeof PropertiesService === 'undefined' ? null : PropertiesService.getScriptProperties();
}

// LINE 的 token 是一長串英數字；還是中文提示文字（或空白）就當作沒填
function isRealToken(t) {
  return /^[\x21-\x7e]{20,}$/.test(String(t || '').trim());
}

/** 程式最上面有填 token 就用它（並存起來）；沒填就用之前存起來的 */
function lineToken() {
  const p = props();
  const typed = String(LINE_CHANNEL_ACCESS_TOKEN || '').trim();
  if (isRealToken(typed)) {
    if (p && p.getProperty('LINE_CHANNEL_ACCESS_TOKEN') !== typed) p.setProperty('LINE_CHANNEL_ACCESS_TOKEN', typed);
    return typed;
  }
  const saved = p && p.getProperty('LINE_CHANNEL_ACCESS_TOKEN') && p.getProperty('LINE_CHANNEL_ACCESS_TOKEN').trim();
  if (!saved) console.error('找不到 LINE token：請把 token 貼到程式最上面那行，存檔後重新部署（新版本）。');
  return saved || '';
}

function getBabyInfo(chatId) {
  const p = props();
  const raw = p && p.getProperty('baby:' + chatId);
  return raw ? JSON.parse(raw) : {};
}

function setBabyInfo(chatId, info) {
  const p = props();
  if (p) p.setProperty('baby:' + chatId, JSON.stringify(info));
}

/** 每個聊天室一組隨機的報表密碼，拿到連結的人才看得到這個聊天室的紀錄 */
function reportKey(chatId) {
  const p = props();
  if (!p) return null;
  let key = p.getProperty('report:' + chatId);
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    p.setProperty('report:' + chatId, key);
    p.setProperty('reportkey:' + key, chatId);
  }
  return key;
}

function chatForReportKey(key) {
  const p = props();
  if (!p || !key || !/^[0-9a-f]{32}$/.test(key)) return null;
  return p.getProperty('reportkey:' + key);
}

function webAppUrl() {
  const p = props();
  const saved = p && p.getProperty('WEB_APP_URL');
  if (saved) return saved;
  try {
    return typeof ScriptApp === 'undefined' ? '' : ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

function reportUrl(chatId) {
  const base = webAppUrl();
  const key = base && reportKey(chatId);
  return key ? base + '?r=' + key : '';
}

/**
 * 記錄表單的網址（kind：feed／diaper／other）。
 * 有設定 LIFF_ID 時用 LIFF 打開（從聊天室下方滑出半個畫面）；沒有就用一般網頁（全螢幕）。
 */
function formUrl(chatId, kind) {
  const base = webAppUrl();
  const key = base && reportKey(chatId);
  if (!key) return '';
  const query = '?r=' + key + '&add=' + kind;
  const p = props();
  const liffId = p && p.getProperty('LIFF_ID');
  return liffId ? 'https://liff.line.me/' + liffId.trim() + query : base + query;
}

/** 記錄者的 LINE 顯示名稱（查過一次就記起來）；查不到就用 userId */
function recorderName(source) {
  const userId = source && source.userId;
  if (!userId) return '';
  const p = props();
  const cached = p && p.getProperty('name:' + userId);
  if (cached) return cached;
  let url = 'https://api.line.me/v2/bot/profile/' + userId;
  if (source.groupId) url = 'https://api.line.me/v2/bot/group/' + source.groupId + '/member/' + userId;
  else if (source.roomId) url = 'https://api.line.me/v2/bot/room/' + source.roomId + '/member/' + userId;
  try {
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + lineToken() }, muteHttpExceptions: true });
    const name = res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).displayName : '';
    if (name) {
      if (p) p.setProperty('name:' + userId, name);
      return name;
    }
  } catch (e) {
    console.error('查詢 LINE 名稱失敗：' + e);
  }
  return userId;
}

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

// 第一次安裝時在編輯器裡執行一次：建立「紀錄」工作表、存好 token，並授權程式使用試算表和連網
function setup() {
  new SheetStorage();
  const token = lineToken();
  if (!token) {
    throw new Error('找不到 token。請確認程式最上面這行的引號裡是 LINE 的 Channel access token（一長串英數字）：\n' +
      "const LINE_CHANNEL_ACCESS_TOKEN = '你的token';\n按儲存後再執行一次 setup。");
  }
  UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  console.log('設定完成！token 已經存起來，以後更新程式不用再填。接下來請按「部署」。');
}

// LINE 沒回應時，在編輯器裡選 checkSetup 按「執行」，看「執行記錄」裡哪一項打 ❌
function checkSetup() {
  const lines = ['程式版本：' + APP_VERSION];
  const token = lineToken();
  if (!token) {
    lines.push('❌ 沒有 token：請把 Channel access token 貼到程式最上面那行，按儲存後再執行一次 checkSetup。');
  } else {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 200) {
      lines.push('✅ token 正確，LINE 官方帳號：' + JSON.parse(res.getContentText()).displayName);
    } else {
      lines.push('❌ token 不正確（LINE 回應 ' + res.getResponseCode() + '）：請到 LINE Developers Console 重新複製 Channel access token。');
    }
  }
  const storage = new SheetStorage();
  lines.push('✅ 試算表「' + SHEET_NAME + '」有 ' + Math.max(0, storage.sheet.getLastRow() - 1) + ' 筆紀錄');
  const url = webAppUrl();
  lines.push(url ? '✅ 部署網址：' + url + '\n   （要跟 LINE Developers Console 的 Webhook URL 一樣）'
    : '❌ 還沒有部署成網頁應用程式：部署 → 新增部署作業 → 網頁應用程式');
  const p = props();
  const liffId = p && p.getProperty('LIFF_ID');
  lines.push(liffId ? '✅ LIFF_ID：' + liffId + '（記錄表單會從下方滑出）' : 'ℹ️ 沒有設定 LIFF_ID：記錄表單會用全螢幕打開');
  lines.push('提醒：改完程式要「部署 → 管理部署作業 → ✏️ 編輯 → 版本選新版本 → 部署」，LINE 才會用到新程式。');
  console.log(lines.join('\n'));
  return lines.join('\n');
}

/**
 * 網址參數。從 LIFF 打開時，LINE 會先把 ?r=...&add=... 包在 liff.state 裡傳過來，這裡把它拆開。
 */
function pageParams(e) {
  const params = {};
  const raw = (e && e.parameter) || {};
  Object.keys(raw).forEach(function (k) { params[k] = raw[k]; });
  const state = params['liff.state'];
  if (state) {
    String(state).replace(/^[^?]*\?/, '').split('&').forEach(function (pair) {
      const i = pair.indexOf('=');
      if (i > 0) params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });
  }
  return params;
}

const FORM_KINDS = { feed: 'feed', diaper: 'diaper', other: 'temp' };

// 用瀏覽器打開部署網址會看到「運作中」；帶著報表密碼（?r=...）則是寶寶作息報表，再加上 &add=feed 則是記錄表單
function doGet(e) {
  const params = pageParams(e);
  const key = params.r;
  if (!key) return ContentService.createTextOutput('寶寶紀錄 bot 運作中 👶（版本：' + APP_VERSION + '）');
  const chatId = chatForReportKey(key);
  if (!chatId) {
    return HtmlService.createHtmlOutput('<p style="font:16px sans-serif;padding:16px">這個報表連結已經失效了，請在 LINE 裡輸入「報表」拿新的連結。</p>')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const service = new BabyService(new SheetStorage());
  const mode = FORM_KINDS[params.add] || null;
  const p = props();
  const liffId = (p && p.getProperty('LIFF_ID')) || '';
  return HtmlService.createHtmlOutput(reportHtml(key, service.reportData(chatId, new Date()), mode, liffId.trim()))
    .setTitle(mode ? '記錄' : '寶寶作息報表')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 報表網頁的「補登」按鈕會呼叫這裡（google.script.run） */
function webAddRecord(key, form) {
  const chatId = chatForReportKey(key);
  if (!chatId) return { ok: false, message: '這個報表連結已經失效了，請在 LINE 裡輸入「報表」拿新的連結。' };
  const now = new Date();
  let text;
  try {
    text = webFormToText(form);
    const cmd = parseCommand(text, now);
    if (!cmd || (cmd.action !== 'record' && cmd.action !== 'sleep_range')) return { ok: false, message: '看不懂要補登的內容，請再檢查一次。' };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, message: e.message };
    throw e;
  }
  const service = new BabyService(new SheetStorage());
  const reply = service.handle(chatId, text, WEB_RECORDER, now);
  const message = typeof reply === 'string' ? reply : (reply && reply.text) || '';
  if (/^⚠️/.test(message)) return { ok: false, message: message.replace(/^⚠️\s*/, '') };
  return { ok: true, message: message, data: service.reportData(chatId, now) };
}

/** 把網頁表單轉成跟 LINE 一樣的文字指令，讓兩邊用同一套解析和檢查 */
function webFormToText(f) {
  f = f || {};
  const day = new Date(Number(f.day));
  if (isNaN(day.getTime())) throw new ParseError('請選日期');
  const date = fmtDate(day);
  const time = /^\d{2}:\d{2}$/.test(f.time || '') ? f.time : null;
  if (!time) throw new ParseError('請選時間');
  const num = function (v, label) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) throw new ParseError('請填' + label);
    return n;
  };
  switch (f.kind) {
    case 'feed': {
      const types = ['配方奶', '瓶餵母乳', '母乳', '副食品'];
      if (types.indexOf(f.feedType) < 0) throw new ParseError('請選餵食種類');
      return date + ' ' + time + ' ' + f.feedType + ' ' + num(f.amount, '份量');
    }
    case 'sleep':
      if (!/^\d{2}:\d{2}$/.test(f.end || '')) throw new ParseError('請選醒來時間');
      return date + ' 睡 ' + time + '-' + f.end;
    case 'diaper': {
      const label = { pee: '尿', poo: '便', both: '尿+便' }[f.diaper];
      if (!label) throw new ParseError('請選尿或便');
      return date + ' ' + time + ' 尿布 ' + label;
    }
    case 'temp':
      return date + ' ' + time + ' 體溫 ' + num(f.temp, '體溫');
    case 'weight':
      return date + ' ' + time + ' 體重 ' + num(f.kg, '體重');
    default:
      throw new ParseError('請選要補登的類型');
  }
}

function handleEvent(service, event) {
  if (event.type === 'follow' || event.type === 'join') {
    replyText(event.replyToken, '嗨！我是寶寶生理時鐘小幫手 👶\n\n' + HELP_TEXT);
    return;
  }
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;
  const source = event.source || {};
  // 名字只在真的要記錄時才查（傳函式進去，看不懂的聊天訊息就不會多打一次 LINE API）
  const chatId = chatIdOf(source);
  const reply = service.handle(chatId, event.message.text, function () { return recorderName(source); });
  if (!reply) {
    // 群組裡看不懂就安靜；一對一聊天時提示一下，免得以為已經記好了
    if (source.type === 'user') replyText(event.replyToken, '🤔 看不懂這則訊息，所以沒有記錄。\n輸入「說明」可以看所有指令。', quickActions(chatId));
    return;
  }
  replyMessage(event.replyToken, reply, quickActions(chatId));
}

// 群組／聊天室共用同一份紀錄，讓爸媽一起記；一對一聊天則以使用者為單位
function chatIdOf(source) {
  return source.groupId || source.roomId || source.userId;
}

// 每則回覆下方的快速按鈕（LINE 最多 13 個）。拿不到網址時用的文字版本。
const QUICK_ACTIONS = [
  ['🍼 餵奶', '餵奶'],
  ['😴 睡覺', '睡覺'],
  ['☀️ 起床', '起床'],
  ['💧 尿', '尿布 尿'],
  ['💩 便', '尿布 便'],
  ['⏱️ 狀態', '狀態'],
  ['📊 今天', '今天'],
  ['📈 報表', '報表'],
  ['↩️ 復原', '復原'],
];

/**
 * 這個聊天室的快速按鈕：「餵奶」、「尿布」、「其他」點了會打開記錄表單，
 * 其他按鈕直接送出文字。按鈕的第二格是文字，或 { uri: 網址 }。
 */
function quickActions(chatId) {
  const feed = formUrl(chatId, 'feed');
  if (!feed) return QUICK_ACTIONS;
  return [
    ['🍼 餵奶', { uri: feed }],
    ['😴 睡覺', '睡覺'],
    ['☀️ 起床', '起床'],
    ['🧷 尿布', { uri: formUrl(chatId, 'diaper') }],
    ['＋ 其他', { uri: formUrl(chatId, 'other') }],
    ['⏱️ 狀態', '狀態'],
    ['📊 今天', '今天'],
    ['📈 報表', '報表'],
    ['↩️ 復原', '復原'],
  ];
}

/** reply 可以是文字、{ text, quick }，或 { flex, altText, quick }（圖卡）；回覆沒指定按鈕時用 defaultQuick */
function replyMessage(replyToken, reply, defaultQuick) {
  if (typeof reply === 'string') return replyText(replyToken, reply, defaultQuick);
  const quick = reply.quick || defaultQuick;
  if (reply.flex) return sendReply(replyToken, { type: 'flex', altText: reply.altText, contents: reply.flex }, quick);
  return replyText(replyToken, reply.text, quick);
}

/** quick 是快速按鈕 [[標籤, 送出的文字或 { uri }], ...]，沒給就用預設的 QUICK_ACTIONS */
function replyText(replyToken, text, quick) {
  return sendReply(replyToken, { type: 'text', text: text.slice(0, 5000) }, quick);
}

function sendReply(replyToken, message, quick) {
  message.quickReply = {
    items: (quick || QUICK_ACTIONS).slice(0, 13).map(function (a) {
      const action = a[1] && a[1].uri
        ? { type: 'uri', label: a[0], uri: a[1].uri }
        : { type: 'message', label: a[0], text: a[1] };
      return { type: 'action', action: action };
    }),
  };
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + lineToken() },
    payload: JSON.stringify({ replyToken: replyToken, messages: [message] }),
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

const WEEKDAYS = '日一二三四五六';

function fmtWeekday(date) {
  return WEEKDAYS[new Date(date.getTime() + TZ_OFFSET_HOURS * 3600000).getUTCDay()];
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
  喝奶: '喝奶', 餵奶: '喝奶', 吃奶: '喝奶', 奶: '喝奶', 副食品: '副食品', 吃飯: '副食品', 吃: '副食品',
};
const SKIP_AMOUNT = '不記量';
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
const SETTING_WORDS = ['設定', '設置'];

const QUERY_WORDS = {
  今天: 'today', 今日: 'today', 昨天: 'yesterday', 昨日: 'yesterday',
  今天明細: 'today_detail', 今日明細: 'today_detail', 昨天明細: 'yesterday_detail', 昨日明細: 'yesterday_detail',
  報表: 'report', 圖表: 'report', 報告: 'report',
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
  const skipAmount = rest.indexOf(SKIP_AMOUNT) >= 0;
  rest = rest.replace(SKIP_AMOUNT, ' ');
  // 只打「餵奶」或「配方奶」沒有其他內容：用按鈕問種類或份量
  if (!skipAmount && !rest.trim()) {
    if (kind === '喝奶') return { action: 'ask_feed_type', at: at };
    return { action: 'ask_feed_amount', feedKind: kind, word: word, at: at };
  }
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

/** 「10/6 14:30 喝奶 120」這種開頭有日期的寫法：回傳那天 00:00 和剩下的文字 */
function stripDate(text, now) {
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\s+(.+)$/);
  if (!m) return null;
  const mo = Number(m[1]) - 1;
  const d = Number(m[2]);
  const p = localParts(now);
  let day = makeLocal(p.y, mo, d, 0, 0);
  if (mo > 11 || d < 1 || localParts(day).d !== d) return null; // 不是日期（例如聊天時打的「3/40」）就不理會
  if (day > now) day = makeLocal(p.y - 1, mo, d, 0, 0); // 比今天晚的日期當作去年
  return { day: day, body: m[3] };
}

/** 解析一筆紀錄（不含查詢指令）。explicitTime 表示使用者有指定時間，dated 表示有指定日期。 */
function parseRecord(text, now) {
  const dated = stripDate(text, now);
  if (!dated) return parseRecordAt(text, now);
  // 以那天的 23:59 為基準解析時間，時間就不會被當成前一天
  const cmd = parseRecordAt(dated.body, addMinutes(dated.day, 24 * 60 - 1));
  if (!cmd) return null;
  if (!cmd.explicitTime) throw new ParseError('補登其他天的紀錄要加上時間，例如：' + fmtDate(dated.day) + ' 14:30 配方奶 120');
  const latestAllowed = addMinutes(now, 5);
  if (cmd.at > latestAllowed || (cmd.end && cmd.end > latestAllowed)) throw new ParseError('時間比現在晚，請確認日期和時間');
  cmd.dated = true;
  return cmd;
}

function parseRecordAt(text, now) {
  const range = parseSleepRange(text, now);
  if (range) return range;
  const st = stripTime(text, now);
  if (!st.body) return null;
  const cmd = parseBody(st.body, st.at || now);
  if (cmd) cmd.explicitTime = !!st.at;
  return cmd;
}

/** 「設定 生日 2026/8/5」、「設定 性別 女」、「設定 名字 小寶」；只打「設定」就顯示目前的設定 */
function parseSetting(rest) {
  rest = rest.trim();
  if (!rest) return { action: 'settings' };
  let m = rest.match(/^(生日|出生日期|出生)\s*(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/);
  if (m) {
    const y = Number(m[2]);
    const mo = Number(m[3]) - 1;
    const d = Number(m[4]);
    const birth = makeLocal(y, mo, d, 0, 0);
    if (mo > 11 || localParts(birth).d !== d) throw new ParseError('生日日期不正確，例如：設定 生日 2026/8/5');
    return { action: 'settings', field: 'birth', value: birth.getTime() };
  }
  m = rest.match(/^性別\s*(男|女)/);
  if (m) return { action: 'settings', field: 'sex', value: m[1] };
  m = rest.match(/^(名字|暱稱|小名)\s*(.+)$/);
  if (m) return { action: 'settings', field: 'name', value: m[2].trim().slice(0, 20) };
  throw new ParseError('可以設定的項目：\n設定 生日 2026/8/5\n設定 性別 男（或 女）\n設定 名字 小寶');
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

  word = startsWithWord(text, SETTING_WORDS);
  if (word) return parseSetting(text.slice(word.length));

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
  '【吃】點「🍼 餵奶」按鈕，選種類和份量就好',
  '也可以直接打：配方奶 150 / 瓶餵母乳 90',
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
  '其他天的話前面加日期：10/6 14:30 配方奶 120',
  '忘了按起床：起床 07:30',
  '',
  '【查詢】',
  '今天 / 昨天 → 當日統計圖卡',
  '今天明細 / 昨天明細 → 每一筆紀錄',
  '報表 → 作息圖、趨勢、成長曲線網頁（也能補登）',
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
  '【寶寶資料】設定 生日 2026/8/5 / 設定 性別 女 / 設定 名字 小寶',
  '（設定後，報表的體重曲線會對照 WHO 標準）',
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
  if (typeof userId === 'function') userId = userId();
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
  let reply = '✅ 已記錄' + (cmd.dated ? '（' + fmtDate(rec.start) + '）' : '') + '\n' + describe(rec, now);
  const extra = this.afterRecord(chatId, rec, now);
  if (extra) reply += '\n' + extra;
  const forgot = this.forgotWakeReminder(chatId, rec, now);
  return forgot ? reply + '\n\n' + forgot : reply;
};

/** 睡眠開著超過 6 小時又記了別的東西，多半是忘了按「起床」 */
BabyService.prototype.forgotWakeReminder = function (chatId, rec, now) {
  const opened = this.storage.openSleep(chatId);
  if (!opened || rec.start <= opened.start || now - opened.start < 6 * 3600000) return '';
  return '⚠️ 寶寶從 ' + fmtDate(opened.start) + ' ' + fmtTime(opened.start) + ' 睡到現在還沒記「起床」（已 ' +
    fmtDuration(now - opened.start) + '）。\n如果早就醒了，輸入「起床 07:30」補上起床時間。';
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
    // 補登比較早的餐就不預測（預測要以最新的一餐為準）
    const isLatest = !s.ofKind(chatId, FEED).some(function (r) { return r.start > rec.start; });
    if (isLatest) {
      const p = this.predictNextFeed(chatId, rec);
      lines.push('');
      lines.push(p ? describePrediction(p) : '🔮 再多記錄幾餐（約 1～2 天），就會開始預測下一餐');
    }
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

// 有指定時間（例如「14:30 餵奶」）時，按鈕送出的文字也要帶著時間
function timePrefix(cmd) {
  if (!cmd.explicitTime) return '';
  return (cmd.dated ? fmtDate(cmd.at) + ' ' : '') + fmtTime(cmd.at) + ' ';
}

BabyService.prototype.do_ask_feed_type = function (chatId, cmd) {
  const p = timePrefix(cmd);
  return {
    text: '🍼 ' + p + '要記錄哪一種？\n點下面的按鈕選擇 👇',
    quick: [
      ['🤱 親餵', p + '母乳'],
      ['🍼 瓶餵母乳', p + '瓶餵母乳'],
      ['🥛 配方奶', p + '配方奶'],
      ['🥣 副食品', p + '副食品'],
    ],
  };
};

BabyService.prototype.do_ask_feed_amount = function (chatId, cmd) {
  const p = timePrefix(cmd);
  const kind = cmd.feedKind;
  const skip = ['✔️ 不記量', p + kind + ' ' + SKIP_AMOUNT];

  if (kind === '母乳') {
    const quick = [];
    [['👈 左', '左'], ['👉 右', '右']].forEach(function (side) {
      [10, 15, 20].forEach(function (min) {
        quick.push([side[0] + ' ' + min + '分', p + '母乳 ' + side[1] + ' ' + min]);
      });
    });
    quick.push(['🤲 雙邊 20分', p + '母乳 雙邊 20'], ['🤲 雙邊 30分', p + '母乳 雙邊 30'], skip);
    return { text: '🤱 親餵哪一邊、多久？\n（其他時間直接打，例如：母乳 左 12）', quick: quick };
  }

  const solid = kind === '副食品';
  const unit = solid ? 'g' : 'ml';
  const last = latest(this.storage.ofKind(chatId, FEED).filter(function (r) {
    return r.unit === unit && r.value && r.detail.split(' ')[0] === kind;
  }));
  const step = 10;
  let amounts;
  if (last) {
    const center = Math.round(last.value / step) * step;
    amounts = [-30, -20, -10, 0, 10, 20, 30].map(function (d) { return center + d; })
      .filter(function (v) { return v > 0; });
  } else {
    amounts = solid ? [10, 20, 30, 50, 80, 100, 150] : [60, 90, 120, 150, 180, 210, 240];
  }
  const quick = amounts.map(function (v) {
    const isLast = last && v === Math.round(last.value / step) * step;
    return [(isLast ? '⭐ ' : '') + v + unit, p + kind + ' ' + v];
  });
  quick.push(skip);
  const icon = solid ? '🥣 ' : kind === '配方奶' ? '🥛 ' : '🍼 ';
  return {
    text: icon + kind + (solid ? '吃' : '喝') + '了多少？' +
      (last ? '\n上次' + (solid ? '吃' : '喝') + ' ' + fmtValue(last.value, last.unit) + '（⭐）' : '') +
      '\n（其他份量直接打，例如：' + kind + ' ' + (solid ? 45 : 135) + '）',
    quick: quick,
  };
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
  const clash = latest(this.storage.ofKind(chatId, SLEEP).filter(function (r) {
    return r.start < cmd.end && (r.end || now) > cmd.at;
  }));
  if (clash) {
    return '⚠️ 這段睡眠跟已經記的「' + describe(clash, now).replace(/^😴 /, '') + '」重疊了，請確認時間。' +
      (clash.end ? '' : '\n（寶寶還在睡的話，醒來時輸入「起床」就好）');
  }
  const rec = this.storage.add(chatId, SLEEP, cmd.at, { end: cmd.end, userId: userId });
  return '✅ 已補登（' + fmtDate(rec.start) + '）\n' + describe(rec, now);
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
  return this.dayCard(chatId, startOfDay(now), now, '今天');
};

BabyService.prototype.do_yesterday = function (chatId, cmd, userId, now) {
  return this.dayCard(chatId, addMinutes(startOfDay(now), -24 * 60), now, '昨天');
};

BabyService.prototype.do_today_detail = function (chatId, cmd, userId, now) {
  return this.daySummary(chatId, startOfDay(now), now);
};

BabyService.prototype.do_yesterday_detail = function (chatId, cmd, userId, now) {
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

// ======== 今日圖卡（LINE Flex Message） ========

function flexRow(label, value) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#666666', flex: 2 },
      { type: 'text', text: value, size: 'sm', color: '#111111', weight: 'bold', align: 'end', wrap: true, flex: 5 },
    ],
  };
}

/** 「今天」、「昨天」：一張統計圖卡，下面有「看報表」和「看明細」按鈕 */
BabyService.prototype.dayCard = function (chatId, start, now, label) {
  const st = this.dayStats(chatId, start, now);
  const title = '📊 ' + fmtDate(start) + '（' + fmtWeekday(start) + '）' + label;
  if (!st.records.length) return title + '\n這天還沒有紀錄。';
  const isToday = label === '今天';

  const feed = [st.feeds + ' 次'];
  if (st.ml) feed.push(fmtNum(st.ml) + 'ml');
  if (st.breast) feed.push('親餵 ' + fmtNum(st.breast) + ' 分');
  const rows = [
    flexRow('🍼 餵食', feed.join(' · ')),
    flexRow('😴 睡眠', fmtDuration(st.sleepMs) + '（' + st.sleeps + ' 段）'),
    flexRow('🧷 尿布', '尿 ' + st.pee + ' · 便 ' + st.poo),
  ];
  if (st.temps) rows.push(flexRow('🌡️ 體溫', '最高 ' + fmtNum(st.maxTemp) + '°C' + (st.maxTemp >= 38 ? ' ⚠️' : '')));
  if (st.pumps) rows.push(flexRow('🥛 擠奶', st.pumps + ' 次' + (st.pumpMl ? ' · ' + fmtNum(st.pumpMl) + 'ml' : '')));
  if (st.meds) rows.push(flexRow('💊 吃藥', st.meds + ' 次'));
  if (st.baths) rows.push(flexRow('🛁 洗澡', st.baths + ' 次'));

  const body = [
    { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: isToday ? '統計到 ' + fmtTime(now) + ' 為止' : '全天統計', size: 'xs', color: '#999999' },
    { type: 'separator', margin: 'md' },
    { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: rows },
  ];
  if (isToday) {
    const last = this.storage.lastOfKind(chatId, FEED);
    const p = last && this.predictNextFeed(chatId, last);
    if (p) {
      body.push({ type: 'separator', margin: 'md' });
      body.push({
        type: 'text', margin: 'md', size: 'sm', wrap: true, color: '#111111',
        text: '🔮 預計下一餐約 ' + fmtTime(p.at) + (p.amount ? '，約 ' + p.amount + 'ml' : ''),
      });
    }
  }

  const buttons = [];
  const url = reportUrl(chatId);
  if (url) buttons.push({ type: 'button', style: 'primary', color: '#2a78d6', height: 'sm', action: { type: 'uri', label: '📈 看完整報表', uri: url } });
  buttons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📋 看明細', text: label + '明細' } });

  return {
    altText: title + '：餵食 ' + st.feeds + ' 次、睡眠 ' + fmtDuration(st.sleepMs) + '、尿布 ' + st.diapers + ' 次',
    flex: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
    },
  };
};

// ======== 寶寶設定與報表 ========

BabyService.prototype.do_settings = function (chatId, cmd) {
  const info = getBabyInfo(chatId);
  if (cmd.field) {
    info[cmd.field] = cmd.value;
    setBabyInfo(chatId, info);
  }
  const lines = [cmd.field ? '✅ 已更新寶寶資料' : '👶 寶寶資料'];
  lines.push('名字：' + (info.name || '（未設定）'));
  lines.push('生日：' + (info.birth ? fmtFullDate(new Date(info.birth)) : '（未設定）'));
  lines.push('性別：' + (info.sex || '（未設定）'));
  if (!info.birth || !info.sex) {
    lines.push('', '設定生日和性別後，報表的體重曲線會對照 WHO 標準：', '設定 生日 2026/8/5', '設定 性別 男（或 女）');
  }
  return lines.join('\n');
};

BabyService.prototype.do_report = function (chatId) {
  const url = reportUrl(chatId);
  if (!url) return '目前拿不到報表網址 🤔\n請確認 Apps Script 已經用「網頁應用程式」部署。';
  return {
    text: '📈 寶寶作息報表\n' + url + '\n\n可以看 24 小時作息圖、每日趨勢、成長曲線，也能補登漏記的紀錄。\n' +
      '⚠️ 這個連結可以看和新增紀錄，請不要轉傳給其他人。',
  };
};

/** 報表網頁需要的資料（時間都用毫秒，網頁再用台灣時間顯示） */
BabyService.prototype.reportData = function (chatId, now) {
  const s = this.storage;
  const today = startOfDay(now);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const start = addMinutes(today, -i * 24 * 60);
    const st = this.dayStats(chatId, start, now);
    const feeds = st.records.filter(function (r) { return r.kind === FEED && r.start >= start; });
    let gapSum = 0;
    for (let j = 1; j < feeds.length; j++) gapSum += feeds[j].start - feeds[j - 1].start;
    days.push({
      d0: start.getTime(), ml: st.ml, n: st.feeds, breast: st.breast, sleepH: Math.round(st.sleepMs / 36000) / 100,
      gapH: feeds.length > 1 ? Math.round(gapSum / (feeds.length - 1) / 36000) / 100 : null, pee: st.pee, poo: st.poo,
    });
  }

  // 作息圖：最近 7 天（多抓一天，才能找出跨日的漏記）
  const recs = s.between(chatId, addMinutes(today, -7 * 24 * 60), addMinutes(now, 1));
  const sleeps = [];
  const feeds = [];
  const diapers = [];
  recs.forEach(function (r) {
    if (r.kind === SLEEP) sleeps.push({ s: r.start.getTime(), e: (r.end || now).getTime(), ongoing: !r.end, web: r.userId === WEB_RECORDER });
    if (r.kind === FEED) feeds.push({ t: r.start.getTime(), label: (r.detail + ' ' + fmtValue(r.value, r.unit)).trim(), web: r.userId === WEB_RECORDER });
    if (r.kind === DIAPER) {
      const label = r.detail.split(' ')[0];
      if (label.indexOf('尿') >= 0) diapers.push({ t: r.start.getTime(), kind: 'pee', web: r.userId === WEB_RECORDER });
      if (label.indexOf('便') >= 0) diapers.push({ t: r.start.getTime(), kind: 'poo', web: r.userId === WEB_RECORDER });
    }
  });

  const lastFeed = s.lastOfKind(chatId, FEED);
  const p = lastFeed && this.predictNextFeed(chatId, lastFeed);
  const lastTemp = s.lastOfKind(chatId, TEMP);
  const lastDiaper = s.lastOfKind(chatId, DIAPER);
  return {
    now: now.getTime(),
    today: today.getTime(),
    baby: getBabyInfo(chatId),
    days: days,
    sleeps: sleeps,
    feeds: feeds,
    diapers: diapers,
    growth: s.ofKind(chatId, GROWTH).map(function (r) { return { t: r.start.getTime(), what: r.detail, v: r.value, unit: r.unit }; }),
    lastFeed: lastFeed ? { t: lastFeed.start.getTime(), label: (lastFeed.detail + ' ' + fmtValue(lastFeed.value, lastFeed.unit)).trim() } : null,
    lastTemp: lastTemp && lastTemp.value != null ? { t: lastTemp.start.getTime(), v: lastTemp.value } : null,
    lastDiaper: lastDiaper ? { t: lastDiaper.start.getTime(), label: lastDiaper.detail } : null,
    sleeping: !!s.openSleep(chatId),
    prediction: p ? { at: p.at.getTime(), amount: p.amount } : null,
  };
};

// ======== 報表網頁 ========

/** 把資料放進報表網頁（JSON 裡的 < 先轉義，避免資料內容被當成 HTML） */
function reportHtml(key, data, mode, liffId) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return REPORT_HTML
    .replace('__KEY__', function () { return JSON.stringify(key); })
    .replace('__MODE__', function () { return JSON.stringify(mode || null); })
    .replace('__LIFF__', function () { return JSON.stringify(liffId || ''); })
    .replace('__DATA__', function () { return json; });
}

// 報表網頁本身（HTML + CSS + JavaScript）。用 String.raw 保留裡面的反斜線。
const REPORT_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>寶寶作息報表</title>
<style>
:root {
  --page: #f7f8f6; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10); --night: #eef1f6;
  --accent: #2a78d6; --sleep: #2a78d6; --feed: #eb6834; --pee: #1baf7a; --poo: #eda100;
  --band: rgba(42,120,214,0.08); --good: #006300; --chip-on: #0b0b0b; --chip-on-ink: #ffffff;
  --warn: #b77a00; --warn-bg: rgba(250,178,25,0.10); --crit: #d03b3b;
  --font: system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Segoe UI", sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --night: #202329;
    --accent: #3987e5; --sleep: #3987e5; --feed: #d95926; --pee: #199e70; --poo: #c98500;
    --band: rgba(57,135,229,0.12); --good: #0ca30c; --chip-on: #ffffff; --chip-on-ink: #0b0b0b;
    --warn: #fab219; --warn-bg: rgba(250,178,25,0.10); --crit: #e66767;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body { background: var(--page); color: var(--ink); font-family: var(--font); font-size: 14px; line-height: 1.5; }
.wrap { max-width: 560px; margin: 0 auto; padding: 16px 16px 90px; display: flex; flex-direction: column; gap: 16px; }
header { display: flex; flex-direction: column; gap: 4px; }
.eyebrow { color: var(--ink-2); font-size: 12px; letter-spacing: .04em; }
h1 { font-size: 22px; margin: 0; font-weight: 700; }
h2 { font-size: 15px; margin: 0; font-weight: 650; }
.sub { color: var(--muted); font-size: 12px; margin: 0; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.tiles { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tile .k { font-size: 12px; color: var(--ink-2); display: flex; align-items: center; gap: 6px; }
.tile .v { font-size: 24px; font-weight: 700; line-height: 1.2; }
.tile .v small { font-size: 13px; font-weight: 500; color: var(--ink-2); margin-left: 2px; }
.tile .d { font-size: 12px; color: var(--muted); }
.tile.wide { grid-column: 1 / -1; flex-direction: row; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font: inherit; font-size: 12px; border: 1px solid var(--border); background: transparent; color: var(--ink-2); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--chip-on); color: var(--chip-on-ink); border-color: var(--chip-on); }
.chip:focus-visible, .btn:focus-visible, .seg button:focus-visible, .field input:focus-visible, .field select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
svg { display: block; width: 100%; overflow: visible; }
svg text { fill: var(--muted); font-family: var(--font); font-size: 10px; font-variant-numeric: tabular-nums; }
svg text.rowlab { fill: var(--ink-2); font-size: 11px; }
svg text.vlab { fill: var(--ink-2); }
.mini { display: flex; flex-direction: column; gap: 4px; }
.mini-title { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; color: var(--ink-2); gap: 8px; flex-wrap: wrap; }
.mini-title b { color: var(--ink); font-size: 13px; }
.tip { position: fixed; z-index: 10; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 12px; line-height: 1.45; box-shadow: 0 4px 16px rgba(0,0,0,.12); max-width: 220px; white-space: pre-line; }
details { font-size: 13px; }
summary { cursor: pointer; color: var(--ink-2); }
.tbl { overflow-x: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 12px; }
th, td { padding: 5px 6px; text-align: right; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--ink-2); font-weight: 600; }
.note { font-size: 12px; color: var(--muted); margin: 0; }
.btn { font: inherit; font-size: 13px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 8px 12px; cursor: pointer; }
.btn.primary { background: var(--chip-on); color: var(--chip-on-ink); border-color: var(--chip-on); font-weight: 600; }
.btn[disabled] { opacity: .6; cursor: progress; }
.addbar { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px)); display: flex; justify-content: center; pointer-events: none; z-index: 5; }
.addbar .btn { pointer-events: auto; box-shadow: 0 4px 16px rgba(0,0,0,.18); border-radius: 999px; padding: 10px 20px; font-size: 14px; }
.gaps { display: flex; flex-direction: column; gap: 6px; }
.gap-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; padding: 8px 10px; border: 1px dashed var(--warn); border-radius: 8px; background: var(--warn-bg); }
.gap-row b { font-weight: 600; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 20; display: flex; align-items: flex-end; justify-content: center; }
.sheet { background: var(--surface); color: var(--ink); width: 100%; max-width: 560px; border-radius: 16px 16px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column; gap: 12px; max-height: 92%; overflow-y: auto; }
.sheet-head { display: flex; justify-content: space-between; align-items: center; }
.sheet-head h2 { font-size: 17px; }
.x { font: inherit; font-size: 22px; line-height: 1; background: none; border: 0; color: var(--ink-2); cursor: pointer; padding: 4px 8px; }
.seg { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 6px; }
.seg.three { grid-template-columns: repeat(3, minmax(0,1fr)); }
.seg button { font: inherit; font-size: 12px; border: 1px solid var(--border); background: transparent; color: var(--ink); border-radius: 10px; padding: 8px 2px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.seg button span { font-size: 18px; }
.seg button[aria-pressed="true"] { border-color: var(--ink); background: var(--page); font-weight: 600; }
.fields { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; color: var(--ink-2); }
.field.full { grid-column: 1 / -1; }
.field input, .field select { font: inherit; font-size: 16px; color: var(--ink); background: var(--page); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; width: 100%; min-width: 0; }
.err { color: var(--crit); font-size: 13px; min-height: 1em; white-space: pre-line; }
.preview-line { font-size: 13px; color: var(--ink-2); background: var(--page); border-radius: 8px; padding: 8px 10px; }
.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(70px + env(safe-area-inset-bottom, 0px)); z-index: 30; background: var(--chip-on); color: var(--chip-on-ink); padding: 9px 14px; border-radius: 10px; font-size: 13px; max-width: calc(100% - 32px); box-shadow: 0 4px 16px rgba(0,0,0,.2); white-space: pre-line; }
.empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
/* 從快速按鈕打開時：只顯示記錄表單 */
body.form-mode .wrap, body.form-mode .addbar { display: none; }
body.form-mode .overlay { position: static; background: transparent; display: block; }
body.form-mode { background: var(--surface); }
body.form-mode .sheet { border-radius: 0; max-height: none; min-height: 100vh; margin: 0 auto; }
.done { display: flex; flex-direction: column; gap: 10px; }
.done-msg { white-space: pre-line; font-size: 15px; background: var(--page); border-radius: 10px; padding: 12px; }
.done-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.done-actions .btn { flex: 1 1 auto; }
form.is-done > :not(.sheet-head):not(.done) { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow" id="baby-line"></div>
    <h1>寶寶作息報表</h1>
    <p class="sub" id="asof"></p>
  </header>

  <section class="tiles" aria-label="今日摘要" id="tiles"></section>

  <section class="panel" aria-labelledby="gaps-h" id="gaps-panel" hidden>
    <div class="panel-head">
      <h2 id="gaps-h">⚠️ 可能漏記</h2>
      <span class="sub">餵奶間隔特別長的地方，點「補登」把漏掉的加回去</span>
    </div>
    <div class="gaps" id="gaps"></div>
  </section>

  <section class="panel" aria-labelledby="rhythm-h">
    <div class="panel-head">
      <h2 id="rhythm-h">24 小時作息圖</h2>
      <span class="sub">點色塊看細節 · 點空白處補登</span>
    </div>
    <div class="legend" aria-hidden="true">
      <span><i class="sw" style="background:var(--sleep)"></i>睡眠</span>
      <span><svg width="10" height="10" style="width:10px"><circle cx="5" cy="5" r="4" fill="var(--feed)"/></svg>餵奶</span>
      <span><svg width="10" height="10" style="width:10px"><rect x="3" y="0" width="4" height="10" rx="1" fill="var(--pee)"/></svg>尿</span>
      <span><svg width="10" height="10" style="width:10px"><rect x="0" y="3" width="10" height="4" rx="1" fill="var(--poo)"/></svg>便</span>
      <span><i class="sw" style="background:var(--night)"></i>夜間 22–06</span>
    </div>
    <div id="rhythm"></div>
  </section>

  <section class="panel" aria-labelledby="trend-h">
    <div class="panel-head">
      <h2 id="trend-h">每日趨勢</h2>
      <div class="chips" role="group" aria-label="天數">
        <button class="chip" id="r7" data-days="7" aria-pressed="false">7 天</button>
        <button class="chip" id="r14" data-days="14" aria-pressed="true">14 天</button>
        <button class="chip" id="r30" data-days="30" aria-pressed="false">30 天</button>
      </div>
    </div>
    <div class="mini"><div class="mini-title"><span><i class="sw" style="background:var(--feed)"></i> 每日奶量 (ml)</span><b id="t-ml"></b></div><div id="c-ml"></div></div>
    <div class="mini"><div class="mini-title"><span><i class="sw" style="background:var(--sleep)"></i> 每日睡眠 (小時)</span><b id="t-sleep"></b></div><div id="c-sleep"></div></div>
    <div class="mini"><div class="mini-title"><span><i class="sw" style="background:var(--feed)"></i> 平均餵奶間隔 (小時)</span><b id="t-gap"></b></div><div id="c-gap"></div></div>
    <div class="mini"><div class="mini-title"><span>尿布次數 · <i class="sw" style="background:var(--pee)"></i> 尿 <i class="sw" style="background:var(--poo)"></i> 便</span><b id="t-diaper"></b></div><div id="c-diaper"></div></div>
    <details>
      <summary>查看每日數字表格</summary>
      <div class="tbl"><table id="tbl"></table></div>
    </details>
  </section>

  <section class="panel" aria-labelledby="growth-h">
    <div class="panel-head">
      <h2 id="growth-h">成長曲線</h2>
      <div class="chips" role="group" aria-label="項目">
        <button class="chip" id="g-w" data-what="體重" aria-pressed="true">體重</button>
        <button class="chip" id="g-h" data-what="身高" aria-pressed="false">身高</button>
        <button class="chip" id="g-c" data-what="頭圍" aria-pressed="false">頭圍</button>
      </div>
    </div>
    <div class="legend" id="growth-legend" aria-hidden="true"></div>
    <div id="growth"></div>
    <p class="note" id="growth-note"></p>
  </section>

  <p class="note">資料來自你們的試算表，每次打開都是最新的。這個連結可以看和新增紀錄，請不要轉傳給其他人。</p>
</div>

<div class="tip" id="tip" hidden></div>
<div class="addbar"><button class="btn primary" id="add-btn" type="button">＋ 補登紀錄</button></div>
<div class="toast" id="toast" role="status" hidden></div>

<div class="overlay" id="overlay" hidden>
  <form class="sheet" id="add-form" role="dialog" aria-modal="true" aria-labelledby="add-h" novalidate>
    <div class="sheet-head"><h2 id="add-h">補登紀錄</h2><button class="x" type="button" id="add-close" aria-label="關閉">×</button></div>
    <div class="seg" role="group" aria-label="類型" id="kind-seg">
      <button type="button" id="k-feed" data-kind="feed" aria-pressed="true"><span>🍼</span>餵奶</button>
      <button type="button" id="k-sleep" data-kind="sleep" aria-pressed="false"><span>😴</span>睡眠</button>
      <button type="button" id="k-diaper" data-kind="diaper" aria-pressed="false"><span>🧷</span>尿布</button>
      <button type="button" id="k-temp" data-kind="temp" aria-pressed="false"><span>🌡️</span>體溫</button>
      <button type="button" id="k-weight" data-kind="weight" aria-pressed="false"><span>⚖️</span>體重</button>
    </div>
    <div class="fields">
      <label class="field"><span>日期</span><select id="f-date"></select></label>
      <label class="field"><span id="f-time-lab">時間</span><input type="time" id="f-time" step="300"></label>
      <label class="field" data-for="sleep"><span>醒來時間</span><input type="time" id="f-end" step="300"></label>
      <label class="field" data-for="feed"><span>種類</span><select id="f-feedtype"><option value="配方奶">配方奶</option><option value="瓶餵母乳">瓶餵母乳</option><option value="母乳">親餵</option><option value="副食品">副食品</option></select></label>
      <label class="field" data-for="feed"><span id="f-ml-lab">奶量 (ml)</span><input type="number" id="f-ml" inputmode="numeric" min="1" max="400" step="10"></label>
      <div class="field full" data-for="diaper"><span>內容</span><div class="seg three" id="diaper-seg">
        <button type="button" id="d-pee" data-v="pee" aria-pressed="true">💧 尿</button>
        <button type="button" id="d-poo" data-v="poo" aria-pressed="false">💩 便</button>
        <button type="button" id="d-both" data-v="both" aria-pressed="false">尿＋便</button>
      </div></div>
      <label class="field" data-for="temp"><span>體溫 (°C)</span><input type="number" id="f-temp" inputmode="decimal" min="34" max="42" step="0.1" value="37.0"></label>
      <label class="field" data-for="weight"><span>體重 (kg)</span><input type="number" id="f-kg" inputmode="decimal" min="1" max="20" step="0.01"></label>
    </div>
    <div class="preview-line" id="f-preview"></div>
    <div class="err" id="f-err" role="alert"></div>
    <button class="btn primary" type="submit" id="f-submit">補登</button>
    <div class="done" id="done" hidden>
      <div class="done-msg" id="done-msg"></div>
      <div class="done-actions">
        <button class="btn" type="button" id="done-again">再記一筆</button>
        <button class="btn" type="button" id="done-report">看報表</button>
        <button class="btn primary" type="button" id="done-close">關閉</button>
      </div>
    </div>
    <p class="note" id="f-note">會直接寫進試算表，跟在 LINE 打「10/6 14:30 配方奶 120」的效果一樣。補錯了可以在 LINE 輸入「復原」刪掉。</p>
  </form>
</div>

<script>
var KEY = __KEY__;
var MODE = __MODE__;
var LIFF_ID = __LIFF__;
var DATA = __DATA__;
(function () {
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, OFF = 8 * HOUR;
  var WD = '日一二三四五六';
  var NS = 'http://www.w3.org/2000/svg';
  // WHO 體重（kg）第 3／50／97 百分位，0～12 個月
  var WHO = {
    男: [[0, 2.5, 3.3, 4.4], [1, 3.4, 4.5, 5.8], [2, 4.4, 5.6, 7.1], [3, 5.1, 6.4, 8.0], [4, 5.6, 7.0, 8.7], [5, 6.1, 7.5, 9.3], [6, 6.4, 7.9, 9.8],
      [7, 6.7, 8.3, 10.3], [8, 7.0, 8.6, 10.7], [9, 7.2, 8.9, 11.0], [10, 7.5, 9.2, 11.4], [11, 7.7, 9.4, 11.7], [12, 7.8, 9.6, 12.0]],
    女: [[0, 2.4, 3.2, 4.2], [1, 3.2, 4.2, 5.4], [2, 4.0, 5.1, 6.5], [3, 4.6, 5.8, 7.4], [4, 5.1, 6.4, 8.1], [5, 5.5, 6.9, 8.7], [6, 5.8, 7.3, 9.2],
      [7, 6.1, 7.6, 9.6], [8, 6.3, 7.9, 10.0], [9, 6.6, 8.2, 10.4], [10, 6.8, 8.5, 10.7], [11, 7.0, 8.7, 11.0], [12, 7.1, 8.9, 11.3]]
  };

  // ---------- 台灣時間工具 ----------
  function tw(t) { var d = new Date(t + OFF); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() }; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(t) { var p = tw(t); return pad(p.h) + ':' + pad(p.mi); }
  function md(t) { var p = tw(t); return (p.mo + 1) + '/' + p.d; }
  function dayOf(t) { return Math.floor((t + OFF) / DAY) * DAY - OFF; }
  function isNight(t) { var h = tw(t).h; return h >= 22 || h < 6; }
  function dayLabel(d0) {
    var off = Math.round((DATA.today - d0) / DAY);
    return off === 0 ? '今天' : off === 1 ? '昨天' : md(d0) + ' ' + WD[tw(d0).wd];
  }
  function dur(ms) {
    var m = Math.round(ms / MIN), h = Math.floor(m / 60);
    if (h && m % 60) return h + '小時' + (m % 60) + '分';
    if (h) return h + '小時';
    return m + '分鐘';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function el(name, attrs, parent) { var n = document.createElementNS(NS, name); for (var k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; }
  function text(parent, x, y, s, attrs) { var a = { x: x, y: y }; for (var k in attrs || {}) a[k] = attrs[k]; var n = el('text', a, parent); n.textContent = s; return n; }
  function niceMax(v, step) { return Math.max(step, Math.ceil(v / step) * step); }
  function round5(t) { return Math.floor(t / (5 * MIN)) * 5 * MIN; }

  // ---------- 提示框 ----------
  var tip = $('tip');
  function showTip(e, s) {
    tip.textContent = s; tip.hidden = false;
    var r = tip.getBoundingClientRect(), x = e.clientX + 12, y = e.clientY + 12;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
    if (x < 8) x = 8;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 12;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function tipTarget(e) { return e.target.closest ? e.target.closest('[data-tip]') : null; }
  document.addEventListener('pointermove', function (e) { var m = tipTarget(e); if (m) showTip(e, m.getAttribute('data-tip')); else if (e.pointerType === 'mouse') tip.hidden = true; });
  document.addEventListener('pointerdown', function (e) { var m = tipTarget(e); if (m) showTip(e, m.getAttribute('data-tip')); else tip.hidden = true; });
  addEventListener('scroll', function () { tip.hidden = true; }, { passive: true });

  // ---------- 標題與摘要 ----------
  function drawHeader() {
    var b = DATA.baby || {}, parts = ['👶 ' + (b.name || '寶寶')];
    if (b.birth) {
      var days = Math.floor((DATA.today - dayOf(b.birth)) / DAY) + 1;
      parts.push('出生第 ' + days + ' 天（' + Math.floor((days - 1) / 30.44) + ' 個月）');
    }
    $('baby-line').textContent = parts.join(' · ');
    var p = tw(DATA.now);
    $('asof').textContent = '更新於 ' + (p.mo + 1) + '/' + p.d + '（' + WD[p.wd] + '）' + hm(DATA.now) + ' · 今日統計到目前為止';
  }

  function drawTiles() {
    var days = DATA.days, today = days[days.length - 1], yday = days[days.length - 2];
    var html = '';
    html += '<div class="tile"><span class="k"><i class="sw" style="background:var(--feed)"></i>今日奶量</span>' +
      '<span class="v">' + today.ml + '<small>ml</small></span><span class="d">' + today.n + ' 餐' + (today.breast ? ' · 親餵 ' + today.breast + ' 分' : '') + ' · 昨天 ' + yday.ml + 'ml</span></div>';
    html += '<div class="tile"><span class="k"><i class="sw" style="background:var(--sleep)"></i>今日睡眠</span>' +
      '<span class="v">' + today.sleepH.toFixed(1) + '<small>小時</small></span><span class="d">' + (DATA.sleeping ? '現在正在睡 😴' : '現在醒著') + ' · 昨天 ' + yday.sleepH.toFixed(1) + 'h</span></div>';
    html += '<div class="tile"><span class="k"><i class="sw" style="background:var(--pee)"></i>尿布</span>' +
      '<span class="v">' + today.pee + '<small>尿</small> ' + today.poo + '<small>便</small></span><span class="d">' +
      (DATA.lastDiaper ? '上次 ' + dayLabel(dayOf(DATA.lastDiaper.t)) + ' ' + hm(DATA.lastDiaper.t) : '還沒有紀錄') + '</span></div>';
    var t = DATA.lastTemp;
    html += '<div class="tile"><span class="k">🌡️ 體溫</span>' + (t
      ? '<span class="v">' + t.v.toFixed(1) + '<small>°C</small></span><span class="d">' + dayLabel(dayOf(t.t)) + ' ' + hm(t.t) + ' · ' + (t.v >= 38 ? '發燒' : t.v >= 37.5 ? '偏高' : '正常') + '</span>'
      : '<span class="v">–</span><span class="d">還沒有紀錄</span>') + '</div>';
    var f = DATA.lastFeed, pr = DATA.prediction;
    html += '<div class="tile wide"><div><span class="k">🔮 預計下一餐</span><span class="v">' + (pr ? '約 ' + hm(pr.at) : '–') + '</span></div>' +
      '<span class="d">' + (f ? '上一餐 ' + dayLabel(dayOf(f.t)) + ' ' + hm(f.t) + ' ' + esc(f.label) : '還沒有餵奶紀錄') +
      (pr && pr.amount ? '<br>建議準備約 ' + pr.amount + 'ml' : pr ? '' : '<br>多記幾餐（約 1～2 天）就會開始預測') + '</span></div>';
    $('tiles').innerHTML = html;
  }

  // ---------- 可能漏記 ----------
  function limitFor(t) { return (isNight(t) ? 6.5 : 4.5) * HOUR; }
  function findGaps() {
    var out = [], from = DATA.today - 6 * DAY, f = DATA.feeds;
    for (var i = 1; i < f.length; i++) {
      if (f[i].t < from) continue;
      if (f[i].t - f[i - 1].t > limitFor(f[i - 1].t)) out.push({ a: f[i - 1].t, b: f[i].t });
    }
    if (f.length) {
      var last = f[f.length - 1].t;
      if (DATA.now - last > limitFor(last)) out.push({ a: last, b: DATA.now, open: true });
    }
    return out;
  }
  function gapMid(g) { return round5(g.a + (g.b - g.a) / 2); }
  function drawGaps() {
    var gs = findGaps(), host = $('gaps');
    $('gaps-panel').hidden = !gs.length;
    host.innerHTML = '';
    gs.forEach(function (g) {
      var row = document.createElement('div'); row.className = 'gap-row';
      row.innerHTML = '<span><b>' + dayLabel(dayOf(g.a)) + ' ' + hm(g.a) + '–' + (g.open ? '現在' : hm(g.b)) + '</b> · ' + dur(g.b - g.a) + '沒有餵奶紀錄</span>';
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = '補登';
      b.addEventListener('click', function () { openForm({ at: gapMid(g), kind: 'feed' }); });
      row.appendChild(b); host.appendChild(row);
    });
  }

  // ---------- 24 小時作息圖 ----------
  function drawRhythm() {
    var host = $('rhythm'); host.innerHTML = '';
    var W = host.clientWidth || 340, L = 46, R = 6, T = 4, rowH = 30, rows = 7;
    var H = T + rows * rowH + 18, PW = W - L - R;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': '最近 7 天的 24 小時作息圖' }, host);
    function x(h) { return L + (h / 24) * PW; }
    var gaps = findGaps();
    for (var r = 0; r < rows; r++) (function (r) {
      var d0 = DATA.today - r * DAY, y = T + r * rowH, cy = y + rowH / 2;
      function toH(t) { return (t - d0) / HOUR; }
      el('rect', { x: x(0), y: y + 2, width: x(6) - x(0), height: rowH - 4, fill: 'var(--night)', rx: 3 }, svg);
      el('rect', { x: x(22), y: y + 2, width: x(24) - x(22), height: rowH - 4, fill: 'var(--night)', rx: 3 }, svg);
      el('line', { x1: L, x2: L + PW, y1: cy, y2: cy, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
      text(svg, L - 6, cy + 4, dayLabel(d0), { 'text-anchor': 'end', 'class': 'rowlab' });
      var bg = el('rect', { x: L, y: y, width: PW, height: rowH, fill: 'transparent', style: 'cursor:copy' }, svg);
      bg.addEventListener('click', function (ev) {
        var box = svg.getBoundingClientRect(), h = ((ev.clientX - box.left) * (W / box.width) - L) / PW * 24;
        var at = d0 + Math.round(Math.max(0, Math.min(23.9, h)) * 12) * 5 * MIN;
        openForm({ at: Math.min(at, round5(DATA.now)) });
      });
      gaps.forEach(function (g) {
        var a = Math.max(g.a, d0), b = Math.min(g.b, d0 + DAY);
        if (b <= a) return;
        var gr = el('rect', { x: x(toH(a)) + 6, y: y + 3, width: Math.max(4, x(toH(b)) - x(toH(a)) - 12), height: rowH - 6, rx: 4,
          fill: 'var(--warn-bg)', stroke: 'var(--warn)', 'stroke-dasharray': '3 2', style: 'cursor:copy',
          'data-tip': '⚠️ ' + hm(g.a) + '–' + (g.open ? '現在' : hm(g.b)) + ' 沒有餵奶紀錄（' + dur(g.b - g.a) + '）\n點一下補登' }, svg);
        gr.addEventListener('click', function () { openForm({ at: gapMid(g), kind: 'feed' }); });
      });
      DATA.sleeps.forEach(function (s) {
        var a = Math.max(s.s, d0), b = Math.min(s.e, d0 + DAY);
        if (b <= a) return;
        el('rect', { x: x(toH(a)), y: cy - 6, width: Math.max(1.5, x(toH(b)) - x(toH(a)) - 1), height: 12, rx: 3, fill: 'var(--sleep)',
          stroke: s.web ? 'var(--ink)' : 'none', 'stroke-width': 1.5 }, svg);
        el('rect', { x: x(toH(a)), y: y, width: Math.max(6, x(toH(b)) - x(toH(a))), height: rowH, fill: 'transparent',
          'data-tip': '😴 睡眠 ' + hm(s.s) + '–' + (s.ongoing ? '現在' : hm(s.e)) + '\n共 ' + dur(s.e - s.s) + (s.ongoing ? '（還在睡）' : '') + (s.web ? '（網頁補登）' : '') }, svg);
      });
      DATA.diapers.forEach(function (dz) {
        if (dz.t < d0 || dz.t >= d0 + DAY) return;
        var px = x(toH(dz.t));
        if (dz.kind === 'pee') el('rect', { x: px - 1.5, y: y + 1, width: 3, height: 7, rx: 1, fill: 'var(--pee)' }, svg);
        else el('rect', { x: px - 4, y: y + rowH - 6, width: 8, height: 4, rx: 1, fill: 'var(--poo)' }, svg);
        el('circle', { cx: px, cy: dz.kind === 'pee' ? y + 4 : y + rowH - 4, r: 8, fill: 'transparent', 'data-tip': (dz.kind === 'pee' ? '💧 尿布 尿 ' : '💩 尿布 便 ') + hm(dz.t) }, svg);
      });
      DATA.feeds.forEach(function (f, i) {
        if (f.t < d0 || f.t >= d0 + DAY) return;
        var px = x(toH(f.t)), prev = DATA.feeds[i - 1];
        el('circle', { cx: px, cy: cy, r: f.web ? 5.5 : 4.5, fill: 'var(--feed)', stroke: f.web ? 'var(--ink)' : 'var(--surface)', 'stroke-width': 2 }, svg);
        el('circle', { cx: px, cy: cy, r: 11, fill: 'transparent',
          'data-tip': '🍼 ' + hm(f.t) + ' ' + f.label + (f.web ? '（網頁補登）' : '') + (prev ? '\n距離上一餐 ' + dur(f.t - prev.t) : '') }, svg);
      });
    })(r);
    [0, 6, 12, 18, 24].forEach(function (h) {
      el('line', { x1: x(h), x2: x(h), y1: T, y2: T + rows * rowH, stroke: 'var(--grid)', 'stroke-width': 1, 'stroke-dasharray': h % 24 ? '2 3' : '' }, svg);
      text(svg, x(h), H - 4, h === 24 ? '24' : pad(h) + ':00', { 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle' });
    });
    var nx = x((DATA.now - DATA.today) / HOUR);
    el('line', { x1: nx, x2: nx, y1: T, y2: T + rowH, stroke: 'var(--ink)', 'stroke-width': 1.5 }, svg);
    text(svg, nx + 3 > L + PW - 24 ? nx - 3 : nx + 3, T + 9, '現在', { 'class': 'vlab', 'text-anchor': nx + 3 > L + PW - 24 ? 'end' : 'start' });
  }

  // ---------- 每日趨勢 ----------
  var range = 14;
  function frame(id, H) {
    var host = $(id); host.innerHTML = '';
    var W = host.clientWidth || 340;
    return { W: W, H: H, L: 34, T: 10, PH: H - 28, PW: W - 34 - 6, svg: el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' }, host) };
  }
  function gridY(f, ticks, y, fmt) {
    ticks.forEach(function (v, i) {
      el('line', { x1: f.L, x2: f.L + f.PW, y1: y(v), y2: y(v), stroke: i ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, f.svg);
      text(f.svg, f.L - 5, y(v) + 3, fmt(v), { 'text-anchor': 'end' });
    });
  }
  function labelsX(f, list, bw) {
    var every = list.length > 14 ? 7 : list.length > 7 ? 2 : 1;
    list.forEach(function (d, i) {
      if ((list.length - 1 - i) % every === 0) text(f.svg, f.L + bw * i + bw / 2, f.H - 4, d.d0 === DATA.today ? '今天' : md(d.d0), { 'text-anchor': 'middle' });
    });
  }
  function hit(f, list, bw, tipFor) {
    list.forEach(function (d, i) {
      el('rect', { x: f.L + bw * i, y: f.T, width: bw, height: f.PH, fill: 'transparent', 'data-tip': dayLabel(d.d0) + (d.d0 === DATA.today ? '（到目前）' : '') + '\n' + tipFor(d) }, f.svg);
    });
  }
  function bars(id, list, key, color, step, tipFor) {
    var f = frame(id, 110), max = niceMax(Math.max.apply(null, list.map(function (d) { return d[key]; })), step);
    function y(v) { return f.T + f.PH - (v / max) * f.PH; }
    gridY(f, [0, max / 2, max], y, function (v) { return v; });
    var bw = f.PW / list.length, w = Math.max(2, Math.min(18, bw - 2));
    list.forEach(function (d, i) {
      var cx = f.L + bw * i + bw / 2, h = Math.max(0, y(0) - y(d[key]));
      if (!h) return;
      var top = Math.min(3, h);
      el('path', { d: 'M' + (cx - w / 2) + ',' + y(0) + ' v' + -(h - top) + ' q0,-' + top + ' ' + top + ',-' + top + ' h' + (w - 2 * top) + ' q' + top + ',0 ' + top + ',' + top + ' v' + (h - top) + ' z',
        fill: color, opacity: d.d0 === DATA.today ? 0.45 : 1 }, f.svg);
    });
    hit(f, list, bw, tipFor); labelsX(f, list, bw);
  }
  function stacked(id, list) {
    var f = frame(id, 100), max = niceMax(Math.max.apply(null, list.map(function (d) { return d.pee + d.poo; })), 4);
    function y(v) { return f.T + f.PH - (v / max) * f.PH; }
    gridY(f, [0, max / 2, max], y, function (v) { return v; });
    var bw = f.PW / list.length, w = Math.max(2, Math.min(18, bw - 2));
    list.forEach(function (d, i) {
      var cx = f.L + bw * i + bw / 2, op = d.d0 === DATA.today ? 0.45 : 1;
      if (d.pee) el('rect', { x: cx - w / 2, y: y(d.pee), width: w, height: y(0) - y(d.pee), fill: 'var(--pee)', opacity: op }, f.svg);
      if (d.poo) el('rect', { x: cx - w / 2, y: y(d.pee + d.poo), width: w, height: Math.max(1, y(d.pee) - y(d.pee + d.poo) - (d.pee ? 2 : 0)), rx: 2, fill: 'var(--poo)', opacity: op }, f.svg);
    });
    hit(f, list, bw, function (d) { return '尿 ' + d.pee + ' 次 · 便 ' + d.poo + ' 次'; }); labelsX(f, list, bw);
  }
  function gapLine(id, list) {
    var f = frame(id, 100), bw = f.PW / list.length;
    var vals = list.filter(function (d) { return d.gapH != null; }).map(function (d) { return d.gapH; });
    if (!vals.length) { f.svg.remove(); $(id).innerHTML = '<div class="empty">一天有兩餐以上的紀錄，才算得出間隔。</div>'; return; }
    var lo = Math.max(0, Math.floor(Math.min.apply(null, vals) * 2) / 2 - 0.5), hi = Math.ceil(Math.max.apply(null, vals) * 2) / 2 + 0.5;
    function y(v) { return f.T + f.PH - ((v - lo) / (hi - lo)) * f.PH; }
    gridY(f, [lo, (lo + hi) / 2, hi], y, function (v) { return v.toFixed(1); });
    var pts = [];
    list.forEach(function (d, i) { if (d.gapH != null) pts.push([f.L + bw * i + bw / 2, y(d.gapH), d]); });
    el('path', { d: 'M' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L'), fill: 'none', stroke: 'var(--feed)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, f.svg);
    var last = pts[pts.length - 1];
    el('circle', { cx: last[0], cy: last[1], r: 4, fill: 'var(--feed)', stroke: 'var(--surface)', 'stroke-width': 2 }, f.svg);
    hit(f, list, bw, function (d) { return d.gapH == null ? '紀錄不足' : '平均間隔 ' + dur(d.gapH * HOUR) + '（' + d.n + ' 餐）'; }); labelsX(f, list, bw);
  }
  function avg(list, k) { return list.length ? list.reduce(function (a, d) { return a + d[k]; }, 0) / list.length : 0; }
  function drawTrends() {
    var list = DATA.days.slice(-range);
    var full = list.filter(function (d) { return d.d0 !== DATA.today && (d.n || d.sleepH || d.pee || d.poo); });
    bars('c-ml', list, 'ml', 'var(--feed)', 200, function (d) { return '奶量 ' + d.ml + 'ml（' + d.n + ' 餐）'; });
    bars('c-sleep', list, 'sleepH', 'var(--sleep)', 4, function (d) { return '睡眠 ' + dur(d.sleepH * HOUR); });
    gapLine('c-gap', list);
    stacked('c-diaper', list);
    if (full.length) {
      var half = Math.floor(full.length / 2), delta = Math.round(avg(full.slice(half), 'ml') - avg(full.slice(0, half), 'ml'));
      $('t-ml').innerHTML = '平均 ' + Math.round(avg(full, 'ml')) + 'ml/天' + (half ? ' <span style="color:' + (delta >= 0 ? 'var(--good)' : 'var(--ink-2)') + ';font-weight:500">' + (delta >= 0 ? '▲' : '▼') + ' ' + Math.abs(delta) + '</span>' : '');
      $('t-sleep').textContent = '平均 ' + avg(full, 'sleepH').toFixed(1) + ' 小時/天';
      var gl = full.filter(function (d) { return d.gapH != null; });
      $('t-gap').textContent = gl.length ? '最近 ' + dur(gl[gl.length - 1].gapH * HOUR) : '';
      $('t-diaper').textContent = '平均尿 ' + avg(full, 'pee').toFixed(1) + ' · 便 ' + avg(full, 'poo').toFixed(1);
    } else {
      ['t-ml', 't-sleep', 't-gap', 't-diaper'].forEach(function (id) { $(id).textContent = ''; });
    }
    $('tbl').innerHTML = '<thead><tr><th>日期</th><th>奶量</th><th>餐數</th><th>睡眠</th><th>間隔</th><th>尿</th><th>便</th></tr></thead><tbody>' +
      list.slice().reverse().map(function (d) {
        return '<tr><td>' + dayLabel(d.d0) + '</td><td>' + d.ml + 'ml</td><td>' + d.n + '</td><td>' + d.sleepH.toFixed(1) + 'h</td><td>' +
          (d.gapH != null ? d.gapH.toFixed(1) + 'h' : '–') + '</td><td>' + d.pee + '</td><td>' + d.poo + '</td></tr>';
      }).join('') + '</tbody>';
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-days]'), function (c) {
    c.addEventListener('click', function () {
      range = Number(c.getAttribute('data-days'));
      Array.prototype.forEach.call(document.querySelectorAll('[data-days]'), function (o) { o.setAttribute('aria-pressed', String(o === c)); });
      drawTrends();
    });
  });

  // ---------- 成長曲線 ----------
  var growthWhat = '體重';
  function drawGrowth() {
    var host = $('growth'); host.innerHTML = '';
    var b = DATA.baby || {}, pts = DATA.growth.filter(function (g) { return g.what === growthWhat; });
    var unit = growthWhat === '體重' ? 'kg' : 'cm';
    var who = growthWhat === '體重' && b.birth && WHO[b.sex] ? WHO[b.sex] : null;
    var legend = '<span><i class="sw" style="background:var(--sleep)"></i>' + esc(b.name || '寶寶') + '</span>';
    if (who) legend += '<span><i class="sw" style="background:var(--band);border:1px solid var(--axis)"></i>WHO 第 3–97 百分位</span>' +
      '<span><svg width="16" height="10" style="width:16px"><line x1="0" y1="5" x2="16" y2="5" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="3 2"/></svg>中位數</span>';
    $('growth-legend').innerHTML = legend;
    if (!pts.length) {
      host.innerHTML = '<div class="empty">還沒有' + growthWhat + '紀錄。在 LINE 輸入「' + growthWhat + ' ' + (growthWhat === '體重' ? '6.2' : growthWhat === '身高' ? '62' : '40') + '」就會出現在這裡。</div>';
      $('growth-note').textContent = growthWhat === '體重' && !who ? '在 LINE 輸入「設定 生日 2026/8/5」和「設定 性別 男」（或 女），就會對照 WHO 標準。' : '';
      return;
    }
    var W = host.clientWidth || 340, L = 34, R = 10, T = 10, H = 200, B = 20, PH = H - T - B, PW = W - L - R;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': growthWhat + '成長曲線' }, host);
    var X0, X1, xOf, xLabel;
    var MONTH = 30.4375 * DAY;
    if (b.birth) {
      var ageMax = (Math.max(DATA.now, pts[pts.length - 1].t) - b.birth) / MONTH;
      X0 = 0; X1 = Math.min(who ? 12 : 24, Math.max(3, Math.ceil(ageMax + 0.5)));
      xOf = function (t) { return (t - b.birth) / MONTH; };
      xLabel = function (m) { return m === 0 ? '出生' : m + '月'; };
    } else {
      X0 = dayOf(pts[0].t); X1 = Math.max(X0 + 7 * DAY, dayOf(pts[pts.length - 1].t) + DAY);
      xOf = function (t) { return t; };
      xLabel = function (t) { return md(t); };
    }
    var vals = pts.map(function (p) { return p.v; });
    if (who) who.forEach(function (r) { if (r[0] <= X1) { vals.push(r[1], r[3]); } });
    var step = growthWhat === '體重' ? 1 : 2;
    var lo = Math.floor(Math.min.apply(null, vals) / step) * step - step, hi = Math.ceil(Math.max.apply(null, vals) / step) * step + step;
    lo = Math.max(0, lo);
    function x(v) { return L + ((v - X0) / (X1 - X0)) * PW; }
    function y(v) { return T + PH - ((v - lo) / (hi - lo)) * PH; }
    var yStep = Math.max(step, Math.ceil((hi - lo) / 5 / step) * step);
    for (var v = lo; v <= hi + 1e-9; v += yStep) {
      el('line', { x1: L, x2: L + PW, y1: y(v), y2: y(v), stroke: v === lo ? 'var(--axis)' : 'var(--grid)' }, svg);
      text(svg, L - 5, y(v) + 3, v, { 'text-anchor': 'end' });
    }
    if (b.birth) {
      var every = X1 > 12 ? 3 : X1 > 6 ? 2 : 1;
      for (var m = 0; m <= X1; m += every) text(svg, x(m), H - 5, xLabel(m), { 'text-anchor': m === 0 ? 'start' : m >= X1 ? 'end' : 'middle' });
    } else {
      var n = 4;
      for (var i = 0; i <= n; i++) { var t = X0 + (X1 - X0) * i / n; text(svg, x(t), H - 5, xLabel(t), { 'text-anchor': i === 0 ? 'start' : i === n ? 'end' : 'middle' }); }
    }
    if (who) {
      var rows = who.filter(function (r) { return r[0] <= X1; });
      el('path', { d: 'M' + rows.map(function (r) { return x(r[0]) + ',' + y(r[3]); }).join(' L') + ' L' + rows.slice().reverse().map(function (r) { return x(r[0]) + ',' + y(r[1]); }).join(' L') + 'Z', fill: 'var(--band)' }, svg);
      el('path', { d: 'M' + rows.map(function (r) { return x(r[0]) + ',' + y(r[2]); }).join(' L'), fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg);
      var lr = rows[rows.length - 1];
      text(svg, x(lr[0]) - 2, y(lr[3]) - 4, 'P97', { 'text-anchor': 'end' });
      text(svg, x(lr[0]) - 2, y(lr[2]) - 4, 'P50', { 'text-anchor': 'end' });
      text(svg, x(lr[0]) - 2, y(lr[1]) + 12, 'P3', { 'text-anchor': 'end' });
    }
    if (pts.length > 1) el('path', { d: 'M' + pts.map(function (p) { return x(xOf(p.t)) + ',' + y(p.v); }).join(' L'), fill: 'none', stroke: 'var(--sleep)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
    pts.forEach(function (p, i) {
      var last = i === pts.length - 1;
      el('circle', { cx: x(xOf(p.t)), cy: y(p.v), r: last ? 5 : 4, fill: 'var(--sleep)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
      el('circle', { cx: x(xOf(p.t)), cy: y(p.v), r: 12, fill: 'transparent', 'data-tip': md(p.t) + ' ' + growthWhat + ' ' + p.v + p.unit }, svg);
    });
    var lp = pts[pts.length - 1], lx = x(xOf(lp.t));
    text(svg, lx > L + PW - 50 ? lx - 8 : lx + 8, y(lp.v) - 8, lp.v + unit, { 'class': 'vlab', 'text-anchor': lx > L + PW - 50 ? 'end' : 'start' });

    var note = '最近一次 ' + md(lp.t) + ' ' + lp.v + unit + '。';
    if (who) {
      var age = xOf(lp.t), k = Math.min(11, Math.floor(age)), fr = age - k;
      if (age <= 12) {
        var a = who[k], c = who[k + 1];
        var p3 = a[1] + (c[1] - a[1]) * fr, p50 = a[2] + (c[2] - a[2]) * fr, p97 = a[3] + (c[3] - a[3]) * fr;
        note += lp.v < p3 ? '低於 WHO 第 3 百分位，建議請醫師評估。' : lp.v > p97 ? '高於 WHO 第 97 百分位，建議請醫師評估。' :
          '在 WHO 第 3–97 百分位之間（' + (lp.v >= p50 ? '中位數以上' : '中位數以下') + '）。';
      }
    } else if (growthWhat === '體重') {
      note += '在 LINE 輸入「設定 生日 2026/8/5」和「設定 性別 男」（或 女），就會對照 WHO 標準。';
    }
    $('growth-note').textContent = note;
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-what]'), function (c) {
    c.addEventListener('click', function () {
      growthWhat = c.getAttribute('data-what');
      Array.prototype.forEach.call(document.querySelectorAll('[data-what]'), function (o) { o.setAttribute('aria-pressed', String(o === c)); });
      drawGrowth();
    });
  });

  // ---------- 補登表單 ----------
  var overlay = $('overlay'), form = $('add-form'), kind = 'feed', diaperV = 'pee', lastFocus = null, saving = false;
  function fillDates() {
    var sel = $('f-date'); sel.innerHTML = '';
    for (var i = 0; i < 7; i++) {
      var d0 = DATA.today - i * DAY, o = document.createElement('option');
      o.value = String(d0); o.textContent = dayLabel(d0) + (i < 2 ? '（' + md(d0) + '）' : '');
      sel.appendChild(o);
    }
  }
  function lastMl() {
    for (var i = DATA.feeds.length - 1; i >= 0; i--) { var m = DATA.feeds[i].label.match(/(\d+)ml/); if (m) return Number(m[1]); }
    return 120;
  }
  function lastKg() { var w = DATA.growth.filter(function (g) { return g.what === '體重'; }); return w.length ? w[w.length - 1].v : ''; }
  function setKind(k) {
    kind = k;
    Array.prototype.forEach.call(document.querySelectorAll('#kind-seg button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-kind') === k)); });
    Array.prototype.forEach.call(form.querySelectorAll('[data-for]'), function (f) { f.hidden = f.getAttribute('data-for') !== k; });
    $('f-time-lab').textContent = k === 'sleep' ? '入睡時間' : '時間';
    update();
  }
  function setDiaper(v) {
    diaperV = v;
    Array.prototype.forEach.call(document.querySelectorAll('#diaper-seg button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); });
    update();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#kind-seg button'), function (b) { b.addEventListener('click', function () { setKind(b.getAttribute('data-kind')); }); });
  Array.prototype.forEach.call(document.querySelectorAll('#diaper-seg button'), function (b) { b.addEventListener('click', function () { setDiaper(b.getAttribute('data-v')); }); });
  $('f-feedtype').addEventListener('change', function () {
    var t = $('f-feedtype').value;
    $('f-ml-lab').textContent = t === '母乳' ? '時間 (分鐘)' : t === '副食品' ? '份量 (g)' : '奶量 (ml)';
    $('f-ml').value = t === '母乳' ? 15 : t === '副食品' ? 30 : lastMl();
    update();
  });
  form.addEventListener('input', update);

  function payload() {
    return { kind: kind, day: Number($('f-date').value), time: $('f-time').value, end: $('f-end').value, feedType: $('f-feedtype').value,
      amount: $('f-ml').value, diaper: diaperV, temp: $('f-temp').value, kg: $('f-kg').value };
  }
  function describeForm(p) {
    if (!p.time) return '';
    var when = md(p.day) + ' ' + p.time;
    if (kind === 'feed') {
      var unit = p.feedType === '母乳' ? '分鐘' : p.feedType === '副食品' ? 'g' : 'ml';
      return p.amount ? when + ' ' + (p.feedType === '母乳' ? '親餵' : p.feedType) + ' ' + p.amount + unit : '';
    }
    if (kind === 'sleep') return p.end ? md(p.day) + ' ' + p.time + '–' + p.end + ' 睡眠' + (p.end <= p.time ? '（跨夜）' : '') : '';
    if (kind === 'diaper') return when + ' 尿布 ' + { pee: '尿', poo: '便', both: '尿＋便' }[p.diaper];
    if (kind === 'temp') return p.temp ? when + ' 體溫 ' + p.temp + '°C' : '';
    return p.kg ? when + ' 體重 ' + p.kg + 'kg' : '';
  }
  function update() {
    var line = describeForm(payload());
    $('f-preview').textContent = line ? (MODE ? '將記錄：' : '將補登：') + line : '';
    $('f-preview').hidden = !line;
    $('f-err').textContent = '';
  }
  function openForm(o) {
    o = o || {};
    lastFocus = document.activeElement; tip.hidden = true;
    var at = o.at || round5(DATA.now);
    fillDates();
    $('f-date').value = String(dayOf(at));
    if (!$('f-date').value) $('f-date').selectedIndex = 0;
    $('f-time').value = hm(at);
    $('f-end').value = hm(Math.min(at + HOUR, round5(DATA.now)));
    $('f-ml').value = lastMl();
    $('f-kg').value = lastKg();
    overlay.hidden = false;
    setKind(o.kind || kind);
    if (!MODE) $('f-time').focus(); // 從按鈕打開時不要直接跳出鍵盤
  }
  function closeForm() {
    if (MODE) { closeWindow(); return; }
    overlay.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // ---------- LIFF（從聊天室下方滑出的視窗） ----------
  var liffReady = false;
  function closeWindow() {
    if (liffReady) { try { liff.closeWindow(); return; } catch (e) {} }
    try { window.top.close(); } catch (e) {}
    $('done-msg').textContent = ($('done-msg').textContent ? $('done-msg').textContent + '\n\n' : '') + '往下滑或點左上角的 ✕ 就能關閉這個視窗。';
  }
  if (LIFF_ID) {
    var sdk = document.createElement('script');
    sdk.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
    sdk.onload = function () {
      try { liff.init({ liffId: LIFF_ID }).then(function () { liffReady = true; }).catch(function () {}); } catch (e) {}
    };
    document.head.appendChild(sdk);
  }
  // 跟在 LINE 打字一樣的指令；今天的話省略日期，剛剛的話連時間也省略
  function commandText(p) {
    var today = p.day === DATA.today, nowHm = hm(DATA.now);
    var near = today && Math.abs((Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3))) - (Number(nowHm.slice(0, 2)) * 60 + Number(nowHm.slice(3)))) <= 5;
    var date = today ? '' : md(p.day) + ' ';
    var when = date + (near ? '' : p.time + ' ');
    if (kind === 'feed') return when + p.feedType + ' ' + p.amount;
    if (kind === 'sleep') return date + '睡 ' + p.time + '-' + p.end;
    if (kind === 'diaper') return when + '尿布 ' + { pee: '尿', poo: '便', both: '尿+便' }[p.diaper];
    if (kind === 'temp') return when + '體溫 ' + p.temp;
    return when + '體重 ' + p.kg;
  }
  function chatContext() {
    if (!liffReady) return null;
    try { var c = liff.getContext(); return c && (c.type === 'utou' || c.type === 'group' || c.type === 'room') ? c : null; } catch (e) { return null; }
  }
  function showDone(message) {
    form.classList.add('is-done');
    $('done').hidden = false;
    $('done-msg').textContent = message;
    $('done-close').focus();
  }
  $('done-again').addEventListener('click', function () {
    form.classList.remove('is-done'); $('done').hidden = true;
    openForm({ kind: kind });
  });
  $('done-report').addEventListener('click', function () {
    MODE = null; document.body.classList.remove('form-mode');
    form.classList.remove('is-done'); $('done').hidden = true; overlay.hidden = true;
    drawAll(); scrollTo(0, 0);
  });
  $('done-close').addEventListener('click', closeWindow);
  $('add-btn').addEventListener('click', function () { openForm(); });
  $('add-close').addEventListener('click', closeForm);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeForm(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) closeForm(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (saving) return;
    var p = payload();
    if (!describeForm(p)) { $('f-err').textContent = '請把時間和數值填完整'; return; }
    var label = MODE ? '記錄' : '補登';
    saving = true; $('f-submit').disabled = true; $('f-submit').textContent = '儲存中…';
    function done() { saving = false; $('f-submit').disabled = false; $('f-submit').textContent = label; }
    function saveDirectly() {
      if (typeof google === 'undefined' || !google.script || !google.script.run) { done(); $('f-err').textContent = '請從 LINE 裡的連結打開這個頁面，才能記錄。'; return; }
      google.script.run
        .withSuccessHandler(function (res) {
          done();
          if (!res || !res.ok) { $('f-err').textContent = (res && res.message) || label + '失敗，請再試一次。'; return; }
          DATA = res.data;
          if (MODE) { showDone(res.message); return; }
          closeForm();
          drawAll();
          toast(res.message);
        })
        .withFailureHandler(function (err) { done(); $('f-err').textContent = label + '失敗：' + (err && err.message ? err.message : err); })
        .webAddRecord(KEY, p);
    }
    // 在 LINE 裡打開時，直接以你的名義把指令傳到聊天室，bot 會照常回覆；不行的話改成直接寫進試算表
    if (MODE && chatContext()) {
      liff.sendMessages([{ type: 'text', text: commandText(p) }])
        .then(function () { done(); liff.closeWindow(); })
        .catch(saveDirectly);
      return;
    }
    saveDirectly();
  });
  var tt;
  function toast(s) { var t = $('toast'); t.textContent = s; t.hidden = false; clearTimeout(tt); tt = setTimeout(function () { t.hidden = true; }, 3500); }

  function drawAll() { drawHeader(); drawTiles(); drawGaps(); drawRhythm(); drawTrends(); drawGrowth(); }
  if (MODE) {
    document.body.classList.add('form-mode');
    $('add-h').textContent = { feed: '🍼 記錄餵奶', diaper: '🧷 記錄尿布' }[MODE] || '＋ 記錄';
    $('f-submit').textContent = '記錄';
    $('f-note').textContent = '補錯了可以在 LINE 輸入「復原」刪掉。';
    openForm({ kind: MODE });
  } else {
    drawAll();
  }
  var rt; addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (!MODE) drawAll(); }, 120); });
})();
</script>
</body>
</html>
`;
