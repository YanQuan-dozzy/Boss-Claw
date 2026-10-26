"""断点续采的页数判据（issue #7）——纯离线，不读 Cookie、不联网、不开浏览器。

覆盖的问题：断点最小单元是「平台 × 城市 × 关键词」，**不含页数**。
只按该单元判完成时，用户把「搜索结果页数」从 1 调到 3 再跑，
会因 24h 内已采完而整词跳过，日志写「已采完」，看起来像调参没生效。
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from platforms.progress import ProgressStore, combo_key  # noqa: E402
from platforms import base  # noqa: E402


class ProgressStorePageCase(unittest.TestCase):
    """ProgressStore.completed_combo 的 min_pages 语义。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='bossclaw-progress-')
        self.path = Path(self._tmp.name) / 'collection-progress.json'
        self.store = ProgressStore(path=self.path, ttl_hours=24)

    def tearDown(self):
        self._tmp.cleanup()

    def test_done_without_min_pages_keeps_legacy_semantics(self):
        self.store.mark_combo_done('liepin', '上海', '客户成功', pages=1, count=30)
        self.assertTrue(self.store.completed_combo('liepin', '上海', '客户成功'))

    def test_page_requirement_covered_is_skipped(self):
        self.store.mark_combo_done('liepin', '上海', '客户成功', pages=3, count=90)
        self.assertTrue(self.store.completed_combo('liepin', '上海', '客户成功', min_pages=3))
        self.assertTrue(self.store.completed_combo('liepin', '上海', '客户成功', min_pages=2))

    def test_page_requirement_not_covered_is_recollected(self):
        self.store.mark_combo_done('liepin', '上海', '客户成功', pages=1, count=30)
        self.assertFalse(self.store.completed_combo('liepin', '上海', '客户成功', min_pages=3))

    def test_legacy_entry_without_pages_counts_as_zero(self):
        """v1 条目可能没有 pages 字段 → 视作 0 页，任何页数要求都认为未采完（宁重复不遗漏）。"""
        payload = {
            'version': 1,
            'combos': {combo_key('liepin', '上海', '客户成功'): {'done': True, 'at': time.time()}},
        }
        self.path.write_text(json.dumps(payload), encoding='utf-8')
        legacy = ProgressStore(path=self.path, ttl_hours=24)
        self.assertTrue(legacy.completed_combo('liepin', '上海', '客户成功'))
        self.assertFalse(legacy.completed_combo('liepin', '上海', '客户成功', min_pages=1))

    def test_entry_survives_page_growth(self):
        """页数不足只是「不跳过」，不得顺手删条目 —— 新一轮采完会覆盖成更大的 pages。"""
        self.store.mark_combo_done('liepin', '上海', '客户成功', pages=1, count=30)
        self.assertFalse(self.store.completed_combo('liepin', '上海', '客户成功', min_pages=3))
        self.assertIsNotNone(self.store.combo_entry('liepin', '上海', '客户成功'))
        self.store.mark_combo_done('liepin', '上海', '客户成功', pages=3, count=88)
        self.assertTrue(self.store.completed_combo('liepin', '上海', '客户成功', min_pages=3))

    def test_expired_entry_is_not_completed(self):
        self.store.mark_combo_done('liepin', '上海', '客户成功', pages=5, count=150)
        expired = ProgressStore(path=self.path, ttl_hours=1)
        with patch.object(expired, '_ttl_hours', 0):
            self.assertFalse(expired.completed_combo('liepin', '上海', '客户成功', min_pages=1))

    def test_combo_entry_is_a_copy(self):
        self.store.mark_combo_done('liepin', '上海', '客户成功', pages=2, count=60)
        entry = self.store.combo_entry('liepin', '上海', '客户成功')
        entry['pages'] = 99
        self.assertEqual(self.store.combo_entry('liepin', '上海', '客户成功')['pages'], 2)

    def test_missing_entry_returns_none(self):
        self.assertIsNone(self.store.combo_entry('liepin', '上海', '从未采过'))


class SearchJobsResumeCase(unittest.TestCase):
    """base.CollectorBase.search_jobs 的跳过 / 重采分支（浏览器入口用异常哨兵拦截）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='bossclaw-progress-jobs-')
        self._env = patch.dict(os.environ, {'BOSSCLAW_DATA_DIR': self._tmp.name})
        self._env.start()
        ProgressStore().mark_combo_done('liepin', '上海', '客户成功', pages=1, count=30)

        class Dummy(base.CollectorBase):
            platform = 'liepin'
            label = '猎聘'

            def build_search_url(self, query, city, salary, page=1, criteria=None):
                return 'about:blank'

        self.collector = Dummy()

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def test_same_page_count_is_skipped_without_opening_browser(self):
        def boom(**kwargs):
            raise AssertionError('已采完且页数覆盖，不应打开浏览器')

        with patch.object(base, 'open_browser', boom):
            result = self.collector.search_jobs('客户成功', '上海', pages=1)
        self.assertTrue(result.get('skipped'))
        self.assertEqual(result.get('jobs'), [])

    def test_larger_page_count_recollects_instead_of_skipping(self):
        def boom(**kwargs):
            raise AssertionError('页数变大应重新采集（哨兵：说明确实进入了浏览器流程）')

        with patch.object(base, 'open_browser', boom):
            with self.assertRaises(AssertionError):
                self.collector.search_jobs('客户成功', '上海', pages=3)

    def test_force_ignores_breakpoint(self):
        def boom(**kwargs):
            raise AssertionError('force=True 应忽略断点')

        with patch.object(base, 'open_browser', boom):
            with self.assertRaises(AssertionError):
                self.collector.search_jobs('客户成功', '上海', pages=1, force=True)


if __name__ == '__main__':
    unittest.main()
