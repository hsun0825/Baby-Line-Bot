"""LINE webhook 入口。

啟動：gunicorn app:app
LINE Developers Console 的 Webhook URL 設成 https://<你的網域>/callback
"""

from __future__ import annotations

import logging
import os
from zoneinfo import ZoneInfo

from flask import Flask, abort, request
from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    ApiClient,
    Configuration,
    MessageAction,
    MessagingApi,
    QuickReply,
    QuickReplyItem,
    ReplyMessageRequest,
    TextMessage,
)
from linebot.v3.webhooks import FollowEvent, JoinEvent, MessageEvent, TextMessageContent

from babybot.service import HELP_TEXT, BabyService
from babybot.storage import Storage

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("babybot")

CHANNEL_SECRET = os.environ.get("LINE_CHANNEL_SECRET", "")
CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
TZ = ZoneInfo(os.environ.get("TZ_NAME", "Asia/Taipei"))

if not CHANNEL_SECRET or not CHANNEL_ACCESS_TOKEN:
    log.warning("尚未設定 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN")

app = Flask(__name__)
handler = WebhookHandler(CHANNEL_SECRET)
configuration = Configuration(access_token=CHANNEL_ACCESS_TOKEN)
service = BabyService(Storage(os.environ.get("DATABASE_PATH", "baby.db"), TZ), TZ)

# 每則回覆下方的快速按鈕
QUICK_ACTIONS = [
    ("🍼 喝奶", "喝奶"),
    ("😴 睡覺", "睡覺"),
    ("☀️ 起床", "起床"),
    ("💧 尿", "尿布 尿"),
    ("💩 便", "尿布 便"),
    ("📋 最近", "最近"),
    ("⏱️ 狀態", "狀態"),
    ("📊 今天", "今天"),
    ("↩️ 復原", "復原"),
]


def quick_reply() -> QuickReply:
    return QuickReply(items=[
        QuickReplyItem(action=MessageAction(label=label, text=text)) for label, text in QUICK_ACTIONS
    ])


def chat_id_of(event) -> str:
    """群組／聊天室共用同一份紀錄，讓爸媽一起記；一對一聊天則以使用者為單位。"""
    src = event.source
    return getattr(src, "group_id", None) or getattr(src, "room_id", None) or src.user_id


def reply(reply_token: str, text: str) -> None:
    with ApiClient(configuration) as api_client:
        MessagingApi(api_client).reply_message(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[TextMessage(text=text[:5000], quick_reply=quick_reply())],
            )
        )


@app.get("/")
def health():
    # 給 UptimeRobot 之類的服務定時 ping，避免免費主機休眠
    return "OK"


@app.post("/callback")
def callback():
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        log.warning("簽章驗證失敗，請檢查 LINE_CHANNEL_SECRET")
        abort(400)
    return "OK"


@handler.add(MessageEvent, message=TextMessageContent)
def on_text(event: MessageEvent):
    try:
        text = service.handle(chat_id_of(event), event.message.text, user_id=event.source.user_id)
    except Exception:
        log.exception("處理訊息失敗")
        text = "😵 發生錯誤，請稍後再試一次。"
    if text:
        reply(event.reply_token, text)


@handler.add(FollowEvent)
@handler.add(JoinEvent)
def on_join(event):
    reply(event.reply_token, "嗨！我是寶寶生理時鐘小幫手 👶\n\n" + HELP_TEXT)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
