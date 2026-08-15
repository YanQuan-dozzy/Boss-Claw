// 岗位方向目录：单一数据源，供 inferDirections / buildSearchKeywords / directionPreset 共用
// 覆盖互联网技术岗 + 全行业通用职能岗，避免只识别「前端/后端/全栈/AI」等互联网方向。

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

export const DIRECTION_RULES: DirectionRule[] = [
  // ===================== 技术方向 =====================
  {
    key: 'fullstack',
    name: '全栈开发工程师',
    internName: '全栈开发实习生',
    test: /全栈|full.?stack|前后端/i,
    relevantSkills: ['JavaScript', 'TypeScript', 'React', 'Vue', 'Node.js', 'Express', 'MySQL'],
    keywords: ['全栈开发', 'Web 全栈', '前后端开发'],
    gapSkills: ['后端接口', '数据库', '部署运维'],
    tech: true,
  },
  {
    key: 'ai',
    name: 'AI 应用开发工程师',
    internName: 'AI 应用开发实习生',
    test: /ai\s*应用|人工智能应用|大模型|智能体|agent|rag|llm|mcp/i,
    relevantSkills: ['AI Agent', 'RAG', 'LLM', 'MCP', 'Python', 'OCR'],
    keywords: ['AI 应用开发', 'AI Agent 开发', 'RAG 应用开发', '大模型应用开发'],
    gapSkills: ['模型评测', '向量数据库', '提示词工程'],
    tech: true,
  },
  {
    key: 'backend',
    name: '后端开发工程师',
    internName: '后端开发实习生',
    test: /后端|服务端|java|spring|node\.?js|golang|go语言|mysql|redis|消息队列/i,
    relevantSkills: ['Java', 'Spring Boot', 'MyBatis', 'Node.js', 'Python', 'Go', 'Express', 'Flask', 'Django', 'FastAPI', 'MySQL', 'PostgreSQL', 'Redis', 'RabbitMQ', 'SQL', 'Docker'],
    keywords: ['后端开发', '服务端开发', 'Java 开发', 'Node.js 开发', 'Python 开发'],
    gapSkills: ['数据库', '缓存', '接口设计'],
    tech: true,
  },
  {
    key: 'frontend',
    name: '前端开发工程师',
    internName: '前端开发实习生',
    test: /前端|web前端|网页开发|h5|react|vue|typescript|javascript/i,
    relevantSkills: ['JavaScript', 'TypeScript', 'HTML', 'CSS', 'React', 'Vue', 'Next.js', 'Vite', 'Webpack', 'Tailwind CSS'],
    keywords: ['前端开发', 'Web 前端', 'JavaScript 开发', 'React 开发', 'Vue 开发', 'TypeScript 前端'],
    gapSkills: ['工程化', '性能优化', '组件库'],
    tech: true,
  },
  {
    key: 'data-viz',
    name: '数据可视化开发工程师',
    internName: '数据可视化开发实习生',
    test: /数据可视化|echarts|d3|大屏|可视化看板/i,
    relevantSkills: ['ECharts', 'D3.js', 'JavaScript', 'TypeScript', 'React', 'Vue', '数据可视化'],
    keywords: ['数据可视化', '可视化前端', 'ECharts 开发'],
    gapSkills: ['图形性能优化', '复杂交互', '可视化工程化'],
    tech: true,
  },
  {
    key: 'algorithm',
    name: '算法工程师',
    internName: '算法实习生',
    test: /算法工程师|机器学习|深度学习|自然语言处理|\bnlp\b|计算机视觉|推荐系统|数据挖掘|模型训练/i,
    relevantSkills: ['Python', 'PyTorch', 'TensorFlow', 'OpenCV', 'LLM'],
    keywords: ['算法工程师', '机器学习', '深度学习', 'NLP 算法', '推荐算法'],
    gapSkills: ['模型调优', '数学基础', '大规模训练'],
  },
  {
    key: 'data-analysis',
    name: '数据分析师',
    internName: '数据分析实习生',
    test: /数据分析|商业分析|数据运营|tableau|power\s*bi|\bbi\s*工程师|经营分析/i,
    relevantSkills: ['SQL', 'Python', '数据可视化', 'ECharts'],
    keywords: ['数据分析', '数据分析师', '商业分析', 'BI 分析师'],
    gapSkills: ['统计学', 'SQL', '业务指标'],
  },
  {
    key: 'testing',
    name: '测试工程师',
    internName: '测试实习生',
    test: /软件测试|测试开发|自动化测试|性能测试|测试工程师|\bqa\b|接口测试|测试管理/i,
    relevantSkills: ['Selenium', 'Playwright', 'Python', 'Java', 'Linux'],
    keywords: ['测试工程师', '软件测试', '自动化测试', '测试开发', 'QA'],
    gapSkills: ['自动化框架', '性能测试', '测试设计'],
  },
  {
    key: 'ops',
    name: '运维工程师',
    internName: '运维实习生',
    test: /运维|devops|\bsre\b|kubernetes|k8s|系统运维|容器化|持续集成|持续交付/i,
    relevantSkills: ['Linux', 'Docker', 'Python', 'SQL'],
    keywords: ['运维工程师', 'DevOps', 'SRE', '系统运维', '云平台运维'],
    gapSkills: ['K8s', 'CI/CD', '监控告警'],
  },
  {
    key: 'security',
    name: '网络安全工程师',
    internName: '网络安全实习生',
    test: /网络安全|信息安全|渗透测试|攻防|安全工程师|等保|漏洞挖掘/i,
    relevantSkills: ['Linux', 'Python', 'C/C++'],
    keywords: ['网络安全', '信息安全', '渗透测试', '安全工程师'],
    gapSkills: ['渗透实战', '安全工具', '合规'],
  },
  {
    key: 'mobile',
    name: '移动端开发工程师',
    internName: '移动端开发实习生',
    test: /\bandroid\b|\bios\b|安卓|移动端|flutter|小程序开发|react\s*native|uniapp|鸿蒙|harmonyos/i,
    relevantSkills: ['TypeScript', 'JavaScript', 'React', 'Java', 'C/C++'],
    keywords: ['Android 开发', 'iOS 开发', '移动端开发', 'Flutter 开发', '小程序开发'],
    gapSkills: ['原生组件', '性能优化', '跨端适配'],
  },
  {
    key: 'embedded',
    name: '嵌入式工程师',
    internName: '嵌入式实习生',
    test: /嵌入式|单片机|stm32|\barm\b|\bfpga\b|硬件|电路|pcb|物联网/i,
    relevantSkills: ['C/C++', 'Linux', 'Python'],
    keywords: ['嵌入式开发', '单片机', '硬件工程师', '物联网'],
    gapSkills: ['驱动开发', '硬件调试', 'RTOS'],
  },
  {
    key: 'game',
    name: '游戏开发工程师',
    internName: '游戏开发实习生',
    test: /游戏开发|unity|unreal|ue4|ue5|cocos|游戏引擎|游戏客户端/i,
    relevantSkills: ['C/C++', 'Python'],
    keywords: ['游戏开发', 'Unity 开发', '游戏客户端', '游戏策划'],
    gapSkills: ['引擎源码', '渲染', '玩法设计'],
  },
  {
    key: 'blockchain',
    name: '区块链工程师',
    internName: '区块链实习生',
    test: /区块链|智能合约|solidity|web3|defi|nft/i,
    relevantSkills: ['Python', 'Go', 'Java'],
    keywords: ['区块链开发', '智能合约', 'Web3'],
    gapSkills: ['合约安全', '共识机制', '链上协议'],
  },
  {
    key: 'desktop',
    name: '桌面端开发工程师',
    internName: '桌面端开发实习生',
    test: /开发者工具|研发工具|桌面端|tauri|electron|工具开发|客户端/i,
    relevantSkills: ['Tauri', 'Electron', 'TypeScript', 'React', 'Node.js'],
    keywords: ['桌面端开发', 'Electron 开发', 'Tauri 开发', '客户端开发'],
    gapSkills: ['跨平台工程化', '桌面端发布', '系统 API'],
  },

  // ===================== 产品 / 设计 =====================
  {
    key: 'product',
    name: '产品经理',
    internName: '产品实习生',
    test: /产品经理|产品助理|产品策划|需求分析|\bprd\b|axure|用户研究|竞品分析|原型设计/i,
    keywords: ['产品经理', '产品助理', '产品策划', '需求分析师'],
    gapSkills: ['数据分析', '用户调研', '项目管理'],
  },
  {
    key: 'design',
    name: 'UI/UX设计师',
    internName: 'UI设计实习生',
    test: /ui设计|ux设计|视觉设计|交互设计|figma|sketch|photoshop|illustrator|蓝湖|平面设计/i,
    keywords: ['UI 设计', 'UX 设计', '视觉设计', '交互设计', '平面设计'],
    gapSkills: ['设计系统', '用户研究', '动效'],
  },

  // ===================== 运营 / 市场 / 销售 =====================
  {
    key: 'operations',
    name: '运营专员',
    internName: '运营实习生',
    test: /运营|内容运营|用户运营|活动运营|新媒体运营|公众号运营|短视频运营|社群运营|电商运营|增长运营|产品运营/i,
    keywords: ['运营', '新媒体运营', '内容运营', '用户运营', '活动运营', '电商运营'],
    gapSkills: ['数据复盘', '内容策划', '增长方法论'],
  },
  {
    key: 'marketing',
    name: '市场营销专员',
    internName: '市场实习生',
    test: /市场营销|市场推广|品牌|广告投放|\bseo\b|\bsem\b|公关|活动策划|媒介|信息流/i,
    keywords: ['市场营销', '品牌推广', '广告投放', '市场专员', '公关'],
    gapSkills: ['渠道投放', '品牌策划', '数据分析'],
  },
  {
    key: 'sales',
    name: '销售专员',
    internName: '销售实习生',
    test: /销售|客户经理|商务拓展|商务专员|\bbd\b|渠道销售|大客户|to\s*b/i,
    keywords: ['销售', '大客户销售', '商务拓展', '渠道销售', '客户经理'],
    gapSkills: ['客户资源', '谈判', '成交转化'],
  },

  // ===================== 职能 / 财务 / 金融 / 法务 =====================
  {
    key: 'hr',
    name: '人力资源专员',
    internName: 'HR实习生',
    test: /人力资源|人事|招聘|\bhr\b|薪酬|绩效|员工关系|组织发展|猎头/i,
    keywords: ['人力资源', 'HR', '招聘专员', '人事专员', '薪酬绩效'],
    gapSkills: ['招聘渠道', '劳动法', '薪酬设计'],
  },
  {
    key: 'finance',
    name: '会计',
    internName: '财务实习生',
    test: /财务|会计|出纳|审计|税务|成本核算|\bcpa\b|财务报表/i,
    keywords: ['会计', '财务', '出纳', '审计', '税务', '财务分析'],
    gapSkills: ['报表编制', '税务申报', '财务软件'],
  },
  {
    key: 'fin-investment',
    name: '金融分析师',
    internName: '金融实习生',
    test: /金融|投资|风控|证券|基金|量化|保险|银行|投行|固收|交易员/i,
    keywords: ['金融', '投资分析', '风控', '证券', '基金', '量化研究'],
    gapSkills: ['金融建模', '行业研究', '合规'],
  },
  {
    key: 'legal',
    name: '法务专员',
    internName: '法务实习生',
    test: /法务|律师|合规|合同审查|法律|知识产权|诉讼/i,
    keywords: ['法务', '律师助理', '合规', '合同管理', '知识产权'],
    gapSkills: ['法律检索', '合同起草', '诉讼流程'],
  },
  {
    key: 'admin',
    name: '行政专员',
    internName: '行政实习生',
    test: /行政|前台|助理|文员|秘书|办公管理/i,
    keywords: ['行政', '行政助理', '前台', '文员', '秘书'],
    gapSkills: ['办公软件', '会议组织', '公文写作'],
  },
  {
    key: 'customer-service',
    name: '客服专员',
    internName: '客服实习生',
    test: /客服|客户服务|售后|呼叫中心|客诉/i,
    keywords: ['客服', '客户服务', '售后客服', '客服专员'],
    gapSkills: ['沟通话术', '投诉处理', '工单系统'],
  },

  // ===================== 供应链 / 制造 / 建筑 / 医疗 / 教育 =====================
  {
    key: 'supply-chain',
    name: '供应链专员',
    internName: '供应链实习生',
    test: /供应链|采购|物流|仓储|sourcing|供应商管理|库存管理/i,
    keywords: ['供应链', '采购', '物流', '仓储管理', '供应链管理'],
    gapSkills: ['供应商管理', '库存优化', 'ERP'],
  },
  {
    key: 'manufacturing',
    name: '机械/电气工程师',
    internName: '机械/电气实习生',
    test: /机械|电气|工艺|\bplc\b|数控|质量工程师|生产管理|自动化设备|模具/i,
    keywords: ['机械工程师', '电气工程师', '工艺工程师', '质量工程师', 'PLC 工程师'],
    gapSkills: ['制图', '工艺设计', '设备调试'],
  },
  {
    key: 'construction',
    name: '建筑/土木工程师',
    internName: '建筑/土木实习生',
    test: /建筑|土木|造价|工程管理|施工|监理|结构设计|暖通|给排水/i,
    keywords: ['建筑工程师', '土木工程师', '造价工程师', '工程管理', '施工员'],
    gapSkills: ['制图规范', '造价软件', '现场管理'],
  },
  {
    key: 'healthcare',
    name: '医药/医疗相关岗位',
    internName: '医药/医疗相关岗位',
    test: /医生|护士|医疗|医药|临床|药剂|护理|医疗器械|药学/i,
    keywords: ['医生', '护士', '药剂师', '医药代表', '医疗器械', '临床'],
    gapSkills: ['执业资格', '临床经验', '药品知识'],
  },
  {
    key: 'education',
    name: '教师/讲师',
    internName: '助教',
    test: /教师|讲师|培训|教研|课程设计|班主任|家教|教育|教学/i,
    keywords: ['教师', '讲师', '培训师', '教研', '课程顾问'],
    gapSkills: ['教学法', '课程设计', '班级管理'],
  },

  // ===================== 传媒 / 咨询 / 电商 / 翻译 =====================
  {
    key: 'media',
    name: '文案/编辑',
    internName: '文案/编辑实习生',
    test: /文案|内容编辑|新媒体编辑|视频编辑|图书编辑|记者|撰稿|编导|内容创作|采访/i,
    keywords: ['文案策划', '内容编辑', '新媒体编辑', '记者', '编导'],
    gapSkills: ['写作功底', '选题策划', '爆款内容'],
  },
  {
    key: 'consulting',
    name: '咨询顾问',
    internName: '咨询实习生',
    test: /咨询|顾问|战略|管理咨询|行业研究|尽职调查/i,
    keywords: ['咨询顾问', '管理咨询', '战略咨询', '行业研究'],
    gapSkills: ['结构化分析', '报告撰写', '建模'],
  },
  {
    key: 'ecommerce',
    name: '电商运营专员',
    internName: '电商运营实习生',
    test: /电商|淘宝|天猫|京东|亚马逊|跨境电商|直播带货|店铺运营/i,
    keywords: ['电商运营', '淘宝运营', '跨境电商', '店铺运营', '直播运营'],
    gapSkills: ['选品', '平台规则', '数据运营'],
  },
  {
    key: 'translation',
    name: '翻译',
    internName: '翻译',
    test: /翻译|笔译|口译|英语专业|小语种/i,
    keywords: ['翻译', '笔译', '口译', '英语翻译', '本地化'],
    gapSkills: ['专业术语', 'CAT 工具', '母语水平'],
  },
];
