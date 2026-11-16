# 公网节点 v2 契约（冻结版）

本文件是 0.6.2 的公网节点身份契约。子智能体 A（插件侧）、B（`remote-server` 侧）、C（测试与文档）都以本文件为准；实现与本文件冲突时先改本文件再改代码。

## 0. 目标与非目标

目标：

- 区分**节点身份**与**主机身份**：节点是地址背后的一台服务器（隧道网关或自托管服务），主机是一台运行 DSH 的电脑。一个服务节点可以被多台主机共用。
- 节点身份跨重启稳定；服务节点与主机身份解耦，多台主机注册不改变节点指纹。
- 保留 v1 兼容：新插件继续接受 v1 网关；v1 服务节点按「单主机旧模式」处理。
- 公网配对不使用短码、不使用密码、不使用账号。

非目标：端到端加密、WebRTC/TURN、发行方默认公共服务、多实例/高可用。

信任边界（必须写进界面与文档）：HTTPS/WSS 只保护手机到节点、主机到节点这两段传输。**终止 HTTPS 的节点或隧道运营者可能看到转发的请求与内容**；本插件不提供端到端加密。

## 1. v2 发现文档

路径不变：`GET /.well-known/dsh-remote`。请求规则不变：只接受 `200`、不跟随 `3xx`、`credentials: omit`、`referrerPolicy: no-referrer`、`cache: no-store`、5 秒超时。

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

字段规则：

| 字段 | 规则 |
| --- | --- |
| `protocol` | 字面量 `2`。客户端必须拒绝其它值（不猜测、不降级重试）。 |
| `kind` | 精确 `gateway` 或 `service`。 |
| `name` | 1–64 个 Unicode 码点，无控制字符。 |
| `version` | 与 v1 相同：`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$`。 |
| `capabilities` | 白名单 `pairing|cache|official-ui|relay|turn`，元素唯一、非空、必须含 `pairing`。0.6.2 的两类节点**只允许宣告** `pairing`、`cache`、`official-ui`；`relay`/`turn` 保留在白名单里供将来使用，本轮不得宣告。 |
| `node.id` | `base64url(sha256(SPKI DER))`，43 字符，`^[A-Za-z0-9_-]{43}$`。 |
| `node.fingerprint` | 同一摘要前 16 字节小写十六进制，32 字符，`^[a-f0-9]{32}$`。 |
| `node.publicKey` | `base64url(SPKI DER)`，Ed25519，40–120 字符；客户端必须解码为 SPKI 公钥，并验证 `sha256(DER)` 同时等于 `node.id` 与 `node.fingerprint`，不一致即 `bad-identity`。 |

身份来源：

- 网关：复用主机身份（`F:\AIData\.dsh\dsh-remote-connect\desktop\host-identity.json`），`node.*` 与宿主 `hostId`/`fingerprint` 同值。为兼容 ≤0.6.1 客户端，网关的 v2 文档**同时**保留扁平 `hostId`/`fingerprint`（同值，旧字段）。新客户端在 `protocol: 2` 下忽略扁平字段。
- 服务：节点自己在数据目录生成并持久保存节点密钥（`node-identity.json`，0600、临时文件 + rename 原子写、Ed25519），与任何主机身份无关；多台主机注册不改变节点指纹；服务节点的 v2 文档**不得**带扁平 `hostId`/`fingerprint`（一个节点对应多台主机，扁平字段无法如实表达）。
- 服务节点在启动时就有身份，不再像 v1 那样在首台主机注册前返回占位身份。

## 2. v1 兼容规则

新插件（0.6.2）的检测结果分三种：

| 文档 | 处理 |
| --- | --- |
| `protocol: 1` + `kind: gateway` | 沿用 v1 规则（必须有扁平 `hostId`/`fingerprint`），记录 `protocol: 1`、`node: null`。一切行为与 0.6.1 相同。 |
| `protocol: 1` + `kind: service` | v1 服务节点：单主机旧模式。`hostId`/`fingerprint` 是该节点首台主机的身份，只对这一台主机有意义；界面标注「旧版节点（单主机）」。`protocol` 记 1。 |
| `protocol: 2` | 按第 1 节校验 `node`；`node` 缺失或自校验失败即 `bad-identity`。 |

其它版本（`0`、`3`…）→ `bad-protocol`。

- v1 客户端（≤0.6.1）访问 v2 服务节点会因缺少扁平 `hostId` 被拒绝，这是接受的边界，写进文档；v2 网关保留扁平字段，因此旧客户端仍可添加网关节点。
- 新插件不因为节点是 v1 就降低自身安全要求；v1 节点照旧走原配对流程。
- 注册接口对 v1/v2 节点都是 `POST /v1/hosts`，请求体不变；节点身份不通过注册接口传递。

## 3. 本地节点记录（`public-nodes.json` v2）

文件名与位置不变：`<storage>/public-nodes.json`，权限 0600，原子写。文件版本升为 `2`。

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

- `node`：v2 节点身份；v1 记录为 `null`。`hostId`/`fingerprint`：仅 v1 记录填充，v2 记录保持 `null`（服务节点不允许出现；网关记录也不写扁平副本，避免两处真相）。
- `identityChange`：`null` 或 `{ "from": { "id": "…", "fingerprint": "…" }, "to": { "id": "…", "fingerprint": "…" }, "detectedAt": <ms> }`。存在时该节点**不可设为当前、不参与连接**，直到用户确认。
- `pending`：尚未完成检测的候选（继承 0.6.1 语义）。

迁移与状态规则：

