# 公网节点发现协议（public-node v2）

本文是 `@winlin926/dsh-remote-connect` 的**协议规范**：用户只填一个 HTTPS 地址，插件探测它背后是哪一种节点、身份是谁。实现必须与此文档逐字段一致；服务端（`remote-server` 与隧道网关）照本文第 2、10 节实现即可与插件互通。

自 0.6.2 起定义 v2 契约（`protocol: 2`），并保留 v1（`protocol: 1`）兼容规则。新插件同时接受 v1/v2 节点；v1 节点按旧规则处理。

```text
                 GET https://node.example.com/.well-known/dsh-remote
   插件 ─────────────────────────────────────────────────────────▶ 节点
        ◀─────────────────────────────────────────────────────────
             200 application/json; charset=utf-8, cache-control: no-store
             { protocol: 2, kind, name, version, capabilities,
               node: { id, fingerprint, publicKey } }
```

## 1. 概念与范围

- **公网节点（public node）**：一个 HTTPS **origin**（`https://host[:port]`）加一份发现文档。插件只持久化 origin，绝不持久化路径、查询串、锚点或账号密码。
- **节点身份（node identity）**：这个 origin 背后那台服务器的身份，用 Ed25519 公钥表示，跨重启稳定。发现文档的 `node.id`、`node.fingerprint`、`node.publicKey` 同属节点身份。
- **主机身份（host identity）**：一台运行 DSH 的电脑的身份，同样由 Ed25519 公钥表示（见第 8 节）。
- **kind = `gateway`**：该域名经隧道（如 frp）指向用户本机的 DSH 网关。网关与用户设备在同一台电脑上，节点身份复用主机身份。
- **kind = `service`**：自托管的 `remote-server`，由服务方机器提供网关/中继能力。一个服务节点可以被多台主机共用，节点身份与任何主机身份无关。
- 两种节点返回**相同形状**的 v2 文档，调用方不需要为两种类型写两套解析。
- 保留 v1 兼容：新插件继续接受 v1 网关；v1 服务节点按「单主机旧模式」处理。
- 公网配对不使用短码、不使用密码、不使用账号。

非目标：端到端加密、WebRTC/TURN、发行方默认公共服务、多实例/高可用。

**信任边界（必须写进界面与文档）**：HTTPS/WSS 只保护手机到节点、主机到节点这两段传输。**终止 HTTPS 的节点或隧道运营者可能看到转发的请求与内容**；本插件不提供端到端加密。发行方不托管任何节点。

## 2. 发现端点

| 项目 | 值 |
| --- | --- |
| 方法 | `GET`（客户端只用 GET） |
| 路径 | `/.well-known/dsh-remote`，**精确匹配、区分大小写、无尾斜杠** |
| 请求头（客户端发送的全部） | `accept: application/json` |
| 请求体 | 无 |
| Cookie | 客户端不发送（`credentials: "omit"`）；服务端不得要求或依赖 Cookie |
| Referer | 客户端不发送（`referrerPolicy: "no-referrer"`）；服务端不得依赖 |
| 认证 | **无**。这是公开发现端点，未配对设备、未登录浏览器都必须能读 |
| 重定向 | **禁止**。服务端不得对发现路径返回 3xx（含同 origin 重定向）；客户端把任何 3xx 视为失败 |
| 缓存 | `cache-control: no-store` |
| 超时 | 客户端 5 秒（可配置，默认 5000 ms） |
| 响应状态 | 只接受 `200`。其他状态码 → `bad-response` |

鉴权、设备列表、配对状态、端口、内部路径、构建路径**一律不得出现在响应里**，也不得通过响应头泄露。发现端点只回答「我是谁」。注册信息查询、邀请接口、管理接口都不得挂在发现路径下。

### 2.1 v2 成功响应

必须恰好是一个 JSON 对象，UTF-8 编码。

网关（`kind: "gateway"`）：

