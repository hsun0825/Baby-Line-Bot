// 在 Node 裡用假的試算表跑 Code.gs 的測試：node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- 假的 SpreadsheetApp ----

class FakeRange {
  constructor(sheet, row, col) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
  }
  setNumberFormat() { return this; }
  setValue(v) { this.sheet.rows[this.row - 1][this.col - 1] = v; return this; }
  getValues() { return this.sheet.rows.map((r) => r.slice()); }
}

class FakeSheet {
  constructor() { this.rows = []; }
  appendRow(row) { this.rows.push(row.slice()); }
  setFrozenRows() {}
  getRange(a, b) { return new FakeRange(this, a, b); }
  getDataRange() { return new FakeRange(this); }
  getLastRow() { return this.rows.length; }
  deleteRow(n) { this.rows.splice(n - 1, 1); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { return (this.sheets[name] = new FakeSheet()); }
  setSpreadsheetTimeZone() {}
}

function load(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
  return ctx;
}

const G = load();
const NOW = new Date('2026-10-07T15:00:00+08:00');
const at = (h, m, day = 7) => new Date(`2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
const CHAT = 'C1';

function newService() {
  const ss = new FakeSpreadsheet();
  return { svc: new G.BabyService(new G.SheetStorage(ss)), ss };
}

// ---- 解析 ----

test('解析餵食', () => {
  const cases = [
    ['喝奶 120', 120, 'ml', '喝奶'],
    ['配方奶150ml', 150, 'ml', '配方奶'],
    ['母乳 左 15', 15, '分鐘', '母乳 左'],
    ['副食品 30g 南瓜粥', 30, 'g', '副食品 南瓜粥'],
    ['喝奶', null, null, '喝奶'],
    ['喝奶 １２０', 120, 'ml', '喝奶'],
  ];
  for (const [text, value, unit, detail] of cases) {
    const cmd = G.parseCommand(text, NOW);
    assert.equal(cmd.kind, 'feed', text);
    assert.equal(cmd.value, value, text);
    assert.equal(cmd.unit, unit, text);
    assert.equal(cmd.detail, detail, text);
  }
});

test('解析排泄', () => {
  const cases = [
    ['尿布 尿', '尿'], ['尿布 便', '便'], ['尿布 尿+便', '尿+便'],
    ['尿布 大便 很稀', '便 很稀'], ['尿尿', '尿'], ['大便', '便'],
  ];
  for (const [text, detail] of cases) {
    const cmd = G.parseCommand(text, NOW);
    assert.equal(cmd.kind, 'diaper', text);
    assert.equal(cmd.detail, detail, text);
  }
});

test('解析體溫與備註', () => {
  assert.equal(G.parseCommand('體溫 37.2', NOW).value, 37.2);
  assert.equal(G.parseCommand('37.8', NOW).value, 37.8);
  assert.equal(G.parseCommand('備註 打預防針', NOW).detail, '打預防針');
  assert.throws(() => G.parseCommand('體溫 99', NOW));
});

test('解析時間前綴與後綴', () => {
  assert.equal(G.parseCommand('14:30 喝奶 120', NOW).at.getTime(), at(14, 30).getTime());
  assert.equal(G.parseCommand('尿布 便 09:15', NOW).at.getTime(), at(9, 15).getTime());
  // 比現在晚的時間視為昨天
  assert.equal(G.parseCommand('23:00 睡覺', NOW).at.getTime(), at(23, 0, 6).getTime());
});

test('跨夜睡眠區間', () => {
  const cmd = G.parseCommand('睡 22:00-06:00', NOW);
  assert.equal(cmd.at.getTime(), at(22, 0, 6).getTime());
  assert.equal(cmd.end.getTime(), at(6, 0).getTime());
});

test('不理會一般聊天', () => {
  for (const text of ['吃飽了嗎', '奶瓶洗了嗎', '今天天氣真好', '哈哈', '尿布好貴', '睡覺前要洗澡']) {
    assert.equal(G.parseCommand(text, NOW), null, text);
  }
});

// ---- 記錄邏輯（使用試算表儲存） ----

test('睡覺與起床', () => {
  const { svc } = newService();
  assert.match(svc.handle(CHAT, '睡覺', 'U', at(13, 0)), /開始睡覺/);
  assert.match(svc.handle(CHAT, '狀態', 'U', at(13, 30)), /睡眠中/);
  assert.match(svc.handle(CHAT, '起床', 'U', at(14, 45)), /1小時45分/);
  assert.match(svc.handle(CHAT, '起床', 'U', at(15, 0)), /找不到/);
});

test('重複輸入睡覺', () => {
  const { svc } = newService();
  svc.handle(CHAT, '睡覺', 'U', at(13, 0));
  assert.match(svc.handle(CHAT, '睡覺', 'U', at(13, 10)), /尚未起床/);
});

test('今天統計', () => {
  const { svc } = newService();
  svc.handle(CHAT, '睡 22:00-06:00', 'U', at(8, 0));
  svc.handle(CHAT, '喝奶 120', 'U', at(8, 0));
  svc.handle(CHAT, '11:00 配方奶 150', 'U', at(11, 5));
  svc.handle(CHAT, '母乳 右 10', 'U', at(12, 0));
  svc.handle(CHAT, '尿布 尿+便', 'U', at(9, 0));
  svc.handle(CHAT, '尿布 尿', 'U', at(10, 0));
  svc.handle(CHAT, '體溫 37.6', 'U', at(10, 0));
  svc.handle(CHAT, '備註 打預防針', 'U', at(10, 30));
  const s = svc.handle(CHAT, '今天', 'U', NOW);
  assert.match(s, /餵食 3 次（共 270ml，親餵 10 分鐘）/);
  assert.match(s, /睡眠 6小時（1 段）/); // 只算 00:00 之後
  assert.match(s, /尿布 2 次（尿 2・便 1）/);
  assert.match(s, /最高 37\.6°C/);
  assert.match(s, /打預防針/);
});

test('顯示距離上一餐', () => {
  const { svc } = newService();
  svc.handle(CHAT, '喝奶 120', 'U', at(8, 0));
  assert.match(svc.handle(CHAT, '喝奶 100', 'U', at(11, 0)), /距離上一餐 3小時/);
});

test('復原會刪掉試算表那一列', () => {
  const { svc, ss } = newService();
  svc.handle(CHAT, '喝奶 120', 'U', at(8, 0));
  svc.handle(CHAT, '尿布 尿', 'U', at(8, 5));
  assert.match(svc.handle(CHAT, '復原', 'U', at(8, 6)), /已刪除最後一筆：\n🧷/);
  assert.equal(ss.sheets['紀錄'].rows.length, 2); // 標題 + 喝奶
  svc.handle(CHAT, '復原', 'U', at(8, 7));
  assert.match(svc.handle(CHAT, '復原', 'U', at(8, 8)), /沒有任何紀錄/);
});

test('不同聊天室分開記', () => {
  const { svc } = newService();
  svc.handle('A', '喝奶 120', 'U', at(8, 0));
  assert.match(svc.handle('B', '最近', 'U', at(9, 0)), /還沒有任何紀錄/);
});

test('發燒提醒、格式錯誤、看不懂不回', () => {
  const { svc } = newService();
  assert.match(svc.handle(CHAT, '體溫 38.3', 'U', NOW), /發燒/);
  assert.match(svc.handle(CHAT, '體溫', 'U', NOW), /^⚠️/);
  assert.equal(svc.handle(CHAT, '寶寶好可愛', 'U', NOW), null);
});

test('試算表內容看得懂，且重新讀取後資料一致', () => {
  const { svc, ss } = newService();
  svc.handle(CHAT, '睡覺', 'U1', at(13, 0));
  svc.handle(CHAT, '起床', 'U1', at(14, 0));
  const rows = ss.sheets['紀錄'].rows;
  assert.deepEqual(Array.from(rows[0]), ['編號', '聊天室', '類型', '開始時間', '結束時間', '數值', '單位', '內容', '記錄者', '建立時間']);
  assert.equal(rows[1][2], '睡眠');
  assert.equal(rows[1][4].getTime(), at(14, 0).getTime());
  // 用新的 storage 從試算表重新讀取（模擬下一次 webhook）
  const svc2 = new G.BabyService(new G.SheetStorage(ss));
  assert.match(svc2.handle(CHAT, '最近', 'U', NOW), /睡眠 13:00-14:00（1小時）/);
});

// ---- webhook ----

test('doPost 回覆 LINE 訊息', () => {
  const ss = new FakeSpreadsheet();
  const sent = [];
  const ctx = load({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    ContentService: { createTextOutput: (t) => t },
    UrlFetchApp: {
      fetch: (url, opts) => {
        sent.push({ url, body: JSON.parse(opts.payload), auth: opts.headers.Authorization });
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      },
    },
  });
  const event = (text) => ({
    type: 'message', replyToken: 'r', source: { type: 'group', groupId: 'G1', userId: 'U1' },
    message: { type: 'text', id: '1', text },
  });
  const res = ctx.doPost({ postData: { contents: JSON.stringify({ events: [event('喝奶 90'), event('哈哈')] }) } });
  assert.equal(res, 'OK');
  assert.equal(sent.length, 1); // 「哈哈」不回應
  assert.equal(sent[0].url, 'https://api.line.me/v2/bot/message/reply');
  assert.match(sent[0].body.messages[0].text, /喝奶 90ml/);
  assert.equal(sent[0].body.messages[0].quickReply.items.length, 9);
  assert.equal(ss.sheets['紀錄'].rows[1][1], 'G1');
  // LINE 的 Verify 會送空的 events
  assert.equal(ctx.doPost({ postData: { contents: '{"events":[]}' } }), 'OK');
});
