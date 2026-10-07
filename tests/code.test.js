// 在 Node 裡用假的試算表跑 Code.gs 的測試：node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- 假的 SpreadsheetApp ----

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  setNumberFormat() { return this; }
  setValue(v) { return this.setValues([[v]]); }
  setValues(values) {
    assert.equal(values.length, this.numRows, 'setValues 列數不符');
    values.forEach((r, i) => {
      assert.equal(r.length, this.numCols, 'setValues 欄數不符');
      const target = (this.sheet.rows[this.row - 1 + i] ||= []);
      r.forEach((v, j) => { target[this.col - 1 + j] = v; });
    });
    return this;
  }
  getValues() { return this.sheet.rows.map((r) => r.slice()); }
}

class FakeChartBuilder {
  constructor(sheet) { this.sheet = sheet; this.options = {}; }
  setChartType() { return this; }
  addRange() { return this; }
  setOption(k, v) { this.options[k] = v; return this; }
  setPosition() { return this; }
  build() { return { options: this.options }; }
}

class FakeSheet {
  constructor(name, ss) { this.name = name; this.ss = ss; this.rows = []; this.charts = []; }
  appendRow(row) { this.rows.push(row.slice()); }
  setFrozenRows() {}
  setName(name) {
    delete this.ss.sheets[this.name];
    this.ss.sheets[name] = this;
    this.name = name;
    return this;
  }
  autoResizeColumns() {}
  getRange(a, b, c, d) { return new FakeRange(this, a, b, c, d); }
  getDataRange() { return new FakeRange(this); }
  getLastRow() { return this.rows.length; }
  deleteRow(n) { this.rows.splice(n - 1, 1); }
  clearContents() { this.rows = []; }
  getCharts() { return this.charts; }
  newChart() { return new FakeChartBuilder(this); }
  insertChart(c) { this.charts.push(c); }
}

class FakeSpreadsheet {
  constructor(name) { this.name = name; this.sheets = {}; this.order = []; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const sh = new FakeSheet(name, this);
    this.order.push(sh);
    return (this.sheets[name] = sh);
  }
  getSheets() { return this.order; }
  setSpreadsheetTimeZone() {}
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake'; }
}

const created = [];
const FakeSpreadsheetApp = {
  create(name) {
    const ss = new FakeSpreadsheet(name);
    ss.insertSheet('工作表1');
    created.push(ss);
    return ss;
  },
};

function load(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
  return ctx;
}

const G = load({ SpreadsheetApp: FakeSpreadsheetApp, Charts: { ChartType: { LINE: 'LINE' } } });
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
    ['喝奶 不記量', null, null, '喝奶'],
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
  assert.equal(sent[0].body.messages[0].quickReply.items.length, 11);
  // 只打「餵奶」會用按鈕問種類
  ctx.doPost({ postData: { contents: JSON.stringify({ events: [event('餵奶')] }) } });
  const items = sent[1].body.messages[0].quickReply.items.map((i) => i.action.text);
  assert.deepEqual(items, ['母乳', '瓶餵母乳', '配方奶', '副食品']);
  assert.equal(ss.sheets['紀錄'].rows[1][1], 'G1');
  // LINE 的 Verify 會送空的 events
  assert.equal(ctx.doPost({ postData: { contents: '{"events":[]}' } }), 'OK');
});

// ---- 新功能 ----

test('解析新類型', () => {
  const cases = [
    ['體重 6.2', 'growth', 6.2, 'kg', '體重'],
    ['體重 6200', 'growth', 6.2, 'kg', '體重'],
    ['身高 62.5', 'growth', 62.5, 'cm', '身高'],
    ['頭圍 40', 'growth', 40, 'cm', '頭圍'],
    ['吃藥 退燒藥 2.5ml', 'med', 2.5, 'ml', '退燒藥'],
    ['藥 益生菌 1包', 'med', 1, '包', '益生菌'],
    ['洗澡', 'bath', null, null, ''],
    ['擠奶 120', 'pump', 120, 'ml', ''],
    ['擠奶 左 60 右 50', 'pump', 110, 'ml', '左60 右50'],
    ['疫苗 五合一 第一劑', 'vaccine', null, null, '五合一 第一劑'],
    ['看診 小兒科 感冒', 'clinic', null, null, '小兒科 感冒'],
  ];
  for (const [text, kind, value, unit, detail] of cases) {
    const cmd = G.parseCommand(text, NOW);
    assert.equal(cmd.kind, kind, text);
    assert.equal(cmd.value, value, text);
    assert.equal(cmd.unit, unit, text);
    assert.equal(cmd.detail, detail, text);
  }
  assert.throws(() => G.parseCommand('體重 99', NOW));
  assert.throws(() => G.parseCommand('疫苗', NOW));
  assert.throws(() => G.parseCommand('吃藥', NOW));
});