```json
{
  "protocol": 2,
  "kind": "gateway",
  "name": "DeepSeek Harness",
  "version": "0.6.2",
  "capabilities": ["pairing", "cache", "official-ui"],
  "node": {
    "id": "g7iflg32huZJkCXpOeWlLfYIOgAkPLcCyVIU-e2Un_Q",
    "fingerprint": "83b89f960df686e6499025e939e5a52d",
    "publicKey": "MCowBQYDK2VwAyEAsjRRZlO6GiXrf2MrTLiWC9vXXgI3LKzF5LFTsHlHjcQ"
  },
  "hostId": "g7iflg32huZJkCXpOeWlLfYIOgAkPLcCyVIU-e2Un_Q",
  "fingerprint": "83b89f960df686e6499025e939e5a52d"
}
```

服务（`kind: "service"`）：

```json
{
  "protocol": 2,
  "kind": "service",
  "name": "我的节点",
  "version": "0.6.2",
  "capabilities": ["pairing", "cache", "official-ui"],
  "node": {
    "id": "Di6lw5vsvhdLKYAG4LFOoPgX6mIfMoYOQ2Tz3oECWs0",
    "fingerprint": "0e2ea5c39becbe174b298006e0b14ea0",
    "publicKey": "MCowBQYDK2VwAyEA…"
  }
}
```

- 字段顺序无意义，客户端不依赖顺序。
- **未知字段忽略**（为向前兼容），但本文列出的字段一个都不能错。
- 重复的 `capabilities` 项在客户端去重（保留首次出现的顺序），不算失败。
- 网关为兼容 ≤0.6.1 客户端，**同时**保留扁平 `hostId`/`fingerprint`（同值，旧字段）；新客户端在 `protocol: 2` 下忽略扁平字段。
- 服务节点**不得**带扁平 `hostId`/`fingerprint`：一个节点对应多台主机，扁平字段无法如实表达。

### 2.2 字段定义

所有字段均为**必填**。类型、长度、大小写按表执行：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `protocol` | number | 必须**等于数字 2**（不是 `"2"`） | 协议版本。客户端拒绝其它值，不做兼容猜测；升版即破坏性变更。 |
| `kind` | string | 精确小写 `"gateway"` 或 `"service"` | 节点类型。大小写敏感，不接受其他拼写。 |
| `name` | string | 1–64 个 **Unicode 码点**；不得含 C0 控制符（U+0000–U+001F）或 DEL（U+007F） | 人类可读名称，仅用于展示，**不参与身份判断**。gateway 固定用 `DeepSeek Harness`（不暴露计算机名）。 |
| `version` | string | 正则 `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$`，即 1–32 个 ASCII 字符，首字符为字母或数字 | 节点**软件**版本（不是协议版本），semver 可直接使用，如 `0.6.2`、`1.2.0-rc.3`。 |
| `capabilities` | string[] | 非空数组；每项精确小写、取值必须属于 `pairing` `cache` `official-ui` `relay` `turn`；元素唯一；**必须包含 `"pairing"`** | 节点能力广告；未知能力即失败（新增能力必须升 protocol）。见 2.3。 |
| `node` | object | v2 必填；`node` 缺失或任一子字段非法即 `bad-identity` | 节点身份，见 2.4。 |
| `node.id` | string | 正则 `^[A-Za-z0-9_-]{43}$`，**恰好 43 个字符** | `base64url(sha256(SPKI DER))`，无 `=` 填充。 |
| `node.fingerprint` | string | 正则 `^[a-f0-9]{32}$`，**恰好 32 个字符** | 同一摘要**前 16 字节**的小写十六进制，给用户人工核对。 |
| `node.publicKey` | string | `base64url(SPKI DER)`，Ed25519，40–120 字符 | 客户端必须解码为 SPKI 公钥，并验证 `sha256(DER)` 同时等于 `node.id` 与 `node.fingerprint`，不一致即 `bad-identity`。 |

v1 文档的扁平 `hostId`/`fingerprint` 字段规则保持不变：`hostId` 为 43 字符 `^[A-Za-z0-9_-]{43}$`，`fingerprint` 为 32 字符 `^[a-f0-9]{32}$`。

### 2.3 能力语义

