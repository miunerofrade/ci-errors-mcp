# 验证记录

2026-10-10 本地验证。

- 17 项自动测试全部通过；格式检查通过。Node 自动测试覆盖 TAP/spec 错误块、真实 Windows 断言与哈希不一致、Python traceback、启动异常、编译位置、无位置、退出码、超时、日志不可用、权限/网络错误、HEAD 选择及完整分页。
- stdio MCP 客户端实际连接服务器，确认只发现 `ci_errors`，验证非法参数拒绝、工具调用、单份 JSON 文本输出和续读原文完整拼接；确认完整结果仅出现一次。
- CLI 子进程回归确认 HTTP 404/410、权限错误、网络错误及部分日志过期均返回退出码 1；取得 CI 成功或失败报告时返回 0。
- attempt 回归覆盖参数与链接解析、冲突拒绝、非法编号、重跑后查询旧 attempt，以及无缓存续读固定运行信息、任务和日志。CLI 的 `--attempt` 通过实际子进程验证。
- 真实运行 `38041765253`（通过 `/attempts/1` 明确指定）：一次 CLI 查询三个 Windows 失败任务，取得 14 个错误块，64,000 字符预算内完整返回。成功直接提取测试入口和 `test_agent_http.mjs:53:240`、`test_knowledge.mjs:238:62`、`test_notice_sources.mjs:63:110`；保留预期/实际值与 tsconfig 异常。
- 真实运行 `38041482838`：一次 CLI 查询六个失败任务，取得 6 个错误块。直接提取 SQLite 异常位置 `tests/test_serve.mjs:162:56` 和 Python 断言 `scripts/validate-terminal.py:121`，保留原始错误。
- 运行均来自公开仓库 `miunerofrade/SEUdaily`；GitHub 查询为只读，没有重跑、取消或改动工作流。位置对应失败提交。
- 真实 Node 24 失败步骤及 Python 异常的脱敏样本保留在 `tests/fixtures/`。原始下载日志及临时报告在验收后删除。

此验证证明这些真实错误能够直接提取，不代表任意工具输出都能识别。未知格式返回原日志；无法提取位置时明确标记未知。
