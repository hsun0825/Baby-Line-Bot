"""把解析好的指令變成資料庫操作與回覆文字。不依賴 LINE，方便測試。"""

from __future__ import annotations

from datetime import datetime, timedelta

from . import parser
from .parser import DIAPER, FEED, KIND_LABELS, NOTE, SLEEP, TEMP, Command, ParseError
from .storage import Record, Storage

HELP_TEXT = """👶 寶寶生理時鐘紀錄 使用說明

【睡眠】
睡覺 → 開始睡
起床 → 結束並計算睡了多久
睡 13:00-14:30 → 補登一段睡眠

【吃】
喝奶 120 / 配方奶 150ml
母乳 左 15（分鐘）
副食品 30g 南瓜粥

【排泄】
尿布 尿 / 尿布 便 / 尿布 尿+便
（也可以只打：尿尿、大便）

【體溫】
體溫 37.2

【備註】
備註 今天打預防針

【補登時間】
在前面或後面加時間，例如：
14:30 喝奶 120
尿布 便 09:15

【查詢】
今天 / 昨天 → 當日統計
最近 → 最近 10 筆
狀態 → 距離上次吃、睡、換尿布多久
復原 → 刪除最後一筆

在群組裡使用，爸爸媽媽可以一起記錄同一個寶寶 ❤️"""


