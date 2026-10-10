# CI Errors MCP

从 GitHub Actions 失败日志中提取完整报错及日志提供的文件、行号和列号，让 AI 直接阅读错误并定位代码。提供一个只读 MCP 工具 `ci_errors` 和同一实现的 CLI，通过已登录的 GitHub CLI 查询运行与日志。

## 支持的语言与日志格式

| 语言                    | 提取范围                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------- |
| JavaScript / TypeScript | Node.js 内置测试运行器的 TAP、spec 失败块；运行异常、断言和调用栈；测试文件启动时的异常 |
| TypeScript              | TypeScript 编译器的 `error TSxxxx` 和 `file.ts(line,column): error` 诊断                |
| Python                  | Python traceback、异常和断言；pytest 的 `FAILED`、`E ...Error` 错误行基础识别           |

解析能力取决于日志格式。上述格式有专门识别规则；其他语言或测试框架使用通用错误标记与位置规则，无法识别错误块时返回失败步骤的原始日志。pytest 目前属于基础识别，专门验证的 Python 样本为 traceback 和终端断言。

原日志中的时间戳、断言、预期值、实际值和堆栈会保留。工具负责查询、提取和位置整理，调用者结合代码分析原因。

## 安装

需要 Node.js 22+、Git 和已登录的 GitHub CLI：

```sh
git clone https://github.com/miunerofrade/ci-errors-mcp.git
cd ci-errors-mcp
npm ci
gh auth status
```

当前支持 github.com 上的 GitHub Actions。程序通过 `gh api` 复用 GitHub CLI 的认证和仓库访问权限。

## MCP 挂载

客户端通用 stdio 配置示例（配置字段因客户端而异）：

```json
{
  "mcpServers": {
    "ci-errors": {
      "command": "node",
      "args": ["/absolute/path/to/ci-errors-mcp/src/server.js"]
    }
  }
}
```

将路径替换为实际安装目录，并在客户端添加配置。桌面客户端可使用 Node 可执行文件的绝对路径；其运行环境还需能找到 `gh`。

服务注册一个工具 `ci_errors`。工具描述与参数 Schema 包含用途、输入方式和结果含义，供客户端发现和调用。

## 调用

通过运行链接查询：

```json
{ "run_url": "https://github.com/OWNER/REPO/actions/runs/123" }
```

通过仓库与运行 ID 查询：

```json
{ "repository": "OWNER/REPO", "run_id": 123 }
```

通过本地仓库查询当前 HEAD 对应的运行：

```json
{ "repo_path": "/absolute/path/to/repo" }
```

`repo_path` 按当前 HEAD 的提交筛选运行，同一 workflow 取最新运行，保留不同 workflow 的匹配结果。没有匹配运行时返回 `not_found`，表示该提交尚无可查询的运行。

默认 `max_chars=16000`，范围 1000–64000，用于限制每页错误原文的字符数，元数据另计。结果有 `hasMore=true` 时，通过同一个工具续读：

```json
{ "cursor": "上一页返回的 cursor" }
```

分页优先保持完整错误块；单块超出页大小时返回 `partial`、`offset`、`totalChars`，后续页继续原文。`totalErrors` 是报告中的错误总数。

游标固定仓库、运行、attempt 和报告摘要。重新读取时日志变化返回 `changed`，此时重新发起查询。完成运行的报告在 MCP 进程内缓存至多 4 份、每份至多 4 MiB、5 分钟；CLI 新进程或缓存过期后重新读取日志。

## CLI

在项目目录运行：

```sh
node src/cli.js --run-url https://github.com/OWNER/REPO/actions/runs/123
node src/cli.js --repository OWNER/REPO --run-id 123 --json
node src/cli.js --repo-path /absolute/path/to/repo --json
node src/cli.js --cursor 'CURSOR' --json
```

默认输出可读文本，`--json` 返回同样的结构化结果。查询失败、权限不足、部分日志无法读取时退出码为 1；参数错误为 2；成功取得 CI 失败报告时退出码为 0。

## 结果与位置含义

每个错误包含运行与 attempt、job、失败步骤标识、错误原文 `raw` 和 `locations`。位置角色分别为：

| 角色              | 含义                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `test_definition` | 测试定义或测试文件入口的位置                                     |
| `throw_site`      | 日志中的首个 Node 异常栈位置，或 Python traceback 的最后一个位置 |
| `stack`           | 其他调用栈位置                                                   |
| `diagnostic`      | 编译器等明确报告的位置                                           |

`throw_site` 描述异常堆栈的位置，根因和应修改的代码由调用者进一步判断。

原始路径保留在 `path`；能确定仓库相对路径时补充 `relativePath`。支持 Windows、Linux 路径和日志中的文件 URL。行列号对应失败运行的 commit。`logStartLine` 是错误块在日志中的起始行号。

位置取自日志明确提供的信息。缺少位置时返回“日志未提供文件与行号”；Node 内置 `node:internal` 调用栈保留在原文中。

运行状态包括 `success`、`failed`、`running`、`cancelled`、`not_found`、`incomplete`、`permission_denied`、`query_failed` 和 `completed_without_error_log`；续读时另有 `changed`。`incomplete` 表示部分日志读取失败。取消的运行若包含失败任务，仍会返回对应错误。

## 读取范围与限制

读取失败、超时步骤的日志，通过 runner 的 group 与退出错误标记划分步骤。步骤边界缺失时，从 job 日志提取可识别的错误；错误块识别失败时返回原始日志。

网络读取每次超时 30 秒，瞬时网络故障和 HTTP 429/502/503/504 最多尝试 3 次，权限错误直接返回。单份日志最多读取 32 MiB，超出限制或日志过期时报告不可用。

## 验证

```sh
npm test
npm run check
```

测试覆盖错误原文、位置角色、Windows/Linux 路径、分页、运行选择，以及 MCP stdio 工具发现、调用与续读。样本包括公开 CI 的脱敏错误片段与完整失败步骤，`real-node24.txt` 覆盖 Node 24 的 spec 输出。实际 CI 验收结果见 [VERIFICATION.md](VERIFICATION.md)。