| 能力 | 必填 | 语义 |
| --- | --- | --- |
| `pairing` | **是** | 节点支持设备配对/授权。缺少它的节点不可用。 |
| `cache` | 否 | 节点提供带 `rev` 的可缓存静态资源，并按 `hid`/`rev` 正确分区。 |
| `official-ui` | 否 | 节点提供官方 DSH 界面外壳（gateway 通常有）。 |
| `relay` | 否 | 节点能中继设备流量（自托管 service 常见）。 |
| `turn` | 否 | 节点提供 TURN 服务用于 WebRTC 中继。 |

节点只能广告**实际实现**的能力，不能为了「看起来完整」而填。0.6.2 的两类节点**只允许宣告** `pairing`、`cache`、`official-ui`；`relay`/`turn` 保留在白名单里供将来使用，本轮不得宣告。

### 2.4 身份来源

- **网关**：复用主机身份（`<DSH_HOME>/dsh-remote-connect/<profile>/host-identity.json`），`node.*` 与宿主 `hostId`/`fingerprint` 同值。为兼容 ≤0.6.1 客户端，网关的 v2 文档同时保留扁平 `hostId`/`fingerprint`（同值，旧字段）。
- **服务**：节点自己在数据目录生成并持久保存节点密钥（`node-identity.json`，`0600`、临时文件 + `rename` 原子写、Ed25519），与任何主机身份无关；多台主机注册不改变节点指纹；服务节点的 v2 文档不得带扁平 `hostId`/`fingerprint`。
- 服务节点在**启动时就有身份**，不再像 v1 那样在首台主机注册前返回占位身份。

节点身份文件（服务节点）：

```json
{
  "version": 1,
  "algorithm": "ed25519",
  "publicKey": "<Ed25519 公钥 SPKI DER 的 base64url，无填充>",
  "privateKey": "<Ed25519 私钥 PKCS#8 DER 的 base64url，无填充>",
  "createdAt": "2026-11-16T00:00:00.000Z"
}
```

- 路径：`<DATA_DIR>/node-identity.json`（`remote-server` 的 `DATA_DIR`；compose 部署时为数据卷内的 `/data/node-identity.json`）。不单独提供路径环境变量。
- 首次启动时生成，之后只读；**文件损坏即启动失败**，不静默重建——重建会改变节点指纹，必须由运营者显式处理。
- 私钥永不离开节点、永不出现在发现响应、日志或配置中；发现文档只返回 `publicKey` 与派生值。
- 节点指纹展示统一格式：32 位小写十六进制分组为 8 组 4 位大写，用 `-` 连接（与主机指纹一致），如 `83B8-9F96-0DF6-86E6-4990-25E9-39E5-A52D`。

## 3. v1 兼容规则

新插件（0.6.2）的检测结果分三种：

| 文档 | 处理 |
| --- | --- |
| `protocol: 1` + `kind: gateway` | 沿用 v1 规则（必须有扁平 `hostId`/`fingerprint`），记录 `protocol: 1`、`node: null`。一切行为与 0.6.1 相同。 |
| `protocol: 1` + `kind: service` | v1 服务节点：单主机旧模式。`hostId`/`fingerprint` 是该节点首台主机的身份，只对这一台主机有意义；界面标注「旧版 v1（单主机）」。`protocol` 记 1。 |
| `protocol: 2` | 按第 2、4 节校验 `node`；`node` 缺失或自校验失败即 `bad-identity`。 |

其它版本（`0`、`3`…）→ `bad-protocol`。

- v1 客户端（≤0.6.1）访问 v2 服务节点会因缺少扁平 `hostId` 被拒绝，这是接受的边界，写进文档；v2 网关保留扁平字段，因此旧客户端仍可添加网关节点。
- 新插件不因为节点是 v1 就降低自身安全要求；v1 节点照旧走原配对流程。
- 注册接口对 v1/v2 节点都是 `POST /v1/hosts`，请求体不变；节点身份不通过注册接口传递。

## 4. 客户端检测算法（`detectPublicNode`）

