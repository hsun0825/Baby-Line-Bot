# Baby-Line-Bot

這是一個用來記錄寶寶生理時鐘的 LINE 機器人：可以記錄睡眠、吃奶／副食品、排泄、體溫和備註，也能查每日統計。

把機器人加進「爸爸＋媽媽」的 LINE 群組裡，大家記的都會是同一個寶寶的紀錄；一對一聊天則是各自分開記。

## 怎麼使用

| 類別 | 輸入範例 | 說明 |
|---|---|---|
| 睡眠 | `睡覺` → `起床` | 起床時自動算出睡了多久 |
|  | `睡 13:00-14:30`、`睡 22:00-06:00` | 補登一段睡眠（可以跨夜） |
| 吃 | `喝奶 120`、`配方奶 150ml` | 沒寫單位的話預設是 ml |
|  | `母乳 左 15` | 親餵，數字代表分鐘 |
|  | `副食品 30g 南瓜粥` |  |
| 排泄 | `尿布 尿`、`尿布 便`、`尿布 尿+便`、`尿尿`、`大便` |  |
| 體溫 | `體溫 37.2`，或直接打 `37.2` | 37.5 以上提醒偏高，38 以上提醒發燒 |
| 備註 | `備註 今天打預防針` |  |
| 補登時間 | `14:30 喝奶 120`、`尿布 便 09:15` | 時間比現在晚的話，會當成昨天 |
| 查詢 | `今天`、`昨天` | 當天統計和明細 |
|  | `最近` | 最近 10 筆 |
|  | `狀態` | 距離上次吃、睡、換尿布過了多久 |
|  | `復原` | 刪除最後一筆 |
|  | `說明` | 顯示使用說明 |

每則回覆下方都有快速按鈕，常用的動作點一下就好。看不懂的訊息機器人不會回應，所以在群組裡聊天不會被打擾。

## 設定 LINE

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立一個 **Messaging API** channel。
2. 取得 **Channel secret**（Basic settings 頁面），並在 Messaging API 頁面發行 **Channel access token**。
3. 在 Messaging API 頁面：
   - Webhook URL 填 `https://<你的網域>/callback`，打開 **Use webhook**
   - 關掉 **Auto-reply messages**
   - 如果要加進群組，打開 **Allow bot to join group chats**

## 本機執行

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env   # 填入 secret 與 token
export $(cat .env | xargs)
python app.py          # 開在 http://localhost:8000
pytest                 # 跑測試（設定 TEST_DATABASE_URL 的話也會測 Postgres）
```

本機開發可以用 `ngrok http 8000` 取得 https 網址填進 Webhook URL。注意：免費版 ngrok 每次重啟網址都會變，要記得回 LINE Console 更新。

## 免費部署（Render + Neon + UptimeRobot）

全部都用免費方案：

| 服務 | 用途 | 免費額度 |
|---|---|---|
| [Neon](https://neon.com/) | PostgreSQL 資料庫，存紀錄 | 0.5 GB，一筆紀錄約 100 bytes，存幾十年都夠 |
| [Render](https://render.com/) | 執行 bot | 每月 750 小時，剛好夠一個服務 24 小時開著 |
| [UptimeRobot](https://uptimerobot.com/) | 定時 ping，讓 Render 不要休眠 | 每 5 分鐘檢查一次 |

為什麼資料庫要另外放：Render 免費方案每次重新部署或重啟都會清空磁碟，SQLite 檔案會跟著不見。

### 1. 建立資料庫（Neon）
1. 註冊 Neon，建立一個 Project（Region 選 Singapore 比較近）。
2. 在 Dashboard 按 **Connect**，複製連線字串，長得像 `postgresql://user:password@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`。

### 2. 部署 bot（Render）
1. 用 GitHub 帳號登入 Render，選 **New > Blueprint**，選這個 repo，Render 會照 `render.yaml` 建立服務。
2. 填入三個環境變數：
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `DATABASE_URL`：剛剛複製的 Neon 連線字串
3. 部署完會拿到網址，例如 `https://baby-line-bot.onrender.com`。

### 3. 接上 LINE
到 LINE Developers Console，把 Webhook URL 設成 `https://baby-line-bot.onrender.com/callback`，然後按 **Verify**。

### 4. 防止休眠（UptimeRobot）
Render 免費服務 15 分鐘沒有流量就會休眠，喚醒大約要一分鐘，這段時間傳的訊息可能沒有回應（也就是「斷線」）。

在 UptimeRobot 新增一個 HTTP monitor，網址填 `https://baby-line-bot.onrender.com/`，間隔 5 分鐘。這個路徑不會讀資料庫，所以不會用掉 Neon 的運算額度。

### 環境變數一覽

| 環境變數 | 說明 |
|---|---|
| `LINE_CHANNEL_SECRET` | Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Channel access token |
| `DATABASE_URL` | PostgreSQL 連線字串。沒設定的話改用 SQLite |
| `DATABASE_PATH` | SQLite 檔案路徑，預設 `baby.db`（只在沒有 `DATABASE_URL` 時使用） |
| `TZ_NAME` | 時區，預設 `Asia/Taipei` |

也可以用 `Dockerfile` 部署到自己的主機，這時用 SQLite 加上 `/data` volume 就可以了。

## 專案結構

```
app.py               LINE webhook（Flask）
babybot/parser.py    文字指令解析
babybot/service.py   記錄邏輯與回覆文字
babybot/storage.py   儲存（PostgreSQL 或 SQLite）
tests/               測試
```
