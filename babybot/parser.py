"""把使用者輸入的文字解析成指令。

這個模組不碰 LINE 也不碰資料庫，方便單獨測試。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta

# 記錄類型
SLEEP = "sleep"
FEED = "feed"
DIAPER = "diaper"
TEMP = "temp"
NOTE = "note"

KIND_LABELS = {
    SLEEP: "睡眠",
    FEED: "餵食",
    DIAPER: "排泄",
    TEMP: "體溫",
    NOTE: "備註",
}


@dataclass
class Command:
    action: str
    # 記錄發生的時間（使用者沒指定時就是「現在」）
    at: datetime | None = None
    # 睡眠區間補登時使用
    end: datetime | None = None
    value: float | None = None
    unit: str | None = None
    detail: str = ""
    extra: dict = field(default_factory=dict)


class ParseError(ValueError):
    """輸入看起來像某個指令，但格式不對。訊息會直接回給使用者。"""


_TIME_RE = r"(\d{1,2})[:：](\d{2})"

SLEEP_START_WORDS = ("睡覺", "睡著", "睡了", "入睡", "開始睡", "哄睡")
SLEEP_END_WORDS = ("起床", "醒了", "醒來", "睡醒", "醒")
SLEEP_RANGE_WORDS = ("睡眠", "睡")
FEED_WORDS = {
    "母乳": "母乳",
    "親餵": "母乳",
    "瓶餵": "瓶餵",
    "配方奶": "配方奶",
    "配方": "配方奶",
    "擠奶": "瓶餵母乳",
    "喝奶": "喝奶",
    "吃奶": "喝奶",
    "奶": "喝奶",
    "副食品": "副食品",
    "吃飯": "副食品",
    "吃": "副食品",
}
DIAPER_WORDS = ("換尿布", "尿布", "排泄")
TEMP_WORDS = ("體溫", "溫度", "量體溫")
NOTE_WORDS = ("備註", "備忘", "筆記", "記事")

QUERY_WORDS = {
    "今天": "today",
    "今日": "today",
    "昨天": "yesterday",
    "昨日": "yesterday",
    "最近": "recent",
    "紀錄": "recent",
    "記錄": "recent",
    "歷史": "recent",
    "狀態": "status",
    "現在": "status",
    "多久": "status",
    "刪除": "undo",
    "復原": "undo",
    "取消": "undo",
    "刪除上一筆": "undo",
    "說明": "help",
    "幫助": "help",
    "使用說明": "help",
    "指令": "help",
    "help": "help",
    "?": "help",
}


def normalize(text: str) -> str:
    # NFKC 會把全形數字、全形冒號轉成半形
    return unicodedata.normalize("NFKC", text).strip()


def _resolve_time(hh: str, mm: str, now: datetime) -> datetime:
    h, m = int(hh), int(mm)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ParseError(f"時間「{hh}:{mm}」不正確，請用 24 小時制，例如 14:30")
    candidate = datetime.combine(now.date(), time(h, m), tzinfo=now.tzinfo)
    # 比現在晚超過 5 分鐘，就當作是昨天
    if candidate - now > timedelta(minutes=5):
        candidate -= timedelta(days=1)
    return candidate


def _strip_leading_time(text: str, now: datetime) -> tuple[datetime | None, str]:
    """支援「14:30 喝奶 120」這種在前面加時間的寫法，也支援放在最後面。"""
    m = re.match(rf"^{_TIME_RE}\s*(.*)$", text)
    if m and not re.match(rf"^{_TIME_RE}\s*[-~～到至]", text):
        return _resolve_time(m.group(1), m.group(2), now), m.group(3).strip()
    m = re.match(rf"^(.*?)\s+{_TIME_RE}$", text)
    if m and not re.search(rf"{_TIME_RE}\s*[-~～到至]\s*{_TIME_RE}$", text):
        return _resolve_time(m.group(2), m.group(3), now), m.group(1).strip()
    return None, text


def _starts_with(text: str, words, follow: str = "") -> str | None:
    """text 以 words 其中之一開頭，且後面接的是空白、結尾或 follow 中的字元。

    限制後面的字元是為了避免在群組聊天時誤判，例如「吃飽了嗎」、「奶瓶洗了嗎」。
    """
    for w in sorted(words, key=len, reverse=True):
        if text.lower().startswith(w):
            rest = text[len(w):]
            if not rest or rest[0].isspace() or rest[0] in ":：" or (follow and re.match(follow, rest)):
                return w
    return None


def _parse_feed(word: str, rest: str, at: datetime) -> Command:
    kind = FEED_WORDS[word]
    cmd = Command("record", at=at, extra={"kind": FEED})
    side = None
    for k, v in (("左右", "左右"), ("雙邊", "左右"), ("左", "左"), ("右", "右")):
        if k in rest:
            side = v
            rest = rest.replace(k, " ", 1)
            break

    m = re.search(r"(\d+(?:\.\d+)?)\s*(ml|cc|毫升|c\.c\.|分鐘|分|min|g|克|口|匙)?", rest, re.I)
    if m:
        num = float(m.group(1))
        unit = (m.group(2) or "").lower()
        if unit in ("ml", "cc", "毫升", "c.c."):
            cmd.value, cmd.unit = num, "ml"
        elif unit in ("分鐘", "分", "min"):
            cmd.value, cmd.unit = num, "分鐘"
        elif unit in ("g", "克"):
            cmd.value, cmd.unit = num, "g"
        elif unit in ("口", "匙"):
            cmd.value, cmd.unit = num, unit
        elif kind == "母乳":
            cmd.value, cmd.unit = num, "分鐘"
        elif kind == "副食品":
            cmd.value, cmd.unit = num, "g"
        else:
            cmd.value, cmd.unit = num, "ml"
        rest = (rest[: m.start()] + rest[m.end():]).strip()

    note = " ".join(rest.split())
    parts = [kind]
    if side:
        parts.append(side)
    if note:
        parts.append(note)
    cmd.detail = " ".join(parts)
    return cmd


def _parse_diaper(rest: str, at: datetime) -> Command:
    pee = bool(re.search(r"尿|濕|小便|pee", rest, re.I))
    poo = bool(re.search(r"便|屎|大|poo", rest.replace("小便", ""), re.I))
    if not pee and not poo:
        raise ParseError("請說明是「尿」還是「便」，例如：尿布 尿、尿布 便、尿布 尿+便")
    if pee and poo:
        label = "尿+便"
    elif poo:
        label = "便"
    else:
        label = "尿"
    extra_note = re.sub(r"尿布|尿|濕|小便|大便|便便|便|屎|pee|poo|[+＋&和、,，]", " ", rest, flags=re.I)
    extra_note = " ".join(extra_note.split())
    detail = label + (f" {extra_note}" if extra_note else "")
    return Command("record", at=at, detail=detail, extra={"kind": DIAPER, "pee": pee, "poo": poo})


def _parse_temp(rest: str, at: datetime) -> Command:
    m = re.search(r"(\d{2}(?:\.\d+)?)", rest)
    if not m:
        raise ParseError("請輸入體溫數字，例如：體溫 37.2")
    value = float(m.group(1))
    if not 30 <= value <= 45:
        raise ParseError(f"體溫 {value} 看起來不太對，請輸入攝氏溫度，例如：體溫 37.2")
    note = " ".join((rest[: m.start()] + rest[m.end():]).replace("度", " ").replace("°C", " ").split())
    return Command("record", at=at, value=value, unit="°C", detail=note, extra={"kind": TEMP})


def parse(text: str, now: datetime) -> Command | None:
    """解析一則訊息。看不懂就回傳 None（機器人不回應，避免在群組裡吵）。"""
    text = normalize(text)
    if not text:
        return None

    lowered = text.lower()
    if lowered in QUERY_WORDS:
        return Command(QUERY_WORDS[lowered])

    # 補登睡眠區間：「睡 13:00-14:30」或「睡眠 13:00~14:30」
    m = re.match(rf"^(睡眠|睡覺|睡)\s*{_TIME_RE}\s*[-~～到至]\s*{_TIME_RE}$", text)
    if m:
        start = _resolve_time(m.group(2), m.group(3), now)
        end = _resolve_time(m.group(4), m.group(5), now)
        if end <= start:
            # 跨夜：例如 22:00-06:00
            if start.date() == end.date():
                start -= timedelta(days=1)
            else:
                end += timedelta(days=1)
        if end - start > timedelta(hours=24):
            raise ParseError("睡眠區間超過 24 小時，請確認時間")
        return Command("sleep_range", at=start, end=end, extra={"kind": SLEEP})

    at, body = _strip_leading_time(text, now)
    at = at or now
    if not body:
        return None

    word = _starts_with(body, NOTE_WORDS)
    if word:
        note = body[len(word):].strip(" :：")
        if not note:
            raise ParseError("請在「備註」後面加上內容，例如：備註 今天打預防針")
        return Command("record", at=at, detail=note, extra={"kind": NOTE})

    word = _starts_with(body, TEMP_WORDS, r"\d")
    if word:
        return _parse_temp(body[len(word):], at)

    word = _starts_with(body, SLEEP_START_WORDS)
    if word and not body[len(word):].strip():
        return Command("sleep_start", at=at, extra={"kind": SLEEP})

    word = _starts_with(body, SLEEP_END_WORDS)
    if word and not body[len(word):].strip():
        return Command("sleep_end", at=at, extra={"kind": SLEEP})

    word = _starts_with(body, DIAPER_WORDS, r"[尿濕便大小]")
    if word:
        return _parse_diaper(body[len(word):], at)
    if re.fullmatch(r"(尿尿|小便|尿了|濕了|大便|便便|拉屎|大便了|便便了)(.*)", body):
        return _parse_diaper(body, at)

    word = _starts_with(body, FEED_WORDS, r"\d|左|右|雙")
    if word:
        return _parse_feed(word, body[len(word):], at)

    # 「37.5」單獨一個數字，在體溫範圍內就當作體溫
    if re.fullmatch(r"3[4-9](\.\d)?|4[0-2](\.\d)?", body):
        return _parse_temp(body, at)

    return None