输入：用户填写的字符串或 `URL`。输出：成功 `{ ok: true, node }` 或失败 `{ ok: false, code, message }`。**永不抛异常**，任何失败都以数据返回。

1. **地址规范化**：`trim` 后 `new URL()`。失败 → `bad-url`。
2. **仅 HTTPS**：`protocol !== "https:"` → `not-https`。
3. **只允许 origin**：`username`/`password` 非空、`pathname !== "/"`、`search` 非空、`hash` 非空 → 全部 `bad-url`。`https://node.example.com`、`https://node.example.com/`、`https://node.example.com:8443` 合法；规范化结果分别为 `https://node.example.com`、`https://node.example.com`、`https://node.example.com:8443`。
4. 请求 `GET <origin>/.well-known/dsh-remote`，`redirect: "manual"`、`credentials: "omit"`、`cache: "no-store"`、`referrerPolicy: "no-referrer"`、仅 `accept: application/json` 头、`AbortSignal` 5 秒超时。
5. 响应分类：`opaqueredirect` 或 `300 ≤ status < 400` → `redirect`；`status !== 200` → `bad-response`。
6. **解析与逐字段校验**（顺序固定，先命中先返回）：
   1. 不是 JSON 对象 → `bad-response`
   2. `protocol` 不是数字 → `bad-protocol`
   3. `protocol === 1`：沿用 v1 校验（`kind` → `bad-kind`；`name`/`version` → `bad-response`；`capabilities` → `bad-capability`；扁平 `hostId`/`fingerprint` → `bad-identity`），记录 `protocol: 1`、`node: null`，流程结束。
   4. `protocol !== 2` → `bad-protocol`
   5. `kind` 非法 → `bad-kind`
   6. `name` 非法 → `bad-response`
   7. `version` 非法 → `bad-response`
   8. `capabilities` 非数组、空、含白名单外能力或缺 `pairing` → `bad-capability`
   9. `node` 缺失、非对象或字段类型错误 → `bad-identity`
   10. `node.id` 不符合长度/字符集 → `bad-identity`
   11. `node.fingerprint` 不符合长度/字符集 → `bad-identity`
   12. `node.publicKey` 无法解码为 Ed25519 SPKI，或 `sha256(DER)` 与 `node.id`/`node.fingerprint` 任一不符 → `bad-identity`
7. 传输层异常：证书/TLS 类（`CERT`、`TLS`、`SSL`、`SELF_SIGNED`、`UNABLE_TO_VERIFY`、`DEPTH_ZERO`、`ALTNAME`、`HOSTNAME_MISMATCH`，沿 `error.cause` 链最多 4 层）→ `bad-tls`；其余（DNS、拒绝连接、超时）→ `unreachable`。

在 `protocol: 2` 下，服务文档里出现扁平 `hostId`/`fingerprint` 应按「未知字段忽略」处理，不参与校验；网关文档的扁平字段也不用于身份判断。

### 4.1 错误码

`code` 稳定、供程序分支；`message` 是中文人类提示，可能调整，不应被程序匹配。

| code | 触发条件 |
| --- | --- |
| `not-https` | 地址不是 `https:` |
| `bad-url` | 地址无法解析、为空、带账号密码、带路径/查询/锚点 |
| `unreachable` | DNS/连接失败、超时（5 秒） |
| `redirect` | 发现请求返回任何 3xx |
| `bad-tls` | TLS 握手或证书校验失败（自签、过期、域名不匹配等） |
| `bad-protocol` | `protocol` 不是数字 1 或 2 |
| `bad-kind` | `kind` 不是 `gateway`/`service` |
| `bad-capability` | `capabilities` 形状错误、含未知能力或缺 `pairing` |
| `bad-identity` | v1 扁平 `hostId`/`fingerprint` 非法；v2 `node` 缺失、字段非法、公钥无法解码或 sha256 自校验不符 |
| `bad-response` | 非 200、非 JSON 对象、`name`/`version` 非法 |

## 5. 网关侧实现要求（本仓库）

