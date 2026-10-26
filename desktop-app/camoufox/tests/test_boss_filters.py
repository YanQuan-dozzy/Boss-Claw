"""BOSS 隐身通道「基础求职条件」翻译（issue #7 第五节）——纯离线。

两件事必须守住：
1. `build_filter_params('boss', ...)` 真的把条件翻译成 jobType / experience / degree /
   salary / scale（历史实现整块丢弃，隐身通道采回来的是未过滤结果）；
2. 码值与内置浏览器通道 `src/lib/bossclaw/searchUrl.ts` **逐字一致** ——
   同一份设置在两条通道下必须筛出同样的岗位，任一侧改码表都要在这里红。
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from platforms import filters  # noqa: E402

SEARCH_URL_TS = Path(__file__).resolve().parents[2] / 'src' / 'lib' / 'bossclaw' / 'searchUrl.ts'

# filters.py 常量表 ←→ searchUrl.ts 常量表（双源同步守卫的配对表）
PAIRS = {
    'JOB_TYPE_CODES': 'BOSS_JOB_TYPE',
    'EXPERIENCE_CODES': 'BOSS_EXPERIENCE',
    'DEGREE_CODES': 'BOSS_DEGREE',
    'SALARY_CODES': 'BOSS_SALARY',
    'SCALE_CODES': 'BOSS_SCALE',
}


def _ts_codes(name: str) -> dict:
    """从 searchUrl.ts 里解析 `export const <name>: Record<string, string> = { ... }`。"""
    text = SEARCH_URL_TS.read_text(encoding='utf-8')
    m = re.search(
        r'export const {0}\s*:\s*Record<string,\s*string>\s*=\s*\{{(.*?)\}};'.format(name),
        text,
        re.S,
    )
    if not m:
        raise AssertionError('searchUrl.ts 里找不到 {0}（解析口径需要同步更新）'.format(name))
    out = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith('//'):
            continue
        km = re.match(r"^'?([^:']+?)'?\s*:\s*'([^']+)',?$", line)
        if km:
            out[km.group(1)] = km.group(2)
    return out


class BossFilterParamCase(unittest.TestCase):
    def test_multi_value_joined_with_comma(self):
        params = filters.build_filter_params('boss', {
            'employmentTypes': ['全职'],
            'experiences': ['1-3年', '3-5年'],
            'degrees': ['本科'],
            'companyScale': '100-499人',
        })
        self.assertEqual(params['jobType'], '1901')
        self.assertEqual(params['experience'], '104,105')
        self.assertEqual(params['degree'], '203')
        self.assertEqual(params['scale'], '303')

    def test_unlimited_values_are_skipped(self):
        params = filters.build_filter_params('boss', {
            'employmentTypes': ['不限'],
            'experiences': ['经验不限'],
            'degrees': ['不限'],
            'companyScale': '不限',
            'salary': '不限',
        })
        self.assertEqual(params, {})

    def test_empty_criteria_yields_no_params(self):
        self.assertEqual(filters.build_filter_params('boss', None), {})
        self.assertEqual(filters.build_filter_params('boss', {}), {})

    def test_degree_alias_maps_to_same_code(self):
        for alias in ('中专', '中技', '中专/中技'):
            self.assertEqual(filters.build_filter_params('boss', {'degree': alias})['degree'], '208')

    def test_unsupported_dims_are_not_attached(self):
        """BOSS 搜索接口没有公司性质 / 融资阶段 / HR 活跃度参数 → 不臆造参数名。"""
        params = filters.build_filter_params('boss', {
            'companyType': '国企', 'financing': ['A轮'], 'hrActivity': 'week',
        })
        self.assertEqual(params, {})

    def test_summary_uses_platform_labels(self):
        params = filters.build_filter_params('boss', {
            'degrees': ['本科'], 'experiences': ['1-3年'], 'employmentTypes': ['全职'],
        })
        summary = filters.summarize_applied('boss', params)
        self.assertIn('学历=本科', summary)
        self.assertIn('经验=1-3年', summary)
        self.assertIn('求职类型=全职', summary)

    def test_capability_table_covers_boss(self):
        caps = filters.FILTER_CAPABILITIES['boss']
        self.assertEqual(caps['experience'], 'ok')
        self.assertEqual(caps['degree'], 'ok')
        self.assertEqual(caps['company_type'], 'unsupported')


class BossCodeSyncCase(unittest.TestCase):
    """filters.py 的 BOSS_* 码表必须与 searchUrl.ts 的对应表逐字一致。"""

    def test_every_ts_code_exists_in_python(self):
        self.assertTrue(SEARCH_URL_TS.exists(), '找不到 searchUrl.ts：{0}'.format(SEARCH_URL_TS))
        for ts_name, py_name in PAIRS.items():
            ts_map = _ts_codes(ts_name)
            self.assertTrue(ts_map, '{0} 解析为空，正则口径可能失效'.format(ts_name))
            py_map = getattr(filters, py_name)
            for label, code in ts_map.items():
                self.assertEqual(
                    py_map.get(label), code,
                    '码值不一致：{0}「{1}」searchUrl.ts={2} / filters.py={3}'.format(
                        ts_name, label, code, py_map.get(label)),
                )

    def test_python_only_aliases_reuse_ts_codes(self):
        """Python 侧允许有别名（如「中专」「中技」），但码值必须落在 TS 表已有的值里。"""
        for ts_name, py_name in PAIRS.items():
            ts_values = set(_ts_codes(ts_name).values())
            for label, code in getattr(filters, py_name).items():
                if label in _ts_codes(ts_name):
                    continue
                self.assertIn(
                    code, ts_values,
                    '{0}「{1}」是 Python 侧独有的别名，其码值 {2} 不在 searchUrl.ts 中'.format(
                        py_name, label, code),
                )


class BossSearchParamCase(unittest.TestCase):
    """服务端把筛选同时拼进列表页 URL 与 joblist 接口参数（两处必须一致）。"""

    @classmethod
    def setUpClass(cls):
        try:
            import camoufox_server
        except Exception as e:  # playwright / camoufox 未安装时跳过（归属环境问题，不是逻辑问题）
            raise unittest.SkipTest('camoufox_server 依赖不可用：{0}'.format(e))
        cls.mod = camoufox_server

    def test_filters_land_in_page_url_and_api(self):
        flt = filters.build_filter_params('boss', {'degrees': ['本科'], 'experiences': ['1-3年']})
        page = self.mod.boss_search_params('客户成功', '101020100', 2, flt)
        api = self.mod.boss_api_params('客户成功', '101020100', 2, flt)
        for params in (page, api):
            self.assertEqual(params['degree'], '203')
            self.assertEqual(params['experience'], '104')
            self.assertEqual(params['page'], 2)
        self.assertEqual(api['pageSize'], 30)
        self.assertEqual(api['scene'], 1)

    def test_empty_filters_keep_legacy_params_only(self):
        api = self.mod.boss_api_params('Python', '101020100', 1, {})
        self.assertEqual(set(api), {'query', 'city', 'page', 'scene', 'pageSize'})

    def test_chinese_query_is_url_encoded(self):
        from urllib.parse import urlencode
        qs = urlencode(self.mod.boss_search_params('客户成功', '101020100', 1, {'degree': '203'}))
        self.assertIn('query=%E5%AE%A2%E6%88%B7%E6%88%90%E5%8A%9F', qs)
        self.assertIn('degree=203', qs)


if __name__ == '__main__':
    unittest.main()
