# codearts-req-mcp-server

本地 **stdio** 类型的 MCP Server，封装华为云 **CodeArts 需求管理（CodeArts Req）** API，使用 **AK/SK + SDK-HMAC-SHA256** 签名鉴权。

- 服务名：`codearts-req`
- 传输方式：stdio（进程标准输入/输出，不监听端口）
- 运行时：Node.js（ESM）
- SDK：`@modelcontextprotocol/sdk`
- 工具：`create_project`、`list_projects`

## 功能

| 工具 | HTTP 请求 | 说明 |
| --- | --- | --- |
| `create_project` | `POST /v4/project` | 创建 CodeArts 需求项目 |
| `list_projects` | `GET /v4/projects` | 分页查询项目列表 |

服务不会在启动时因为缺少环境变量而退出。缺少配置或参数错误会以 `isError: true` 的结构化中文结果返回给 MCP 客户端，便于智能体自行修正。

## 目录结构

```text
codearts-req-mcp-server/
├── server.mjs                 # MCP Server、参数校验、签名、API 调用
├── package.json
├── package-lock.json
├── README.md
├── LICENSE
└── test/
    ├── signing.test.mjs       # 签名算法与固定测试向量
    ├── tools.test.mjs         # 参数校验、结果与错误处理
    └── mcp-server.test.mjs    # 真实 stdio + 本地 mock API 集成测试
```

## 环境要求

- Node.js **>= 18.17.0**（使用内置 `fetch`、`AbortController`、`node:test`）
- npm 9+（随 Node.js 安装即可）
- 已开通 CodeArts Req，并拥有创建/查询项目权限的华为云访问密钥（AK/SK）

## 安装

```bash
cd codearts-req-mcp-server
npm install
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CODEARTS_REQ_ENDPOINT` | 是 | CodeArts Req 终端节点，如 `https://projectman-ext.cn-north-4.myhuaweicloud.com` |
| `CODEARTS_REQ_AK` | 是 | 华为云访问密钥 AK |
| `CODEARTS_REQ_SK` | 是 | 华为云访问密钥 SK |