- `src/gateway.ts` 在 `handle()` 中于 `safePath` + `validHost` 校验**之后**、ACME 与全部配对逻辑**之前**处理：
  - 仅当 `url.pathname === "/.well-known/dsh-remote"` 时进入；
  - 方法不是 `GET`/`HEAD` → `405`（JSON 错误体）；
  - `options.discovery` 未注入 → `404`；
  - 成功：`200`，头固定为 `content-type: application/json; charset=utf-8`、`cache-control: no-store`、`referrer-policy: no-referrer`、`x-content-type-options: nosniff`、`content-length`（实际字节数）；`HEAD` 只发头不发 body。
- **安全理由**：端点必须在配对校验之前（否则未配对设备永远无法发现节点），但必须：
  1. 保留 `safePath`/`validHost`（Host 头白名单）检查——否则可被 DNS rebinding 利用；
  2. 只放行**这一个精确路径**的 `GET`/`HEAD`，不匹配前缀、不接受其他方法——不能成为绕过配对去读 `/rc/*`、`/api/*` 或代理路径的口子；
  3. 响应体只含本文第 2 节的公开字段，不含设备、端口、内部路径。
- 公网与局域网网关都必须响应；`kind` 由调用方注入（网关注入 `"gateway"`）。网关的节点身份就是本机主机身份：`node.*` 取自 `host-identity.json` 的派生值，同时保留扁平 `hostId`/`fingerprint`。
- 端点不检查 Cookie、不写 Cookie、不要求配对。

## 6. 本地节点记录（`public-nodes.json` v2）

路径：`<DSH_HOME>/dsh-remote-connect/<profile>/public-nodes.json`，Mode `0600`，**原子写**（临时文件 + `rename`）。文件损坏必须报错，不得静默重建或丢弃节点。

文件版本升为 `2`：

```json
{
  "version": 2,
  "current": "<record id> | null",
  "nodes": [
    {
      "id": "<record id>",
      "url": "https://node.example.com",
      "kind": "service",
      "name": "我的节点",
      "version": "0.6.2",
      "protocol": 2,
      "capabilities": ["pairing", "cache", "official-ui"],
      "node": { "id": "…", "fingerprint": "…", "publicKey": "…" },
      "hostId": null,
      "fingerprint": null,
      "addedAt": 1763000000000,
      "lastCheckAt": 1763000000000,
      "lastCheckOk": true,
      "lastCheckError": null,
      "pending": false,
      "identityChange": null
    }
  ]
}
```

顶层字段：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `version` | number | 必须为 `2` |
| `current` | string \| null | 当前选中节点的 `id`；加载时若指向不存在的 `id`，归一为 `null`（不报错、不崩溃） |
| `nodes` | array | 节点数组，`id` 不得重复；重复视为文件损坏 |

节点字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 1–64 字符，UUID 即可；创建后不变 |
| `url` | string | 规范化后的 HTTPS origin（规则同第 4 节第 1–3 步）；存储时再次规范化 |
| `kind` | `"gateway"` \| `"service"` \| null | 探测结果 |
| `name` | string \| null | 1–64 码点，同 2.2 |
| `version` | string \| null | 同 2.2 的 `version` 正则 |
| `protocol` | number \| null | 探测成功时为 `1` 或 `2` |
| `capabilities` | string[] \| null | 白名单子集；非 `null` 时必须包含 `"pairing"`；探测成功后按响应原样保存 |
| `node` | object \| null | v2 节点身份；v1 记录为 `null`。形状同发现文档的 `node` |
| `hostId` | string \| null | 仅 v1 记录填充；v2 记录保持 `null`（服务节点不允许出现；网关记录也不写扁平副本，避免两处真相） |
| `fingerprint` | string \| null | 仅 v1 记录填充；v2 记录保持 `null` |
| `addedAt` | number | Unix 毫秒时间戳 |
| `lastCheckAt` | number \| null | 最近一次探测时间（Unix 毫秒）；从未探测为 null |
| `lastCheckOk` | boolean | 最近一次探测是否成功；从未探测为 `false` |
| `lastCheckError` | string \| null | 最近一次失败的中文原因；成功或未探测为 null |
| `pending` | boolean | `true` 表示尚未探测。迁移来的候选节点恒为 `true`，探测成功后写回 `false` |
| `identityChange` | object \| null | `null` 或 `{ "from": { "id": "…", "fingerprint": "…" }, "to": { "id": "…", "fingerprint": "…" }, "detectedAt": <ms> }`。存在时该节点**不可设为当前、不参与连接**，直到用户确认 |