test('新類型也不理會一般聊天', () => {
  for (const text of ['吃藥了嗎', '藥吃完了嗎', '洗澡了沒', '擠奶好累', '疫苗要自費嗎', '看診要帶健保卡', '體重機壞了']) {
    assert.equal(G.parseCommand(text, NOW), null, text);
  }
});

test('體重變化與成長曲線工作表', () => {
  const { svc, ss } = newService();
  svc.handle(CHAT, '體重 5.9', 'U', at(10, 0, 1));
  svc.handle(CHAT, '身高 60', 'U', at(10, 0, 1));
  const reply = svc.handle(CHAT, '體重 6.2', 'U', at(10, 0));
  assert.match(reply, /⚖️ 10:00 體重 6\.2kg/);
  assert.match(reply, /比上次（10\/01，6 天前）增加 0\.3kg/);
  assert.match(reply, /成長曲線圖已更新/);
  const g = ss.sheets['成長曲線'];
  assert.deepEqual(Array.from(g.rows[0]), ['日期', '體重(kg)', '身高(cm)', '頭圍(cm)']);
  assert.equal(g.rows.length, 3); // 標題 + 10/01 + 10/07
  assert.equal(g.rows[1][1], 5.9);
  assert.equal(g.rows[1][2], 60);
  assert.equal(g.rows[2][1], 6.2);
  assert.equal(g.rows[2][2], '');
  assert.equal(g.charts.length, 3);
  // 再記一次不會重複建立圖表
  svc.handle(CHAT, '頭圍 40', 'U', at(11, 0));
  assert.equal(g.charts.length, 3);
  const hist = svc.handle(CHAT, '成長紀錄', 'U', NOW);
  assert.match(hist, /【體重】\n2026\/10\/01  5\.9kg\n2026\/10\/07  6\.2kg（\+0\.3）/);
  assert.match(hist, /【頭圍】/);
});

test('吃藥次數與間隔', () => {
  const { svc } = newService();
  svc.handle(CHAT, '吃藥 退燒藥 2.5ml', 'U', at(8, 0));
  const r = svc.handle(CHAT, '吃藥 退燒藥 2.5ml', 'U', at(14, 0));
  assert.match(r, /距離上次吃退燒藥 6小時/);
  assert.match(r, /今天第 2 次/);
  assert.match(svc.handle(CHAT, '狀態', 'U', NOW), /💊 上次吃藥：14:00（1小時前） 退燒藥 2\.5ml/);
});

test('擠奶當日總量與每日統計', () => {
  const { svc } = newService();
  svc.handle(CHAT, '擠奶 左 60 右 50', 'U', at(8, 0));
  assert.match(svc.handle(CHAT, '擠奶 90', 'U', at(12, 0)), /今天共擠 200ml/);
  svc.handle(CHAT, '洗澡', 'U', at(19, 0, 6));
  svc.handle(CHAT, '洗澡', 'U', at(13, 0));
  const s = svc.handle(CHAT, '今天', 'U', NOW);
  assert.match(s, /🥛 擠奶 2 次（共 200ml）/);
  assert.match(s, /🛁 洗澡 1 次/);
});

