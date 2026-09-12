// 岗位方向目录加载器：从数据文档 directionCatalog.json 读取并编译。
// 数据（关键字/技能/缺口/识别正则来源串）由联网调研维护在全行业 JSON 文档中，
// 本地规则运行时读取启用；本模块只负责「读取 + 编译 test 正则」并对外暴露。
// 说明：test 作为正则源字符串存于文档（JSON 不能容纳 RegExp 对象），此处 new RegExp(s, 'i') 编译。
// 兼容性：仍导出 DirectionRule 类型与 DIRECTION_RULES，现有消费者（helpers/directions）无需改动。

import catalog from './data/directionCatalog.json';

export interface DirectionRuleRaw {
  key: string;
  name: string;
  internName: string;
  /** 识别正则的字符串形式（运行时编译为 RegExp） */
  test: string;
  relevantSkills?: string[];
  keywords: string[];
  gapSkills?: string[];
  tech?: boolean;
}

export interface DirectionRule {
  key: string;
  /** 正式岗位名（社招/全职默认） */
  name: string;
  /** 实习/校招岗位名（判定为在校/应届时使用） */
  internName: string;
  /** 简历文本匹配（用于推断方向） */
  test: RegExp;
  /** 相关技能（用于证据展示 + 信号加分） */
  relevantSkills?: string[];
  /** 搜索关键词（生成 BOSS 搜索 URL 用） */
  keywords: string[];
  /** 常见短板（用于画像缺口提示） */
  gapSkills?: string[];
  /** 是否技术方向（技术方向在 inferDirections 中走特殊优先级逻辑） */
  tech?: boolean;
}

const rules: DirectionRuleRaw[] = Array.isArray((catalog as any).rules) ? (catalog as any).rules : [];

export const DIRECTION_RULES: DirectionRule[] = rules.map((rule) => ({
  ...rule,
  test: new RegExp(String(rule.test || ''), 'i'),
}));