# 公网节点发现协议（public-node v1）

本文是 `@winlin926/dsh-remote-connect` 的**协议规范**：用户只填一个 HTTPS 地址，插件探测它背后是哪一种节点。实现必须与此文档逐字段一致；服务端（remote-server）照本文第 2、7 节实现即可与插件互通。

```text
                 GET https://node.example.com/.well-known/dsh-remote
   插件 ─────────────────────────────────────────────────────────▶ 节点
        ◀─────────────────────────────────────────────────────────
             200 application/json; charset=utf-8, cache-control: no-store
             { protocol, kind, name, version, capabilities, hostId, fingerprint }
```

## 1. 概念与范围

- **公网节点（public node）**：一个 HTTPS **origin**（`https://host[:port]`）加一份发现文档。插件只持久化 origin，绝不持久化路径、查询串、锚点或账号密码。
- **kind = `gateway`**：该域名经隧道（如 frp）指向用户本机的 DSH 网关。网关与用户设备在同一台电脑上，`hostId` 就是本机主机身份。
- **kind = `service`**：自托管的 remote-server，由服务方机器提供网关/中继能力。
- 两种节点返回**完全相同形状**的文档，调用方不需要为两种类型写两套解析。本阶段只定义发现协议；配对流程、传输层、面板 UI 不在本文范围。

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

鉴权、设备列表、配对状态、端口、内部路径、构建路径**一律不得出现在响应里**，也不得通过响应头泄露。发现端点只回答「我是谁」。

### 2.1 成功响应

必须恰好是一个 JSON 对象，UTF-8 编码：

```http
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: no-store
content-length: 231
```

```json
{
  "protocol": 1,
  "kind": "gateway",
  "name": "DeepSeek Harness",
  "version": "0.5.1",
  "capabilities": ["pairing", "official-ui"],
  "hostId": "5QKQY_VIKcY52sBuej3ozcSh4gUAwAYe0YENr18qsfA",
  "fingerprint": "e5029063f54829c639dac06e7a3de8cd"
}
```

- 字段顺序无意义，客户端不依赖顺序。
- **未知字段忽略**（为向前兼容），但本文列出的字段一个都不能错。
- 重复的 `capabilities` 项在客户端去重（保留首次出现的顺序），不算失败。

### 2.2 字段定义

所有字段均为**必填**。类型、长度、大小写按表执行：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `protocol` | number | 必须**等于数字 1**（不是 `"1"`） | 协议版本。客户端拒绝其他值，不做兼容猜测；升版即破坏性变更。 |
| `kind` | string | 精确小写 `"gateway"` 或 `"service"` | 节点类型。大小写敏感，不接受其他拼写。 |
| `name` | string | 1–64 个 **Unicode 码点**；不得含 C0 控制符（U+0000–U+001F）或 DEL（U+007F） | 人类可读名称，仅用于展示，**不参与身份判断**。gateway 固定用 `DeepSeek Harness`（不暴露计算机名）。 |
| `version` | string | 正则 `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$`，即 1–32 个 ASCII 字符，首字符为字母或数字 | 节点**软件**版本（不是协议版本），semver 可直接使用，如 `0.5.1`、`1.2.0-rc.3`。 |
| `capabilities` | string[] | 非空数组；每项精确小写、取值必须属于 `pairing` `cache` `official-ui` `relay` `turn`；**必须包含 `"pairing"`** | 节点能力广告；未知能力即失败（新增能力必须升 protocol）。见 2.3。 |
| `hostId` | string | 正则 `^[A-Za-z0-9_-]{43}$`，**恰好 43 个字符** | `base64url(sha256(Ed25519 公钥 SPKI DER))`，无 `=` 填充。见第 7 节。 |
| `fingerprint` | string | 正则 `^[a-f0-9]{32}$`，**恰好 32 个字符** | 同一个 sha256 **前 16 字节**的小写十六进制。给用户人工核对。 |

### 2.3 能力语义