迁移与状态规则：

1. 读取 `version: 1` 文件：逐条转换，`node` 补 `null`，其余字段原样保留（`current`、`pending`、检测结果、`addedAt` 都不丢），内存中按 v2 使用，下一次写入时落盘为 `version: 2`。
2. 首次遇到 v2 发现文档、而记录 `node` 为 `null`：**静默采纳**节点身份（写入 `node`、`protocol: 2`），不算「身份变化」，不需要用户确认——v1 记录此前没有节点身份可比。
3. 记录已有 `node`，检测到不同的 `node.id`：不覆盖旧身份；写 `identityChange`，`lastCheckOk: false`、`lastCheckError` =「节点身份已变化，需要重新确认。」；若该记录是 `current`，保持 `current` 但禁止连接，面板显示待确认。
4. 用户确认（`manage` 动作 `confirmPublicNodeIdentity{id}`）：采纳 `identityChange.to`，清空 `identityChange`，重新检测一次；不删除设备授权、不删除服务凭据、不删除缓存索引，也不要求手机重新配对。
5. 已确认的 v2 记录若检测到 `protocol: 1`（节点降级）：不自动降级。保留 `node` 与 `protocol: 2`，置 `lastCheckOk: false`、`lastCheckError` =「节点已降级为旧版协议，需要重新检测。」，面板提示重新检测；不删除记录、不改 `current`。
6. 删除节点：沿用 0.6.1（先尽力 `DELETE /v1/hosts/:hostId`，失败不阻断，删本地记录与缓存索引）。
7. 切换节点：旧节点授权与缓存保留；新节点需扫码配对，不迁移设备授权（不变）。

**损坏语义**：JSON 解析失败、`version` 不是 1/2、节点字段非法、`id` 重复 → 抛错（含文件路径），不自动修复。

API（`PublicNodeConfig`）：`current`（getter）、`list()`、`add(input)`、`update(id, patch)`、`remove(id)`、`setCurrent(id | null)`。`remove` 返回 `{ origin, hostId }`（`hostId` 可能为 `null`），调用方据此清理该节点的缓存索引；删除当前节点会把 `current` 置 `null`。身份确认通过 `manage` 动作 `confirmPublicNodeIdentity{id}` 暴露给面板。

## 7. 配对

- 不做短码：手机页、面板确认页都不得显示或要求比较 8 位码。`verificationCode` 只作为 v1 传输字段保留在 `pair.request` 帧里供旧 Host/旧节点互通，新页面与新授权逻辑不读取、不显示、不参与判定。
- 手机配对页展示：节点名称、节点类型（隧道网关/自托管服务）、**目标主机指纹**（8 组 4 位大写十六进制，来自二维码里的 `key`，本地计算，不经节点转发）、「确认是本机」按钮。
- 电脑确认页展示：请求设备名、**本机主机指纹**（8 组 4 位大写）、「批准」/「拒绝」。
- 授权条件：手机确认 + 电脑批准 + 指纹一致，三者缺一不可；任一端拒绝、票据过期、重放（同一票据二次 claim）都不得产生设备授权。
- 二维码参数保持现状：`https://<origin>/#v=1&ticket=<43 位>&key=<host SPKI DER base64url>`；`v` 是页面票据格式版本，与节点协议版本无关，本轮不升。
- 通过 v2 网关配对与通过 v2 服务节点配对使用同一套双端确认；旧版节点仍按 v1 配对流程处理。

## 8. 主机身份（`host-identity.json`）

路径：`<DSH_HOME>/dsh-remote-connect/<profile>/host-identity.json`，Mode `0600`，原子写（临时文件 + `rename`），**首次使用时生成，之后幂等**。