终端节点与区域有关。华北-北京四使用 `projectman-ext.cn-north-4.myhuaweicloud.com`，其他区域请从
[CodeArts Req 终端节点](https://support.huaweicloud.com/api-projectman/projectman_03_0003.html) 查询。

`CODEARTS_REQ_ENDPOINT` 可以写成完整 URL，也可以只写域名（服务会自动补 `https://`）：

```text
https://projectman-ext.cn-north-4.myhuaweicloud.com
projectman-ext.cn-north-4.myhuaweicloud.com
```

> AK/SK 等价于账号凭证，请通过环境变量或 MCP 客户端的 `environment` 注入，不要写入代码、README 或提交到 Git。

### Linux / macOS

```bash
export CODEARTS_REQ_ENDPOINT="https://projectman-ext.cn-north-4.myhuaweicloud.com"
export CODEARTS_REQ_AK="你的AK"
export CODEARTS_REQ_SK="你的SK"
```

### Windows PowerShell

```powershell
$env:CODEARTS_REQ_ENDPOINT = "https://projectman-ext.cn-north-4.myhuaweicloud.com"
$env:CODEARTS_REQ_AK = "你的AK"
$env:CODEARTS_REQ_SK = "你的SK"
```

## 启动

```bash
npm start
# 等价于
node server.mjs
```

服务启动后等待 MCP 客户端通过 stdin 发送 JSON-RPC 消息，不会在终端打印工具结果。直接运行后看不到输出是正常现象，请通过 MCP 客户端或 MCP Inspector 调试：

```bash
npx @modelcontextprotocol/inspector node server.mjs
```

## 码道配置

码道 IDE 与码道 CLI 的配置字段不同，请按使用的客户端选择。

### 码道 IDE：`mcp_settings.json`

码道 IDE 的项目级配置文件实际位于：

```text
<项目根目录>/.codeartsdoer/mcp/mcp_settings.json
```

也可以通过 **设置 → MCP 工具 → 配置 MCP** 打开该文件。配置示例：

```json
{
  "mcpServers": {
    "codearts-req": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "E:\\shiyan\\1-8\\codearts-req-mcp-server\\server.mjs"
      ],
      "cwd": "E:\\shiyan\\1-8\\codearts-req-mcp-server",
      "env": {
        "CODEARTS_REQ_ENDPOINT": "https://projectman-ext.cn-north-4.myhuaweicloud.com",
        "CODEARTS_REQ_AK": "你的AK",
        "CODEARTS_REQ_SK": "你的SK"
      },
      "disabled": false,
      "timeout": 60000
    }
  }
}
```

注意：

- 码道 IDE 使用 `stdio` 类型：`command` 是**字符串**，脚本路径放在 `args` 数组中，环境变量字段名是 `env`。
- `command` 建议写 Node.js 的绝对路径，可用 `where node` 查询；Windows 路径在 JSON 中写成 `\\` 转义形式，或使用正斜杠。
- 保存后等待 MCP 工具页显示服务已连接；如未生效，重启 IDE 或在该页面重启 MCP Server。

### 码道 CLI：`codearts_cli.jsonc`

项目级配置放在项目根目录的 `.codeartsdoer/codearts_cli.jsonc`；个人级配置放在
`~/.codeartsdoer/codearts_cli.jsonc`（Windows 为 `C:\Users\<用户名>\.codeartsdoer\`）。

```jsonc
{
  "mcp": {
    "codearts-req": {
      "type": "local",
      "command": [
        "node",
        "E:/shiyan/1-8/codearts-req-mcp-server/server.mjs"
      ],
      "environment": {
        "CODEARTS_REQ_ENDPOINT": "https://projectman-ext.cn-north-4.myhuaweicloud.com",
        "CODEARTS_REQ_AK": "你的AK",
        "CODEARTS_REQ_SK": "你的SK"
      },
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

保存并重启码道 CLI 后，执行 `/mcps` 查看 `codearts-req` 是否为 Enabled。

### 其他 MCP 客户端

使用常见 `mcpServers` 格式的客户端（命令与参数分开）可这样配置：

```json
{
  "mcpServers": {
    "codearts-req": {
      "command": "node",
      "args": [
        "E:/shiyan/1-8/codearts-req-mcp-server/server.mjs"
      ],
      "env": {
        "CODEARTS_REQ_ENDPOINT": "https://projectman-ext.cn-north-4.myhuaweicloud.com",
        "CODEARTS_REQ_AK": "你的AK",
        "CODEARTS_REQ_SK": "你的SK"
      }
    }
  }
}
```

## 工具说明

### `create_project`

创建项目，对应 `POST /v4/project`。

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `project_name` | string | 是 | 1-128 字符 |
| `project_type` | enum | 是 | `scrum` / `normal` / `xboard` / `basic` / `phoenix` / `ipd` |
| `description` | string | 否 | 项目描述 |
| `enterprise_id` | string | 否 | 企业项目 ID |
| `source` | string | 否 | 0-64 字符 |
| `template_id` | enum(integer) | 否 | `10001` / `10002` / `10003`；`project_type=ipd` 时必传 |

`template_id` 含义：

- `10001`：IPD-系统设备类
- `10002`：IPD-独立软件类
- `10003`：IPD-自运营软件/云服务类

成功返回示例：

```json
{
  "project_id": "2e76d6f0b2c5403796e36bf63c5d5561",
  "project_num_id": 708168641,
  "project_name": "demo-project",
  "project_type": "scrum",
  "user_num_id": 700145037
}
```

调用示例（MCP 客户端视角）：

```json
{
  "name": "create_project",
  "arguments": {
    "project_name": "demo-project",
    "project_type": "ipd",
    "description": "由 MCP 创建",
    "template_id": 10002
  }
}
```

### `list_projects`

查询项目列表，对应 `GET /v4/projects`。

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `offset` | integer | 否 | 默认 0，0-10000，且必须是 `limit` 的整数倍 |
| `limit` | integer | 否 | 默认 10，1-1000 |
| `search` | string | 否 | 按项目名称或描述模糊查询 |
| `project_type` | enum | 否 | `scrum` / `normal` / `xboard` |
| `sort` | string | 否 | 格式 `字段:方向`，方向 `asc`/`desc`，最多 4 组，逗号分隔 |
| `archive` | boolean | 否 | 是否归档 |
| `query_type` | enum | 否 | `domain_projects` / `absent` |

`sort` 的字段可使用 API 支持的项目字段，例如：

```text
name:asc
name:asc,created_on:desc
```

成功返回示例：

```json
{
  "projects": [
    {
      "project_id": "41bd3eab86544863b8fc92ffcd35e3c8",
      "project_name": "demo-project",
      "project_type": "scrum"
    }
  ],
  "total": 1
}
```

## 错误处理

所有错误都作为 MCP 工具结果返回：`isError: true`，`content[0].text` 为 JSON 字符串。服务不会静默吞错，也不会因为单次工具调用失败而退出。

| `error_code` | 触发条件 | 附加字段 |
| --- | --- | --- |
| `INVALID_ARGUMENTS` | 参数缺失、类型错误、枚举/范围/倍数/排序格式不合法 | `details`（逐条中文说明） |
| `MISSING_CONFIG` | 缺少 `CODEARTS_REQ_ENDPOINT` / `CODEARTS_REQ_AK` / `CODEARTS_REQ_SK`，或终端节点非法 | `missing`，必要时 `invalid` |
| API 原始 `error_code` | CodeArts Req 返回非 2xx | `error_msg`、`http_status` |
| `NETWORK_ERROR` | DNS、连接失败、TLS、超时等网络异常 | `detail` |
| `INTERNAL_ERROR` | 未预期的内部异常（兜底） | `detail` |

### `INVALID_ARGUMENTS`

```json
{
  "error_code": "INVALID_ARGUMENTS",
  "error_msg": "参数校验失败：offset：须为 limit（当前为 10）的整数倍",
  "details": [
    "offset：须为 limit（当前为 10）的整数倍"
  ]
}
```

### `MISSING_CONFIG`

```json
{
  "error_code": "MISSING_CONFIG",
  "error_msg": "配置缺失或无效：缺少环境变量 CODEARTS_REQ_ENDPOINT、CODEARTS_REQ_AK、CODEARTS_REQ_SK",
  "missing": [
    "CODEARTS_REQ_ENDPOINT",
    "CODEARTS_REQ_AK",
    "CODEARTS_REQ_SK"
  ]
}
```

### API 错误透传

CodeArts Req 返回 4xx/5xx 时，原始错误码和错误信息会原样透传，并补充 HTTP 状态码：

```json
{
  "error_code": "PM.00000001",
  "error_msg": "项目名称已存在",
  "http_status": 400
}
```

### `NETWORK_ERROR`

```json
{
  "error_code": "NETWORK_ERROR",
  "error_msg": "请求 CodeArts Req API 时发生网络异常，请检查网络、终端节点与代理设置",
  "detail": "connect ECONNREFUSED 127.0.0.1:443"
}
```

## AK/SK 签名说明

实现遵循华为云 API 签名指南的 `SDK-HMAC-SHA256`：

1. 构造 CanonicalRequest：HTTP 方法、CanonicalURI、CanonicalQueryString、CanonicalHeaders、SignedHeaders、SHA-256(RequestPayload)。
2. 构造 StringToSign：`SDK-HMAC-SHA256\n<X-Sdk-Date>\nSHA-256(CanonicalRequest)`。
3. 计算 `Signature = HexEncode(HMAC-SHA256(SK, StringToSign))`。
4. 发送 `X-Sdk-Date` 与 `Authorization`：

```text
Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=content-type;host;x-sdk-date, Signature=<签名>
```

实现细节：

- `X-Sdk-Date` 使用 UTC 格式 `YYYYMMDDTHHMMSSZ`，本地时钟与标准时间偏差超过 15 分钟会被网关拒绝。
- CanonicalURI **必须以 `/` 结尾**（例如签名 `/v4/project/`，实际请求 `/v4/project`）。
- 查询参数按 RFC 3986 编码（空格为 `%20`），按编码后的参数名升序排序；空值和 `false` 不会被丢弃。
- 固定签名 `content-type`、`host`、`x-sdk-date`；`host` 由 Node.js `fetch` 根据 URL 自动设置。
- 不跟随 HTTP 重定向，避免将签名请求转发到其他主机。

## 测试

```bash
npm test
```

当前共 53 个用例，使用 Node.js 内置 `node:test`，不访问真实华为云：

- **签名测试**：CanonicalQueryString、CanonicalURI、CanonicalHeaders、UTC 时间、固定 HMAC 测试向量。
- **工具测试**：创建/查询参数边界、`ipd` 模板约束、错误码透传、网络异常、超时、异常响应。
- **MCP 集成测试**：启动真实 stdio 子进程，通过官方 MCP Client 执行 `tools/list` 与 `tools/call`，用本地 HTTP 服务验证方法、路径、查询参数、请求体、签名头和错误恢复；测试侧会独立重算 `Authorization` 签名，校验实际发出的 host、路径、查询串和请求体。

## 常见问题

### 工具返回 `MISSING_CONFIG`

MCP 客户端启动子进程时不会自动继承你终端里临时 `export` 的变量。请在码道 IDE 配置的 `env`（码道 CLI 为 `environment`）中显式写入三个变量，或在启动 MCP 客户端前设置系统环境变量。

### 返回 401 / `APIG.0301`

- 检查 AK/SK 是否正确、是否已启用。
- 检查本机时间是否准确（签名有效期通常为 15 分钟）。
- 检查终端节点区域是否与账号/项目区域一致。

### 返回 `PM.02100546` / “该企业租户服务处于关闭状态”

说明当前企业租户未开通 CodeArts Req 服务。AK/SK 和签名可能已经正确，但业务层拒绝创建项目。请前往华为云控制台开通/购买 CodeArts 套餐（其中包含需求管理服务），开通后重试。参见
[官方 FAQ](https://support.huaweicloud.com/intl/zh-cn/projectman_faq/projectman_02_0014.html)。

### 返回 403

AK/SK 对应的 IAM 用户或委托缺少 CodeArts Req 项目创建/查询权限。请在 IAM 中补充相应权限后重试。

### 返回 404 或连接失败

- 确认 `CODEARTS_REQ_ENDPOINT` 使用 CodeArts Req 的终端节点，例如 `projectman-ext.cn-north-4.myhuaweicloud.com`。
- 确认 URL 使用 `https://`，且没有多余路径、查询参数。
- 如果使用代理，请确认运行 Node.js 的网络环境能访问该终端节点。

### `offset` 报“须为 limit 的整数倍”

分页偏移量必须从 0 开始按页大小递增，例如 `limit=10` 时 `offset` 只能是 `0`、`10`、`20`……

### 码道中服务启动失败

- 先在本机执行 `node server.mjs`，确认没有模块缺失；若缺少模块，在项目目录执行 `npm install`。
- 使用 Node.js 的**绝对路径**，例如 `C:\\Program Files\\nodejs\\node.exe`。
- 确认码道 IDE 的 `type`、`command`、`args`、`env` 字段，或码道 CLI 的 `type`、`command`、`environment` 字段拼写正确，保存后重启客户端。
- Windows 路径中的反斜杠必须转义，或改用 `/`。

## 参考文档

- [创建项目 - CreateProjectV4](https://support.huaweicloud.com/api-projectman/CreateProjectV4.html)
- [查询项目列表 - ListProjectsV4](https://support.huaweicloud.com/api-projectman/ListProjectsV4.html)
- [CodeArts Req 终端节点](https://support.huaweicloud.com/api-projectman/projectman_03_0003.html)
- [华为云 API 签名认证机制](https://support.huaweicloud.com/devg-apisign/api-sign-algorithm-001.html)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

MIT