def fmt_time(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def fmt_duration(delta: timedelta) -> str:
    minutes = max(0, int(delta.total_seconds() // 60))
    h, m = divmod(minutes, 60)
    if h and m:
        return f"{h}小時{m}分"
    if h:
        return f"{h}小時"
    return f"{m}分鐘"


def _fmt_value(value: float | None, unit: str | None) -> str:
    if value is None:
        return ""
    num = f"{value:g}"
    return f"{num}{unit or ''}"


def describe(rec: Record, now: datetime | None = None) -> str:
    """單筆記錄的一行描述。"""
    if rec.kind == SLEEP:
        if rec.end:
            return f"😴 睡眠 {fmt_time(rec.start)}-{fmt_time(rec.end)}（{fmt_duration(rec.end - rec.start)}）"
        suffix = f"，已睡 {fmt_duration(now - rec.start)}" if now else ""
        return f"😴 {fmt_time(rec.start)} 入睡（睡眠中{suffix}）"
    if rec.kind == FEED:
        return f"🍼 {fmt_time(rec.start)} {rec.detail} {_fmt_value(rec.value, rec.unit)}".rstrip()
    if rec.kind == DIAPER:
        return f"🧷 {fmt_time(rec.start)} 尿布 {rec.detail}"
    if rec.kind == TEMP:
        warn = " ⚠️" if rec.value is not None and rec.value >= 37.5 else ""
        tail = f" {rec.detail}" if rec.detail else ""
        return f"🌡️ {fmt_time(rec.start)} 體溫 {_fmt_value(rec.value, rec.unit)}{warn}{tail}"
    if rec.kind == NOTE:
        return f"📝 {fmt_time(rec.start)} {rec.detail}"
    return f"{fmt_time(rec.start)} {rec.kind} {rec.detail}"


class BabyService:
    def __init__(self, storage: Storage, tz):
        self.storage = storage
        self.tz = tz

    def now(self) -> datetime:
        return datetime.now(self.tz)

    def handle(self, chat_id: str, text: str, user_id: str | None = None,
               now: datetime | None = None) -> str | None:
        now = now or self.now()
        try:
            cmd = parser.parse(text, now)
        except ParseError as e:
            return f"⚠️ {e}"
        if cmd is None:
            return None
        handler = getattr(self, f"_do_{cmd.action}")
        return handler(chat_id, cmd, user_id, now)

    # ---- 記錄 ----

    def _do_record(self, chat_id, cmd: Command, user_id, now):
        kind = cmd.extra["kind"]
        rec = self.storage.add(chat_id, kind, cmd.at, value=cmd.value, unit=cmd.unit,
                               detail=cmd.detail, user_id=user_id)
        reply = "✅ 已記錄\n" + describe(rec, now)
        if kind == TEMP and rec.value is not None:
            if rec.value >= 38.0:
                reply += "\n寶寶發燒了，請留意精神與食慾，必要時就醫。"
            elif rec.value >= 37.5:
                reply += "\n體溫偏高，建議過一陣子再量一次。"
        if kind == FEED:
            reply += self._since_previous(chat_id, FEED, rec)
        return reply

    def _since_previous(self, chat_id, kind, rec: Record) -> str:
        """「距離上一餐」這類資訊。"""
        records = self.storage.between(chat_id, rec.start - timedelta(days=2), rec.start)
        prev = [r for r in records if r.kind == kind and r.id != rec.id]
        if not prev:
            return ""
        return f"\n距離上一餐 {fmt_duration(rec.start - prev[-1].start)}"

    def _do_sleep_start(self, chat_id, cmd: Command, user_id, now):
        opened = self.storage.open_sleep(chat_id)
        if opened:
            return (f"寶寶 {fmt_time(opened.start)} 就開始睡了（尚未起床）。\n"
                    "如果那筆是錯的，可以輸入「復原」刪掉，再重新輸入「睡覺」。")
        rec = self.storage.add(chat_id, SLEEP, cmd.at, user_id=user_id)
        return f"😴 {fmt_time(rec.start)} 開始睡覺，晚安～\n醒來時輸入「起床」"

    def _do_sleep_end(self, chat_id, cmd: Command, user_id, now):
        opened = self.storage.open_sleep(chat_id)
        if not opened:
            return "找不到還沒結束的睡眠 🤔\n請先輸入「睡覺」，或用「睡 13:00-14:30」補登。"
        if cmd.at <= opened.start:
            return f"起床時間 {fmt_time(cmd.at)} 早於入睡時間 {fmt_time(opened.start)}，請確認時間。"
        rec = self.storage.set_end(opened.id, cmd.at)
        return f"☀️ {fmt_time(rec.end)} 起床！\n這次睡了 {fmt_duration(rec.end - rec.start)}"

    def _do_sleep_range(self, chat_id, cmd: Command, user_id, now):
        rec = self.storage.add(chat_id, SLEEP, cmd.at, end=cmd.end, user_id=user_id)
        return "✅ 已補登\n" + describe(rec, now)

    # ---- 查詢 ----

    def _do_help(self, chat_id, cmd, user_id, now):
        return HELP_TEXT

    def _do_undo(self, chat_id, cmd, user_id, now):
        rec = self.storage.last_created(chat_id)
        if not rec:
            return "目前沒有任何紀錄可以刪除。"
        self.storage.delete(rec.id)
        return "🗑️ 已刪除最後一筆：\n" + describe(rec, now)

    def _do_recent(self, chat_id, cmd, user_id, now):
        records = self.storage.recent(chat_id, 10)
        if not records:
            return "還沒有任何紀錄喔！輸入「說明」看看怎麼用。"
        lines = ["📋 最近 10 筆紀錄"]
        last_date = None
        for r in records:
            if r.start.date() != last_date:
                last_date = r.start.date()
                lines.append(f"— {last_date.strftime('%m/%d')} —")
            lines.append(describe(r, now))
        return "\n".join(lines)

    def _do_status(self, chat_id, cmd, user_id, now):
        lines = ["⏱️ 目前狀態"]
        opened = self.storage.open_sleep(chat_id)
        if opened:
            lines.append(f"😴 睡眠中：{fmt_time(opened.start)} 入睡，已睡 {fmt_duration(now - opened.start)}")
        else:
            last_sleep = self.storage.last_of_kind(chat_id, SLEEP)
            if last_sleep and last_sleep.end:
                lines.append(f"☀️ 醒著：{fmt_time(last_sleep.end)} 起床，已醒 {fmt_duration(now - last_sleep.end)}")
        for kind, label, icon in ((FEED, "上次吃", "🍼"), (DIAPER, "上次換尿布", "🧷"), (TEMP, "上次量體溫", "🌡️")):
            rec = self.storage.last_of_kind(chat_id, kind)
            if rec:
                lines.append(f"{icon} {label}：{fmt_time(rec.start)}（{fmt_duration(now - rec.start)}前）"
                             + (f" {rec.detail}" if kind == DIAPER else "")
                             + (f" {_fmt_value(rec.value, rec.unit)}" if kind in (FEED, TEMP) else ""))
        if len(lines) == 1:
            return "還沒有任何紀錄喔！輸入「說明」看看怎麼用。"
        return "\n".join(lines)

    def _do_today(self, chat_id, cmd, user_id, now):
        return self.day_summary(chat_id, now.date(), now)

    def _do_yesterday(self, chat_id, cmd, user_id, now):
        return self.day_summary(chat_id, now.date() - timedelta(days=1), now)

    def day_summary(self, chat_id, day, now: datetime) -> str:
        start = datetime(day.year, day.month, day.day, tzinfo=self.tz)
        end = start + timedelta(days=1)
        records = self.storage.between(chat_id, start, end)
        title = f"📊 {day.strftime('%m/%d')} 統計"
        if not records:
            return f"{title}\n這天還沒有紀錄。"

        feeds = [r for r in records if r.kind == FEED]
        sleeps = [r for r in records if r.kind == SLEEP]
        diapers = [r for r in records if r.kind == DIAPER]
        temps = [r for r in records if r.kind == TEMP]

        lines = [title]

        ml = sum(r.value for r in feeds if r.unit == "ml" and r.value)
        breast = sum(r.value for r in feeds if r.unit == "分鐘" and r.value)
        feed_line = f"🍼 餵食 {len(feeds)} 次"
        extras = []
        if ml:
            extras.append(f"共 {ml:g}ml")
        if breast:
            extras.append(f"親餵 {breast:g} 分鐘")
        if extras:
            feed_line += "（" + "，".join(extras) + "）"
        lines.append(feed_line)

        total = timedelta()
        for r in sleeps:
            s = max(r.start, start)
            e = min(r.end or now, end)
            if e > s:
                total += e - s
        lines.append(f"😴 睡眠 {fmt_duration(total)}（{len(sleeps)} 段）")

        pee = sum(1 for r in diapers if "尿" in r.detail.split(" ")[0])
        poo = sum(1 for r in diapers if "便" in r.detail.split(" ")[0])
        lines.append(f"🧷 尿布 {len(diapers)} 次（尿 {pee}・便 {poo}）")

        if temps:
            values = [r.value for r in temps if r.value is not None]
            lines.append(f"🌡️ 體溫 {len(temps)} 次（最高 {max(values):g}°C）")

        lines.append("")
        lines.append("— 明細 —")
        for r in records:
            lines.append(describe(r, now))
        return "\n".join(lines)