```json
{
  "version": 1,
  "algorithm": "ed25519",
  "publicKey": "<Ed25519 公钥 SPKI DER 的 base64url，无填充>",
  "privateKey": "<Ed25519 私钥 PKCS#8 DER 的 base64url，无填充>",
  "createdAt": "2026-11-16T00:00:00.000Z"
}
```

- 算法固定 `ed25519`。公钥导出 `spki` DER，私钥导出 `pkcs8` DER，均用 base64url（无 `=`）。
- 加载时校验：字段形状、算法、私钥可导出公钥且与存储的 `publicKey` 完全一致。
- **文件损坏（JSON 坏、字段缺失、公私钥不一致、无法解析）→ 抛错，不静默重建**：身份变化会让所有配对与缓存失效，必须由用户显式处理。
- 派生（只依赖**公钥 SPKI DER** 的 sha256）：
  - `hostId = base64url(sha256(SPKI DER))`，恰好 43 字符；
  - `fingerprint = sha256(SPKI DER) 前 16 字节的小写十六进制`，恰好 32 字符；
  - `fingerprintGroups`：`fingerprint` 大写后每 4 位一组、`-` 连接，共 8 组，如 `E502-9063-F548-29C6-39DA-C06E-7A3D-E8CD`。
- 私钥永不离开本机、永不出现在发现响应、日志或配置中。
- 同一 profile 的网关共享该文件即共享 `hostId`；不同主机必须各自生成。
- 网关节点身份即主机身份；服务节点的节点身份另行生成，见 2.4。

## 9. Host 注册（服务节点）

- 删除 `HOST_REGISTRATION_TOKEN`：`remote-server` 的配置项、`x-host-registration-token` 头校验、`.env.example` 条目、部署文档与相关测试全部移除。
- `POST /v1/hosts` 默认开放，保留现有注册限流（同源/同 IP 的频率与并发上限）与输入校验（`identityKey` 必须是合法 SPKI DER）。
- 注册本身不授予任何访问权：注册只产生该主机自己的凭据；设备会话、关系、配对票据都按 `host_id` 隔离；任何 Host 凭据都不能读写其它 Host 的资源或隧道。
- 同一 `identityKey` 重复注册的现有语义（409 `HOST_ALREADY_REGISTERED` / `IDENTITY_IN_USE`）保持不变。

## 10. 服务端实现清单（remote-server）

1. 启动时读取 `<DATA_DIR>/node-identity.json`；不存在则生成（Ed25519、`0600`、临时文件 + `rename` 原子写），存在则只读。文件损坏 → 启动失败，不重建。
2. 在认证、配对、会话逻辑**之前**注册精确路由 `GET|HEAD /.well-known/dsh-remote`；其他方法返回 `405`。
3. 返回 v2 `kind: "service"` 文档：`protocol: 2`、`node` 三项齐全、**不带**扁平 `hostId`/`fingerprint`；`200`、`application/json; charset=utf-8`、`cache-control: no-store`、`content-length`；不允许 3xx。
4. `/healthz` 返回 `200 {ok:true,version}`；`/v1/config` 返回公开配置（`protocol`、`kind`、`name`、`version`、`capabilities`），不含密钥。
5. `POST /v1/hosts` 无令牌、默认开放；保留限流与 SPKI DER 校验；注册只产生该主机自己的凭据。
6. `DELETE /v1/hosts/:hostId`（Host Bearer）注销自己并级联清理；`npm run admin:reset -- <hostId>` 保留为运维兜底。
7. `web/index.html` 配对页不显示 8 位比较码；`pair.request` 帧仍可携带 `verificationCode` 作 v1 传输兼容，页面与新判定逻辑不读取。
8. 响应体只含公开字段；不返回设备列表、端口、内部路径、配对状态、构建信息。
9. 该端点**不校验** Cookie、Authorization、Referer；不得写入 Cookie。
10. 5 秒内必须响应；发现请求不跟随重定向，服务端也不要依赖重定向。
11. 未配对设备访问发现路径必须成功；访问其他路径仍按原规则拒绝。

## 11. 缓存键规则