test('疫苗與看診紀錄查詢', () => {
  const { svc } = newService();
  svc.handle(CHAT, '疫苗 B肝 第一劑', 'U', at(9, 0, 1));
  svc.handle(CHAT, '疫苗 五合一 第一劑', 'U', at(9, 0));
  svc.handle(CHAT, '看診 小兒科 感冒', 'U', at(10, 0));
  const v = svc.handle(CHAT, '疫苗紀錄', 'U', NOW);
  assert.match(v, /疫苗紀錄（共 2 筆）/);
  assert.match(v, /— 10\/01 —\n💉 09:00 疫苗 B肝 第一劑/);
  assert.match(svc.handle(CHAT, '看診紀錄', 'U', NOW), /🏥 10:00 看診 小兒科 感冒/);
  assert.match(svc.handle(CHAT, '吃藥紀錄', 'U', NOW), /還沒有吃藥紀錄/);
});

test('修改最後一筆', () => {
  const { svc, ss } = newService();
  svc.handle(CHAT, '喝奶 120', 'U', at(8, 0));
  const r = svc.handle(CHAT, '修改 喝奶 150', 'U', at(8, 5));
  assert.match(r, /修改前：🍼 08:00 喝奶 120ml\n修改後：🍼 08:00 喝奶 150ml/);
  assert.equal(ss.sheets['紀錄'].rows[1][5], 150);
  // 只改時間
  assert.match(svc.handle(CHAT, '修改 07:40', 'U', at(8, 6)), /修改後：🍼 07:40 喝奶 150ml/);
  // 改成別的類型
  assert.match(svc.handle(CHAT, '修改 母乳 左 15', 'U', at(8, 7)), /修改後：🍼 07:40 母乳 左 15分鐘/);
  assert.equal(ss.sheets['紀錄'].rows[1][2], '餵食');
  // 睡眠只改時間時，結束時間跟著移動
  svc.handle(CHAT, '睡 13:00-14:00', 'U', at(14, 30));
  assert.match(svc.handle(CHAT, '修改 12:30', 'U', at(14, 31)), /睡眠 12:30-13:30（1小時）/);
  assert.match(svc.handle(CHAT, '修改 哈哈', 'U', NOW), /^⚠️/);
  // 新的 storage 重新讀取，確認有寫回試算表
  const svc2 = new G.BabyService(new G.SheetStorage(ss));
  assert.match(svc2.handle(CHAT, '最近', 'U', NOW), /07:40 母乳 左 15分鐘[\s\S]*睡眠 12:30-13:30/);
});

test('匯出成新的試算表', () => {
  const { svc } = newService();
  created.length = 0;
  svc.handle(CHAT, '喝奶 120', 'U', at(8, 0, 6));
  svc.handle(CHAT, '尿布 尿+便', 'U', at(9, 0));
  svc.handle(CHAT, '睡 10:00-12:00', 'U', at(12, 0));
  const r = svc.handle(CHAT, '匯出 3', 'U', NOW);
  assert.match(r, /已匯出最近 3 天（3 筆紀錄）\nhttps:\/\/docs\.google\.com/);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, '寶寶紀錄 2026/10/05-2026/10/07');
  const daily = created[0].sheets['每日統計'].rows;
  assert.equal(daily.length, 4);
  assert.deepEqual(Array.from(daily[2]).slice(0, 3), ['2026/10/06', 1, 120]);
  assert.deepEqual(Array.from(daily[3]).slice(0, 8), ['2026/10/07', 0, 0, 0, 2, 1, 1, 1]);
  const detail = created[0].sheets['明細'].rows;
  assert.deepEqual(Array.from(detail[3]), ['2026/10/07', '10:00', '睡眠', '', '', '', '12:00']);
  assert.match(svc.handle(CHAT, '匯出 999', 'U', NOW), /^⚠️/);
});

test('預測下一餐時間與奶量', () => {
  const { svc } = newService();
  // 前兩天每 3 小時喝一次，奶量 120～140
  const start = at(6, 0, 5).getTime();
  let reply;
  for (let i = 0; i < 16; i++) {
    const t = new Date(start + i * 3 * 3600000);
    reply = svc.handle(CHAT, '喝奶 ' + (120 + (i % 3) * 10), 'U', t);
    if (i === 2) assert.match(reply, /再多記錄幾餐/);
  }
  // 最後一餐是 10/07 03:00，夜間；夜間間隔也都是 3 小時
  assert.match(reply, /🔮 預計下一餐：約 06:00/);
  assert.match(reply, /建議準備：約 130ml/);
  const status = svc.handle(CHAT, '狀態', 'U', at(5, 0));
  assert.match(status, /🔮 預計下一餐：約 06:00（還有 1小時），約 130ml/);
});