| 能力 | 必填 | 语义 |
| --- | --- | --- |
| `pairing` | **是** | 节点支持设备配对/授权。缺少它的节点不可用。 |
| `cache` | 否 | 节点提供带 `rev` 的可缓存静态资源，并按 `hid`/`rev` 正确分区。 |
| `official-ui` | 否 | 节点提供官方 DSH 界面外壳（gateway 通常有）。 |
| `relay` | 否 | 节点能中继设备流量（自托管 service 常见）。 |
| `turn` | 否 | 节点提供 TURN 服务用于 WebRTC 中继。 |

节点只能广告**实际实现**的能力，不能为了「看起来完整」而填。gateway 的参考广告是 `["pairing", "official-ui"]`。

## 3. 客户端检测算法（`detectPublicNode`）

输入：用户填写的字符串或 `URL`。输出：成功 `{ ok: true, node }` 或失败 `{ ok: false, code, message }`。**永不抛异常**，任何失败都以数据返回。

1. **地址规范化**：`trim` 后 `new URL()`。失败 → `bad-url`。
2. **仅 HTTPS**：`protocol !== "https:"` → `not-https`。
3. **只允许 origin**：`username`/`password` 非空、`pathname !== "/"`、`search` 非空、`hash` 非空 → 全部 `bad-url`。`https://node.example.com`、`https://node.example.com/`、`https://node.example.com:8443` 合法；规范化结果分别为 `https://node.example.com`、`https://node.example.com`、`https://node.example.com:8443`。
4. 请求 `GET <origin>/.well-known/dsh-remote`，`redirect: "manual"`、`credentials: "omit"`、`cache: "no-store"`、`referrerPolicy: "no-referrer"`、仅 `accept: application/json` 头、`AbortSignal` 5 秒超时。
5. 响应分类：`opaqueredirect` 或 `300 ≤ status < 400` → `redirect`；`status !== 200` → `bad-response`。
6. **解析与逐字段校验**（顺序固定，先命中先返回）：
   1. 不是 JSON 对象 → `bad-response`
   2. `protocol !== 1` → `bad-protocol`
   3. `kind` 非法 → `bad-kind`
   4. `name` 非法 → `bad-response`
   5. `version` 非法 → `bad-response`
   6. `capabilities` 非数组、空、含白名单外能力或缺 `pairing` → `bad-capability`
   7. `hostId` 非法 → `bad-identity`
   8. `fingerprint` 非法 → `bad-identity`
7. 传输层异常：证书/TLS 类（`CERT`、`TLS`、`SSL`、`SELF_SIGNED`、`UNABLE_TO_VERIFY`、`DEPTH_ZERO`、`ALTNAME`、`HOSTNAME_MISMATCH`，沿 `error.cause` 链最多 4 层）→ `bad-tls`；其余（DNS、拒绝连接、超时）→ `unreachable`。

### 3.1 错误码

`code` 稳定、供程序分支；`message` 是中文人类提示，可能调整，不应被程序匹配。

| code | 触发条件 |
| --- | --- |
| `not-https` | 地址不是 `https:` |
| `bad-url` | 地址无法解析、为空、带账号密码、带路径/查询/锚点 |
| `unreachable` | DNS/连接失败、超时（5 秒） |
| `redirect` | 发现请求返回任何 3xx |
| `bad-tls` | TLS 握手或证书校验失败（自签、过期、域名不匹配等） |
| `bad-protocol` | `protocol` 不是数字 1 |
| `bad-kind` | `kind` 不是 `gateway`/`service` |
| `bad-capability` | `capabilities` 形状错误、含未知能力或缺 `pairing` |
| `bad-identity` | `hostId` 或 `fingerprint` 不符合长度/字符集 |
| `bad-response` | 非 200、非 JSON 对象、`name`/`version` 非法 |

## 4. 网关侧实现要求（本仓库）

- `src/gateway.ts` 在 `handle()` 中于 `safePath` + `validHost` 校验**之后**、ACME 与全部配对逻辑**之前**处理：
  - 仅当 `url.pathname === "/.well-known/dsh-remote"` 时进入；
  - 方法不是 `GET`/`HEAD` → `405`（JSON 错误体）；
  - `options.discovery` 未注入 → `404`；
  - 成功：`200`，头固定为 `content-type: application/json; charset=utf-8`、`cache-control: no-store`、`referrer-policy: no-referrer`、`x-content-type-options: nosniff`、`content-length`（实际字节数）；`HEAD` 只发头不发 body。
