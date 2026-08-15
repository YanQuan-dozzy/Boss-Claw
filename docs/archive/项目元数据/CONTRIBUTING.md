# Contributing to JobClaw

感谢参与 JobClaw by Chris。

## 开始前

1. 从 `main` 新建分支，不要直接在稳定分支上实验。
2. 不要提交 API Key、真实简历、招聘者聊天、手机号、邮箱、Cookie 或本地日志。
3. 修改 `source/src` 或 `source/public` 后，必须同步构建并确保根目录 `chrome-extension` 与构建结果一致。
4. 新功能必须包含测试；BOSS 页面适配修复应包含可复现的脱敏结构或 fixture。

## 验证命令

```bash
cd source
npm test
```

完整测试包括：

- 构建与 Manifest V3/CSP 校验
- 单元测试
- 集成测试
- 历史回归测试
- JavaScript 语法检查
- 敏感信息扫描
- 可安装扩展与源码构建同步检查

## Pull Request

PR 请说明：

- 问题和复现步骤
- 具体修改
- 风险与回滚方式
- 已运行的测试
- 脱敏后的界面截图（涉及 UI 时）

提交代码即表示你同意贡献内容按照 Apache License 2.0 许可，并保留 `NOTICE` 中的项目署名。

## Bug Issue

请提供版本、Chrome/操作系统版本、复现步骤、期望结果、实际结果和脱敏错误信息。不要在公开 Issue 里发送隐私数据。