1. 读取 `version: 1` 文件：逐条转换，`node` 补 `null`，其余字段原样保留（`current`、`pending`、检测结果、`addedAt` 都不丢），内存中按 v2 使用，下一次写入时落盘为 `version: 2`。
2. 首次遇到 v2 发现文档、而记录 `node` 为 `null`：**静默采纳**节点身份（写入 `node`、`protocol: 2`），不算「身份变化」，不需要用户确认——v1 记录此前没有节点身份可比。
3. 记录已有 `node`，检测到不同的 `node.id`：不覆盖旧身份；写 `identityChange`，`lastCheckOk: false`、`lastCheckError` =「节点身份已变化，需要重新确认。」；若该记录是 `current`，保持 `current` 但禁止连接，面板显示待确认。
4. 用户确认（`manage` 动作 `confirmPublicNodeIdentity{id}`）：采纳 `identityChange.to`，清空 `identityChange`，重新检测一次；不删除设备授权、不删除服务凭据、不删除缓存索引，也不要求手机重新配对。
5. 已确认的 v2 记录若检测到 `protocol: 1`（节点降级）：不自动降级。保留 `node` 与 `protocol: 2`，置 `lastCheckOk: false`、`lastCheckError` =「节点已降级为旧版协议，需要重新检测。」，面板提示重新检测；不删除记录、不改 `current`。
6. 删除节点：沿用 0.6.1（先尽力 `DELETE /v1/hosts/:hostId`，失败不阻断，删本地记录与缓存索引）。
7. 切换节点：旧节点授权与缓存保留；新节点需扫码配对，不迁移设备授权（不变）。

## 4. 配对

- 不做短码：手机页、面板确认页都不得显示或要求比较 8 位码。`verificationCode` 只作为 v1 传输字段保留在 `pair.request` 帧里供旧 Host/旧节点互通，新页面与新授权逻辑不读取、不显示、不参与判定。
- 手机配对页展示：节点名称、节点类型（隧道网关/自托管服务）、**目标主机指纹**（8 组 4 位大写十六进制，来自二维码里的 `key`，本地计算，不经节点转发）、「确认是本机」按钮。
- 电脑确认页展示：请求设备名、**本机主机指纹**（8 组 4 位大写）、「批准」/「拒绝」。
- 授权条件：手机确认 + 电脑批准 + 指纹一致，三者缺一不可；任一端拒绝、票据过期、重放（同一票据二次 claim）都不得产生设备授权。
- 二维码参数保持现状：`https://<origin>/#v=1&ticket=<43 位>&key=<host SPKI DER base64url>`；`v` 是页面票据格式版本，与节点协议版本无关，本轮不升。

## 5. Host 注册

- 删除 `HOST_REGISTRATION_TOKEN`：`remote-server` 的配置项、`x-host-registration-token` 头校验、`.env.example` 条目、部署文档与相关测试全部移除。
- `POST /v1/hosts` 默认开放，保留现有注册限流（同源/同 IP 的频率与并发上限）与输入校验（`identityKey` 必须是合法 SPKI DER）。
- 注册本身不授予任何访问权：注册只产生该主机自己的凭据；设备会话、关系、配对票据都按 `host_id` 隔离；任何 Host 凭据都不能读写其它 Host 的资源或隧道。
- 同一 `identityKey` 重复注册的现有语义（409 `HOST_ALREADY_REGISTERED` / `IDENTITY_IN_USE`）保持不变。

## 6. 面板与文案

节点列表每行展示：节点名称、HTTPS 地址、类型（隧道网关/自托管服务）、**节点指纹**（8 组 4 位大写）、协议版本（`v2` / 「旧版 v1（单主机）」）、最近检测时间、在线状态、当前使用标记；`identityChange` 存在时额外显示「节点身份已变化，需要重新确认」与「重新确认」按钮。

添加节点确认区固定文案：

> 通过 HTTPS 连接该节点。节点或隧道运营者可能看到转发给本机的请求与内容，本插件不提供端到端加密。请只添加你信任的节点。

节点指纹展示统一格式：32 位小写十六进制分组为 8 组 4 位大写，用 `-` 连接（与主机指纹一致）。

## 7. 测试矩阵（A/B/C 分工）

插件侧（A）：

- v2 网关/服务文档解析；`node` 与 `publicKey` 自校验；未知协议、缺 `node`、指纹不符、能力缺失全部拒绝。
- v1 网关、v1 服务（单主机）仍可检测并记录；`protocol` 字段正确。
- 记录迁移：v1 文件 → v2 内存 → 采纳 v2 身份不要求确认；身份变化写 `identityChange` 且 `current` 仍指向该记录；`confirmPublicNodeIdentity` 后清空并可连接；降级检测不删除记录。
- 切换节点不串授权/缓存；删除节点仍触发撤销。
- 面板：节点指纹与信任文案存在；`identityChange` 时「设为当前」被禁用。

服务侧（B）：

- 节点身份跨重启稳定（同一 `node-identity.json`）；两台主机注册后 `/.well-known/dsh-remote` 的 `node` 不变；v1 模式（未升级）仍返回旧结构。
- 两个 Host 的凭据、设备、资产、隧道互不可见；A 的凭据访问 B 的资源返回 403/404。
- `pair.request` 仍带 `verificationCode`（兼容），但 web 配对页不再显示；双端确认、拒绝、过期、重放全部覆盖。
- 未配置注册令牌即可注册；限流生效（第 N 次注册 429）。

集成（C）：`tsc`/`build`/全量测试、Compose 配置校验、镜像构建、本机启动冒烟、浏览器只跑节点设置与自托管配对。

## 8. 发布

- 插件 `version` → `0.6.2`，`remote-server` 的 `nodeVersion` 同步为 `0.6.2`。
- 打包记录 SHA-256/SHA-512/文件数；隔离 profile 安装并校验包内哈希；不部署公共服务、不改日常 profile。
- 没有真实 v2 服务节点时，报告标注「真实公网服务与真机验收待完成」。
