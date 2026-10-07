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
pytest                 # 跑測試
```

本機開發可以用 `ngrok http 8000` 取得 https 網址填進 Webhook URL。注意：免費版 ngrok 每次重啟網址都會變，要記得回 LINE Console 更新。

## 部署

| 環境變數 | 說明 |
|---|---|
| `LINE_CHANNEL_SECRET` | Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Channel access token |
| `DATABASE_PATH` | SQLite 檔案路徑，預設 `baby.db` |
| `TZ_NAME` | 時區，預設 `Asia/Taipei` |

啟動指令：`gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4`（已寫在 `Procfile`），也可以用 `Dockerfile`。

⚠️ **資料保存**：紀錄存在 SQLite 檔案裡。很多免費主機（例如 Render 免費方案）每次重新部署或重啟都會清空磁碟，紀錄就會不見。請把 `DATABASE_PATH` 指到持久化磁碟（Render Disk、Fly.io Volume、Docker volume `/data` 等），或部署在自己的主機上。

⚠️ **避免「斷線」**：免費主機閒置一段時間會休眠，這時 LINE 傳來的訊息可能沒有回應。可以用 [UptimeRobot](https://uptimerobot.com/) 每 5 分鐘 ping 一次 `https://<你的網域>/`（這個路徑會回傳 `OK`），讓它保持清醒。

## 專案結構

```
app.py               LINE webhook（Flask）
babybot/parser.py    文字指令解析
babybot/service.py   記錄邏輯與回覆文字
babybot/storage.py   SQLite 儲存
tests/               測試
```