- **浏览器缓存按 origin 天然隔离**：不同 origin 的响应不会互相命中，插件无需为此做任何事。
- **同一 origin 多 Host**（一个 service 前置多个 Host）靠 `hid=hostId` 区分：资源 URL 必须带当前 Host 的 `hostId`。
- **同一 Host 的版本**靠 `rev` 区分：`rev` 为 1–64 位 `[A-Za-z0-9_-]` 的构建/清单版本。
- 规范形状：`https://origin/path?hid=<hostId>&rev=<rev>`；纯函数 `cacheScope({ origin, hostId, rev })` 返回 `{ origin, hid, rev, query: "hid=<hostId>&rev=<rev>", key: "<origin>?<query>" }`。
- 宿主生成的资源 URL 已自带 `rev`（如 `.../client.js?rev=batch`）；插件不重写资源 URL，只在需要构造缓存键时调用 `cacheScope`。仓库内不存在跨 Host 复用同一缓存键的代码路径。
- 不引入 Service Worker，不预下载前端，不改宿主模块加载器的重试/去重/回退职责；本协议只提供**分区规则**，缓存由浏览器与宿主负责。

## 12. 面板与文案

节点列表每行展示：节点名称、HTTPS 地址、类型（隧道网关/自托管服务）、**节点指纹**（8 组 4 位大写）、协议版本（`v2` / 「旧版 v1（单主机）」）、最近检测时间、在线状态、当前使用标记；`identityChange` 存在时额外显示「节点身份已变化，需要重新确认」与「重新确认」按钮。

添加节点确认区固定文案：

> 通过 HTTPS 连接该节点。节点或隧道运营者可能看到转发给本机的请求与内容，本插件不提供端到端加密。请只添加你信任的节点。

节点指纹展示统一格式：32 位小写十六进制分组为 8 组 4 位大写，用 `-` 连接（与主机指纹一致）。

## 13. 一致性与测试要求

- 插件侧：v2 网关/服务文档解析；`node` 与 `publicKey` 自校验；未知协议、缺 `node`、指纹不符、能力缺失全部拒绝；v1 网关、v1 服务（单主机）仍可检测并记录且 `protocol` 字段正确。
- 插件侧：记录迁移（v1 文件 → v2 内存 → 采纳 v2 身份不要求确认）；身份变化写 `identityChange` 且 `current` 仍指向该记录；`confirmPublicNodeIdentity` 后清空并可连接；降级检测不删除记录；切换节点不串授权/缓存；删除节点仍触发撤销；面板显示节点指纹与信任文案，`identityChange` 时「设为当前」被禁用。
- 服务端：节点身份跨重启稳定（同一 `node-identity.json`）；两台主机注册后 `/.well-known/dsh-remote` 的 `node` 不变；v1 模式（未升级）仍返回旧结构。
- 服务端：两个 Host 的凭据、设备、资产、隧道互不可见；A 的凭据访问 B 的资源返回 403/404；`pair.request` 仍带 `verificationCode`（兼容）但 web 配对页不再显示；双端确认、拒绝、过期、重放全部覆盖；未配置注册令牌即可注册；限流生效（第 N 次注册 429）。
- 集成：`tsc`/`build`/全量测试、Compose 配置校验、镜像构建、本机启动冒烟、浏览器只跑节点设置与自托管配对。

## 14. 兼容性

- `protocol` 升级 = 破坏性变更；客户端遇到非 `1`/`2` 直接失败，不做降级猜测。v1 客户端（≤0.6.1）无法添加 v2 服务节点；v2 网关保留扁平字段，旧客户端仍可添加网关节点。
- 响应中**多出的字段被忽略**，服务端可先行添加新字段（但新能力必须等待 protocol 升级）。
- 未知 `capabilities` 项导致客户端拒绝，因此能力白名单只能随 protocol 升版扩展。
- 文档版本：v2（`protocol: 2`）；v1 规则见第 3 节。本文档随 0.6.2 发布：插件 `version` 与 `remote-server` 的 `nodeVersion` 均为 `0.6.2`。