test('預測會分開白天和夜間的間隔', () => {
  const { svc } = newService();
  // 白天每 2.5 小時，夜間（22:00～06:00）每 4 小時
  const times = [[2, 0], [6, 0], [8, 30], [11, 0], [13, 30], [16, 0], [18, 30], [22, 0]];
  let reply;
  for (let d = 4; d <= 6; d++) for (const [h, m] of times) reply = svc.handle(CHAT, '喝奶 120', 'U', at(h, m, d));
  assert.match(reply, /預計下一餐：約 02:00/); // 22:00 是夜間，用 4 小時
  reply = svc.handle(CHAT, '喝奶 120', 'U', at(2, 0, 7));
  assert.match(reply, /預計下一餐：約 06:00/);
  reply = svc.handle(CHAT, '喝奶 120', 'U', at(6, 0, 7));
  assert.match(reply, /預計下一餐：約 08:30/); // 06:00 是白天，用 2.5 小時
});

test('用按鈕選擇餵奶種類與份量', () => {
  const { svc, ss } = newService();
  // 第一步：選種類
  const step1 = svc.handle(CHAT, '餵奶', 'U', at(8, 0));
  assert.match(step1.text, /要記錄哪一種/);
  assert.deepEqual(Array.from(step1.quick, (q) => q[0]), ['🤱 親餵', '🍼 瓶餵母乳', '🥛 配方奶', '🥣 副食品']);
  assert.equal(ss.sheets['紀錄'].rows.length, 1); // 還沒記錄任何東西

  // 第二步：沒有紀錄時給預設份量
  const step2 = svc.handle(CHAT, step1.quick[2][1], 'U', at(8, 0));
  assert.match(step2.text, /配方奶喝了多少/);
  assert.deepEqual(Array.from(step2.quick, (q) => q[1]),
    ['配方奶 60', '配方奶 90', '配方奶 120', '配方奶 150', '配方奶 180', '配方奶 210', '配方奶 240', '配方奶 不記量']);

  // 第三步：點份量就記錄
  assert.match(svc.handle(CHAT, '配方奶 120', 'U', at(8, 0)), /🍼 08:00 配方奶 120ml/);

  // 下一次以上次的量為中心，並標上 ⭐
  const again = svc.handle(CHAT, '配方奶', 'U', at(11, 0));
  assert.match(again.text, /上次喝 120ml/);
  assert.deepEqual(Array.from(again.quick, (q) => q[0]),
    ['90ml', '100ml', '110ml', '⭐ 120ml', '130ml', '140ml', '150ml', '✔️ 不記量']);
  // 瓶餵母乳的上次量分開算
  assert.doesNotMatch(svc.handle(CHAT, '瓶餵母乳', 'U', at(11, 0)).text, /上次/);

  // 不記量
  assert.match(svc.handle(CHAT, '配方奶 不記量', 'U', at(11, 0)), /🍼 11:00 配方奶$/m);
});

test('親餵用按鈕選邊和時間', () => {
  const { svc } = newService();
  const r = svc.handle(CHAT, '母乳', 'U', at(8, 0));
  assert.match(r.text, /親餵哪一邊、多久/);
  assert.equal(r.quick.length, 9);
  assert.deepEqual(Array.from(r.quick[0]), ['👈 左 10分', '母乳 左 10']);
  assert.match(svc.handle(CHAT, r.quick[0][1], 'U', at(8, 0)), /母乳 左 10分鐘/);
});

test('有指定時間時按鈕會帶著時間', () => {
  const { svc } = newService();
  const r = svc.handle(CHAT, '14:30 餵奶', 'U', NOW);
  assert.equal(r.quick[2][1], '14:30 配方奶');
  const r2 = svc.handle(CHAT, r.quick[2][1], 'U', NOW);
  assert.equal(r2.quick[0][1], '14:30 配方奶 60');
  assert.match(svc.handle(CHAT, r2.quick[0][1], 'U', NOW), /🍼 14:30 配方奶 60ml/);
});