- **安全理由**：端点必须在配对校验之前（否则未配对设备永远无法发现节点），但必须：
  1. 保留 `safePath`/`validHost`（Host 头白名单）检查——否则可被 DNS rebinding 利用；
  2. 只放行**这一个精确路径**的 `GET`/`HEAD`，不匹配前缀、不接受其他方法——不能成为绕过配对去读 `/rc/*`、`/api/*` 或代理路径的口子；
  3. 响应体只有本文 7 个字段，不含设备、端口、内部路径。
- 公网与局域网网关都必须响应；`kind` 由调用方注入（网关注入 `"gateway"`），`hostId`/`fingerprint` 来自 `host-identity.json`。
- 端点不检查 Cookie、不写 Cookie、不要求配对。

## 5. 多节点配置（`public-nodes.json`）

路径：`<DSH_HOME>/dsh-remote-connect/<profile>/public-nodes.json`，Mode `0600`，**原子写**（临时文件 + `rename`）。文件损坏必须报错，不得静默重建或丢弃节点。

```json
{
  "version": 1,
  "current": "9d0b4c2e-1f0a-4c3b-9a7e-2b6f5d8c1a30",
  "nodes": [
    {
      "id": "9d0b4c2e-1f0a-4c3b-9a7e-2b6f5d8c1a30",
      "url": "https://node.example.com",
      "kind": "service",
      "name": "Studio Server",
      "version": "0.5.1",
      "protocol": 1,
      "capabilities": ["pairing", "cache", "relay"],
      "hostId": "5QKQY_VIKcY52sBuej3ozcSh4gUAwAYe0YENr18qsfA",
      "fingerprint": "e5029063f54829c639dac06e7a3de8cd",
      "addedAt": 1763300000000,
      "lastCheckAt": 1763300100000,
      "lastCheckOk": true,
      "lastCheckError": null,
      "pending": false
    },
    {
      "id": "0b7c1a44-6d2e-4f80-8f1e-3c9a5b7d2e61",
      "url": "https://old.example.net",
      "kind": null, "name": null, "version": null, "protocol": null,
      "capabilities": null, "hostId": null, "fingerprint": null,
      "addedAt": 1763200000000, "lastCheckAt": null, "lastCheckOk": false,
      "lastCheckError": null, "pending": true
    }
  ]
}
```

顶层字段：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `version` | number | 必须为 `1` |
| `current` | string \| null | 当前选中节点的 `id`；加载时若指向不存在的 `id`，归一为 `null`（不报错、不崩溃） |
| `nodes` | array | 节点数组，`id` 不得重复；重复视为文件损坏 |

节点字段（全部必填，未探测的字段用 `null`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 1–64 字符，UUID 即可；创建后不变 |
| `url` | string | 规范化后的 HTTPS origin（规则同 3.1 第 1–3 步）；存储时再次规范化 |
| `kind` | `"gateway"` \| `"service"` \| null | 探测结果 |
| `name` | string \| null | 1–64 码点，同 2.2 |
| `version` | string \| null | 同 2.2 的 `version` 正则 |
| `protocol` | number \| null | 探测成功时为 `1` |
| `capabilities` | string[] \| null | 白名单子集；非 `null` 时必须包含 `"pairing"`；探测成功后按响应原样保存 |
| `hostId` | string \| null | 43 位 base64url |
| `fingerprint` | string \| null | 32 位小写 hex |
| `addedAt` | number | Unix 毫秒时间戳 |
| `lastCheckAt` | number \| null | 最近一次探测时间（Unix 毫秒）；从未探测为 null |
| `lastCheckOk` | boolean | 最近一次探测是否成功；从未探测为 `false` |
| `lastCheckError` | string \| null | 最近一次失败的中文原因；成功或未探测为 null |
| `pending` | boolean | `true` 表示尚未探测。迁移来的候选节点恒为 `true`，探测成功后写回 `false` |

