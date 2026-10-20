# 内置题库来源与许可

本目录的 `zh-interview-small.json` 由以下开源数据集清洗而来：

- **数据集**：Chinese_interview_dataset（Small / 16.1K）
- **作者**：zhangjun640
- **仓库**：https://github.com/zhangjun640/Chinese_interview_dataset
- **数据页**：https://huggingface.co/datasets/zhangjun640/Chinese_interview_small
- **许可**：Apache License 2.0（https://www.apache.org/licenses/LICENSE-2.0）
- **原始字段**：`instruction` / `input` / `output`（input 全部为空，已忽略）
- **清洗日期**：2026-10-19
- **保留条数**：13602 / 16138

清洗只做以下事情，未改写题干与答案内容：

1. 去除题干前的编号前缀、折叠空白；
2. 丢弃题干少于 8 字或多于 120 字、答案为空或少于 10 字的条目；
3. 归一化（全角转半角、去标点空白、英文小写）后完全相同的题只保留第一条；
4. 用关键词规则推断方向 / 难度 / 题型（内置库无人工标注，用户可在题库页修改）。

**内置题的 `output` 只是「参考资料（AI 生成，未校验）」**，不参与出题提示词，也不用于判定「漏答要点」；
内置题不产生「题库要点」标记（见方案 §5.7.5）。

Apache-2.0 要求分发时保留本声明与许可副本；本项目在「设置 → 关于 / 开源许可」中一并列出。
