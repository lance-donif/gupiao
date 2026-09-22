import unittest
from unittest.mock import Mock, patch

from scripts.baidu_news import news_economic_baidu


def response(day, total, rows):
    return Mock(json=Mock(return_value={"ResultCode": 0, "Result": {"calendarInfo": [
        {"date": day, "total": total, "list": rows}
    ]}}))


class BaiduNewsTests(unittest.TestCase):
    @patch("scripts.baidu_news.requests.get")
    def test_pagination_date_and_field_compatibility(self, get):
        row = {"date": "2026-09-22", "time": "09:30", "region": "中国",
               "title": "经济事件", "star": "2", "pubVal": "1.5", "formerVal": "1.2"}
        get.side_effect = [response("2026-09-22", 101, [row] * 100), response("2026-09-22", 101, [row])]
        frame = news_economic_baidu("20260922")
        self.assertEqual(len(frame), 101)
        self.assertEqual(frame.iloc[0]["事件"], "经济事件")
        self.assertEqual(frame.iloc[0]["公布"], 1.5)
        self.assertEqual(frame.iloc[0]["重要性"], 2)
        self.assertEqual(get.call_args_list[0].kwargs["params"]["start_date"], "2026-09-22")
        self.assertEqual(get.call_args_list[1].kwargs["params"]["pn"], "1")
        self.assertNotIn("cookie", get.call_args_list[0].kwargs["headers"])

    @patch("scripts.baidu_news.requests.get")
    @patch("scripts.baidu_news.datetime")
    def test_missing_date_defaults_to_beijing_today(self, clock, get):
        from datetime import datetime
        clock.now.return_value = datetime(2026, 9, 23, 0, 30)
        clock.strptime.side_effect = datetime.strptime
        get.return_value = response("2026-09-23", 0, [])
        self.assertTrue(news_economic_baidu().empty)
        self.assertEqual(clock.now.call_args.args[0].utcoffset(None).total_seconds(), 8 * 3600)
        self.assertEqual(get.call_args.kwargs["params"]["start_date"], "2026-09-23")

    @patch("scripts.baidu_news.requests.get")
    def test_invalid_structure_and_upstream_error_raise(self, get):
        get.return_value = Mock(json=Mock(return_value={"ResultCode": 0, "Result": {}}))
        with self.assertRaisesRegex(ValueError, "Invalid"):
            news_economic_baidu("20260922")
        get.return_value = Mock(json=Mock(return_value={"ResultCode": 403}))
        with self.assertRaisesRegex(ValueError, "result code"):
            news_economic_baidu("20260922")

    @patch("scripts.baidu_news.requests.get")
    def test_invalid_date_never_requests_upstream(self, get):
        for value in ["2026-09-22", "20260230", "2026092"]:
            with self.assertRaises(ValueError):
                news_economic_baidu(value)
        get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
