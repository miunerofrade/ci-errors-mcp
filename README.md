# CI Errors MCP

从 GitHub Actions 失败日志中提取错误原文、文件及行号。只暴露一个只读 MCP 工具 `ci_errors`，同一实现提供 CLI。无需模型 API，也不分析根因或修改 CI。

## 安装

需要 Node.js 22+、Git 和已登录的 GitHub CLI：

```sh
cd /Users/user/Code/ci-errors-mcp
npm ci
gh auth status
npm test
```

程序通过 `gh api` 复用 GitHub CLI 的认证，不读取或保存 token。仅支持 github.com。项目独立于 SEUdaily，不需要其依赖或配置。

## MCP 挂载

客户端通用 stdio 配置示例（配置字段因客户端而异）：

```json
{
  "mcpServers": {
    "ci-errors": {
      "command": "node",
      "args": ["/Users/user/Code/ci-errors-mcp/src/server.js"]
    }
  }
}
```

使用 Node 可执行文件的绝对路径可避免桌面客户端 PATH 不同。客户端还需能找到 `gh`。

只注册 `ci_errors`，工具描述与参数 Schema 已包含完整使用方式，不需要先读聊天记录。配置由使用者添加，本项目不会自动修改任何客户端设置。

## 调用

```json
{ "run_url": "https://github.com/OWNER/REPO/actions/runs/123" }
```

也可以使用 `repository` + `run_id`；`repo_path` 为本地仓库绝对路径，会查询当前 HEAD 对应的运行。同一 workflow 有多次运行时取最新运行，保留不同 workflow。没有匹配运行返回 `not_found`，不会取过去的失败代替；未发现 CI 不等于 CI 通过。仓库有多个不同工作流时会查询所有匹配运行。

默认 `max_chars=16000`，范围 1000–64000，用于限制错误原文（元数据另计）。结果有 `hasMore=true` 时，继续调用同一个工具：

```json
{ "cursor": "上一页返回的 cursor" }
```

分页优先保持完整错误块；单块超出页大小时返回 `partial`、`offset`、`totalChars`，后续页继续原文。`totalErrors` 包含未展示的错误。游标固定仓库、运行和 attempt，绑定报告摘要，重新读取时日志变化返回 `changed`，需要重新查询。完成运行的报告在 MCP 进程内保留至多 4 份、每份至多 4 MiB、5 分钟，续读无需重复下载；CLI 新进程或缓存过期后重新查询。游标不是访问凭据，不含 token。

## CLI

```sh
node src/cli.js --run-url https://github.com/OWNER/REPO/actions/runs/123
node src/cli.js --repository OWNER/REPO --run-id 123 --json
node src/cli.js --repo-path /absolute/path/to/repo --json
node src/cli.js --cursor 'CURSOR' --json
```

默认文本输出，`--json` 返回同样的结构化结果。查询失败、权限不足、部分日志无法读取时退出码 1；CI 本身失败依然返回可读取报告并退出 0。

## 结果含义

每个错误包含运行与 attempt、job、失败步骤标识、错误原文 `raw` 和 `locations`。不默认附链接，不推断多个失败是否有共同根因。

位置角色：

- `test_definition`：测试定义/入口，不是故障行。
- `throw_site`：日志中的首个 Node 异常栈位置，或 Python traceback 最后一个位置；不是推断的业务根因。
- `stack`：其他调用栈位置。
- `diagnostic`：编译器等明确报告的位置。

原始路径保留在 `path`；从 checkout 的工作目录能确定时补充 `relativePath`。行列号对应失败运行的 commit，而非当前可能已修改的文件。日志没有位置时明确返回“日志未提供文件与行号”。Node 内置 `node:internal` 栈保留在原文，不充当仓库文件位置。

`status` 区分 `success`、`failed`、`running`、`cancelled`、`not_found`、`incomplete`、`permission_denied`、`query_failed` 和 `completed_without_error_log`。已取消运行中仍可能存在真实失败任务，此时仍返回错误。`incomplete` 不代表所有错误均已拿到。

## 提取边界

识别 Node TAP 和 spec、Python traceback、TypeScript 编译错误与常见运行异常。保留原日志的时间戳、断言、预期/实际值和堆栈，不重新生成错误说明。失败步骤通过 runner 的 group 与退出错误标记定位；没有标记时返回 job 日志中可识别的错误。完全无法识别时返回原始日志，不编造原因。

网络读取每次超时 30 秒，瞬时网络故障和 429/502/503/504 最多尝试 3 次，不重试权限错误。单份日志最多读取 32 MiB，超出或过期明确报告不可用。只读取日志，既不执行日志中的命令，也不修改源代码。

测试样本保留公开 CI 的脱敏错误片段和完整失败步骤样本；`real-node24.txt` 用于覆盖 Node 24 的真实输出格式。运行 `npm test` 验证解析、定位、分页、运行选择以及 stdio 工具发现、调用与续读。
