import os
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from babybot import parser
from babybot.service import BabyService
from babybot.storage import Storage

TZ = ZoneInfo("Asia/Taipei")
NOW = datetime(2026, 10, 7, 15, 0, tzinfo=TZ)
CHAT = "C1"


BACKENDS = ["sqlite"] + (["postgres"] if os.environ.get("TEST_DATABASE_URL") else [])


@pytest.fixture(params=BACKENDS)
def svc(request):
    if request.param == "sqlite":
        return BabyService(Storage(TZ, path=":memory:"), TZ)
    # 測試用的 Postgres，每個測試前清空
    storage = Storage(TZ, url=os.environ["TEST_DATABASE_URL"])
    storage._execute("TRUNCATE records")
    return BabyService(storage, TZ)


def at(h, m, day=7):
    return datetime(2026, 10, day, h, m, tzinfo=TZ)


# ---- parser ----

@pytest.mark.parametrize("text,value,unit,detail", [
    ("喝奶 120", 120, "ml", "喝奶"),
    ("配方奶150ml", 150, "ml", "配方奶"),
    ("母乳 左 15", 15, "分鐘", "母乳 左"),
    ("副食品 30g 南瓜粥", 30, "g", "副食品 南瓜粥"),
    ("喝奶", None, None, "喝奶"),
    ("喝奶 １２０", 120, "ml", "喝奶"),  # 全形數字
])
def test_parse_feed(text, value, unit, detail):
    cmd = parser.parse(text, NOW)
    assert cmd.extra["kind"] == parser.FEED
    assert cmd.value == value and cmd.unit == unit and cmd.detail == detail


@pytest.mark.parametrize("text,detail", [
    ("尿布 尿", "尿"),
    ("尿布 便", "便"),
    ("尿布 尿+便", "尿+便"),
    ("尿布 大便 很稀", "便 很稀"),
    ("尿尿", "尿"),
    ("大便", "便"),
])
def test_parse_diaper(text, detail):
    cmd = parser.parse(text, NOW)
    assert cmd.extra["kind"] == parser.DIAPER and cmd.detail == detail


def test_parse_temp_and_note():
    assert parser.parse("體溫 37.2", NOW).value == 37.2
    assert parser.parse("37.8", NOW).value == 37.8
    assert parser.parse("備註 打預防針", NOW).detail == "打預防針"
    with pytest.raises(parser.ParseError):
        parser.parse("體溫 99", NOW)


def test_parse_time_prefix_and_suffix():
    assert parser.parse("14:30 喝奶 120", NOW).at == at(14, 30)
    assert parser.parse("尿布 便 09:15", NOW).at == at(9, 15)
    # 比現在晚的時間視為昨天
    assert parser.parse("23:00 睡覺", NOW).at == at(23, 0, day=6)


def test_parse_sleep_range_overnight():
    cmd = parser.parse("睡 22:00-06:00", NOW)
    assert cmd.at == at(22, 0, day=6) and cmd.end == at(6, 0)


@pytest.mark.parametrize("text", ["吃飽了嗎", "奶瓶洗了嗎", "今天天氣真好", "哈哈", "尿布好貴", "睡覺前要洗澡"])
def test_ignores_chitchat(text):
    assert parser.parse(text, NOW) is None


# ---- service ----

def test_sleep_flow(svc):
    assert "開始睡覺" in svc.handle(CHAT, "睡覺", now=at(13, 0))
    assert "已經" not in svc.handle(CHAT, "狀態", now=at(13, 30))
    reply = svc.handle(CHAT, "起床", now=at(14, 45))
    assert "1小時45分" in reply
    assert "找不到" in svc.handle(CHAT, "起床", now=at(15, 0))


def test_double_sleep_start(svc):
    svc.handle(CHAT, "睡覺", now=at(13, 0))
    assert "尚未起床" in svc.handle(CHAT, "睡覺", now=at(13, 10))


def test_today_summary(svc):
    svc.handle(CHAT, "睡 22:00-06:00", now=at(8, 0))
    svc.handle(CHAT, "喝奶 120", now=at(8, 0))
    svc.handle(CHAT, "11:00 配方奶 150", now=at(11, 5))
    svc.handle(CHAT, "母乳 右 10", now=at(12, 0))
    svc.handle(CHAT, "尿布 尿+便", now=at(9, 0))
    svc.handle(CHAT, "尿布 尿", now=at(10, 0))
    svc.handle(CHAT, "體溫 37.6", now=at(10, 0))
    svc.handle(CHAT, "備註 打預防針", now=at(10, 30))
    s = svc.handle(CHAT, "今天", now=NOW)
    assert "餵食 3 次（共 270ml，親餵 10 分鐘）" in s
    assert "睡眠 6小時（1 段）" in s  # 只算 00:00 之後
    assert "尿布 2 次（尿 2・便 1）" in s
    assert "最高 37.6°C" in s
    assert "打預防針" in s


def test_feed_reports_interval(svc):
    svc.handle(CHAT, "喝奶 120", now=at(8, 0))
    assert "距離上一餐 3小時" in svc.handle(CHAT, "喝奶 100", now=at(11, 0))


def test_undo(svc):
    svc.handle(CHAT, "喝奶 120", now=at(8, 0))
    assert "已刪除" in svc.handle(CHAT, "復原", now=at(8, 1))
    assert "沒有任何紀錄" in svc.handle(CHAT, "復原", now=at(8, 2))


def test_chats_are_separate(svc):
    svc.handle("A", "喝奶 120", now=at(8, 0))
    assert "還沒有任何紀錄" in svc.handle("B", "最近", now=at(9, 0))


def test_fever_warning(svc):
    assert "發燒" in svc.handle(CHAT, "體溫 38.3", now=NOW)


def test_parse_error_is_reported(svc):
    assert svc.handle(CHAT, "體溫", now=NOW).startswith("⚠️")


def test_unknown_is_silent(svc):
    assert svc.handle(CHAT, "寶寶好可愛", now=NOW) is None