API（`PublicNodeConfig`）：`current`（getter）、`list()`、`add(input)`、`update(id, patch)`、`remove(id)`、`setCurrent(id | null)`。`remove` 返回 `{ origin, hostId }`（`hostId` 可能为 `null`），调用方据此清理该节点的缓存索引；删除当前节点会把 `current` 置 `null`。

**损坏语义**：JSON 解析失败、`version !== 1`、节点字段非法、`id` 重复 → 抛错（含文件路径），不自动修复。

## 6. 迁移规则（旧 `public-url.json` → 多节点）

旧版本把唯一公网地址存在 `public-url.json` 的 `{ "publicUrl": "https://..." }` 中。

- 仅当 `public-nodes.json` **不存在**时迁移一次；文件一旦写出，即使 `nodes` 为空也不再迁移（用户删除节点是用户意图，不能被旧配置复活）。
- 旧地址经规范化后生成一条候选节点：`id` 新 UUID、`url` 为 origin、`pending: true`、`addedAt` 为当前时间、`lastCheckAt: null`、`lastCheckOk: false`、`lastCheckError: null`，`kind`/`name`/`version`/`protocol`/`capabilities`/`hostId`/`fingerprint` 全部 `null`。
- **不自动设为 `current`**：候选地址未被探测，不能替用户决定。
- 旧值非法（非 HTTPS、带路径等）时跳过迁移，保留空列表。

## 7. 主机身份（`host-identity.json`）

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
- 同一 profile 的网关与本地 service 共享该文件即共享 `hostId`；不同主机必须各自生成。

## 8. 缓存键规则

- **浏览器缓存按 origin 天然隔离**：不同 origin 的响应不会互相命中，插件无需为此做任何事。
- **同一 origin 多 Host**（一个 service 前置多个 Host）靠 `hid=hostId` 区分：资源 URL 必须带当前 Host 的 `hostId`。
- **同一 Host 的版本**靠 `rev` 区分：`rev` 为 1–64 位 `[A-Za-z0-9_-]` 的构建/清单版本。
- 规范形状：`https://origin/path?hid=<hostId>&rev=<rev>`；纯函数 `cacheScope({ origin, hostId, rev })` 返回 `{ origin, hid, rev, query: "hid=<hostId>&rev=<rev>", key: "<origin>?<query>" }`。
- 宿主生成的资源 URL 已自带 `rev`（如 `.../client.js?rev=batch`）；插件不重写资源 URL，只在需要构造缓存键时调用 `cacheScope`。仓库内不存在跨 Host 复用同一缓存键的代码路径。
- 不引入 Service Worker，不预下载前端，不改宿主模块加载器的重试/去重/回退职责；本协议只提供**分区规则**，缓存由浏览器与宿主负责。

## 9. 服务端实现清单（remote-server / 网关通用）

1. 在认证、配对、会话逻辑**之前**注册精确路由 `GET|HEAD /.well-known/dsh-remote`；其他方法返回 `405`。
2. 返回 200、`application/json; charset=utf-8`、`cache-control: no-store`、`content-length`；不允许 3xx。
3. 读取本机 `host-identity.json` 派生 `hostId`/`fingerprint`；绝不返回 `privateKey`。
4. `kind`：网关填 `"gateway"`，remote-server 填 `"service"`。
5. `capabilities` 至少含 `"pairing"`，只广告已实现能力；`official-ui` 仅当确实提供官方 UI。
6. 响应体只含本文 2.2 的 7 个字段；不返回设备列表、端口、内部路径、配对状态、构建信息。
7. 该端点**不校验** Cookie、Authorization、Referer；不得写入 Cookie。
8. 5 秒内必须响应；发现请求不跟随重定向，服务端也不要依赖重定向。
9. 未配对设备访问该路径必须成功；访问其他路径仍按原规则拒绝。

## 10. 兼容性

- `protocol` 升级 = 破坏性变更；客户端遇到非 `1` 直接失败，不做降级猜测。
- 响应中**多出的字段被忽略**，服务端可先行添加新字段（但新能力必须等待 protocol 升级）。
- 未知 `capabilities` 项导致客户端拒绝，因此能力白名单只能随 protocol 升版扩展。
- 文档版本：v1（`protocol: 1`）。
