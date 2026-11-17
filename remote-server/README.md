# remote-server（DSH 公网中继服务）

自托管的公网节点：把电脑上的 DeepSeek Harness（Host）与手机浏览器（Client）配对，并在两端之间转发隧道帧与官方界面流量。服务端只做节点身份、关系、路由、限流与静态资源缓存，**不持有 Host/手机的私钥**。

**信任边界**：HTTPS/WSS 只保护「手机到节点」「主机到节点」两段传输。节点终止 TLS 并代理 HTTP/SSE/WebSocket，**节点运营者可能看到转发的请求与内容**；本服务不提供端到端加密。节点解析隧道帧头并转发负载，不持久化业务正文，但不要把它当作对运营者的内容保护。

- 运行时：Node.js 24（`node:sqlite` 内置 SQLite，无需原生模块）
- 语言：TypeScript，`tsc` 编译，`module: NodeNext`
- 依赖：仅 `ws` 与 `zod`（`zod` 用于节点契约校验）
- 共享协议：直接复用仓库 `src/remote/tunnel-protocol.ts`，Host/Client 与节点共用同一帧类型

## 统一节点契约（v2）

`GET /.well-known/dsh-remote`（`application/json; charset=utf-8`、`cache-control: no-store`、不返回 3xx）：

```json
{"protocol":2,"kind":"service","name":"我的公网节点","version":"0.6.2","capabilities":["pairing","cache","official-ui"],"node":{"id":"<base64url 43 字符>","fingerprint":"<32 位小写 hex>","publicKey":"<base64url SPKI DER，Ed25519 44 字节 → 59 字符>"}}
```

- `kind` 固定 `"service"`；`protocol` 为数字 `2`，客户端必须拒绝其他值。
- `capabilities` 只能是 `pairing`、`cache`、`official-ui` 的子集，且必须含 `pairing`。协议里没有 relay/turn 能力；写进 `CAPABILITIES` 会直接启动失败（失败关闭）。
- `node.id` = base64url(sha256(节点公钥的 SPKI DER))，43 字符；`node.fingerprint` = 同一 sha256 前 16 字节的小写十六进制（32 字符）；`node.publicKey` = base64url(SPKI DER)。客户端必须自行解码并复核摘要，不得信任节点返回的 `id`/`fingerprint`。
- **服务节点不返回扁平的 `hostId`/`fingerprint`**：一个服务节点可以承载多台 Host，扁平字段属于 `kind: "gateway"` 的旧式网关，不应出现在 service 文档里。
- `name`、`version` 可由 `NODE_NAME`、`NODE_VERSION` 覆盖。
- 节点身份持久化在 `DATA_DIR/node-identity.json`：`{version:1,algorithm:"ed25519",publicKey,createdAt}`，权限 0600、临时文件 + rename 原子写；生成时的私钥不保留，不出现在文件、接口与日志里。文件损坏时启动直接失败并报「节点身份文件已损坏」，**不会静默重建**（重建会改变指纹，等于让所有已信任该节点的客户端失效）。
- 节点身份与 Host 无关：启动即有身份（不存在"第一个 Host 注册前的占位值"），多台 Host 注册、注销、注销后重注册都不改变 `node.id`/`node.fingerprint`；重启读取同一 `node-identity.json`，值保持不变。丢失该文件会得到新指纹，需重新分发节点地址/记录。

`GET /v1/config` 返回同一份公开身份：`{protocol:2,kind:"service",name,version,capabilities,node:{id,fingerprint,publicKey}}`，`no-store`。

## 架构

### 进程与请求路径

```
浏览器 ──HTTPS/WSS──▶ Caddy（TLS 终止，可选）──HTTP/WSS──▶ remote-server ──▶ SQLite（单实例）
Host ───HTTPS/WSS──▶                                              │
                                                                  ├─ 解析帧头并转发负载（业务正文不落盘）
                                                                  └─ 节点身份：<DATA_DIR>/node-identity.json（0600）
```

- `src/app.ts`：装配 HTTP 服务与隧道升级（请求限流、跨源拒绝、路由分发、优雅关闭）；启动时先加载/创建节点身份。
- `src/node-identity.ts`：节点身份文件的加载、校验、原子生成与 `nodeId`/`fingerprint` 派生。
- `src/http/routes/*`：按资源拆分（discovery、landing、hosts、pairings、assets）。
- `src/tunnel/hub.ts`：`/v1/tunnel` Host 反向隧道集线器（鉴权、hello、心跳、帧路由、背压）。
- `src/tunnel/proxy.ts`：把已配对设备的 HTTP/WebSocket 请求经隧道转发给 Host。
- `src/db.ts`：`node:sqlite` `DatabaseSync`、迁移表、幂等建表。
- `src/repositories.ts`：所有 SQL 访问集中在此；其余模块不直接拼 SQL。
- `src/pairing.ts`：二维码配对状态机（票据、双端确认、发 cookie、落关系）。
- `src/assets.ts`：Host 推送的官方 DSH 静态资源（按 `hostId` + `rev` 隔离，immutable + ETag）。
- `src/identity.ts`：token 生成/哈希、`identityKey` 的 SPKI DER 校验、`hostId`/`fingerprint` 推导、constant-time 比较。

### SQLite 表结构（`schema_migrations` 版本化迁移，`CREATE TABLE IF NOT EXISTS` 幂等）

| 表 | 主键 | 作用与字段 |
| --- | --- | --- |
| `schema_migrations` | `version` | 已应用迁移版本 |
| `hosts` | `host_id` | 已注册电脑：`device_id`、`name`、`identity_key`、`fingerprint`、`client_version`、`credential_hash`（只存 sha256）、`created_at`、`last_seen_at` |
| `pairing_tickets` | `ticket_hash` | Host 生成的一次性票据：`host_id`、`expires_at`、`created_at`、`request_id`（被 claim 后写入，唯一） |
| `pairing_requests` | `request_id` | 配对请求：`host_id`、`ticket_hash`、客户端描述、`claim_token_hash`、`state`（`pending/client_approved/host_approved/complete/rejected`）、`expires_at`、双端确认时间、`cookie_issued_at` |
| `devices` | `device_id` | 手机/浏览器设备身份：`name`、`platform`、`identity_key`、`created_at`、`last_seen_at` |
| `relationships` | `(host_id, client_device_id)` | 已配对关系：`client_identity_key`、`created_at`、`revoked_at` |
| `device_sessions` | `credential_hash` | 设备 cookie（只存哈希）：`device_id`、`bound_origin`（cookie 与 origin 绑定）、`created_at`、`last_seen_at`、`expires_at` |
| `assets` | `(host_id, revision, path)` | Host 推送的静态资源：`content_type`、`etag`、`size`、`content`（BLOB）、`created_at` |

所有凭证/票据只以 `sha256(hex)` 形式落库；私钥、cookie 明文、密文正文从不入库。节点身份公钥单独保存在 `<DATA_DIR>/node-identity.json`（`0600`，原子写）；生成时的私钥不保留。

### HTTP 接口

统一错误体：`{"error":{"code":"...","message":"..."}}`，敏感字段不回显。写请求若带 `Origin` 必须与 `PUBLIC_ORIGIN`（或 `ALLOWED_ORIGINS`）一致，否则 `403`。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/.well-known/dsh-remote` | 无 | v2 节点契约（见上），`no-store`、无 3xx |
| GET | `/healthz` | 无 | `{ok:true,version}` |
| GET | `/v1/config` | 无 | `{protocol:2,kind,name,version,capabilities,node}`，与发现文档同源、不含密钥 |
| POST | `/v1/hosts` | 无（默认开放） | `{deviceId,name,identityKey,clientVersion}`（`identityKey` = base64url(SPKI DER)，如 Ed25519 44 字节/59 字符）→ `201 {credential,host:{hostId,deviceId,name,fingerprint}}`（凭证只返回一次，仅存哈希）。注册默认开放，受注册限流与双端授权保护；**注册本身不授予跨主机访问权**。同一 `deviceId` 重复注册返回 `409 HOST_ALREADY_REGISTERED`，公钥已被其他 Host 使用返回 `409 IDENTITY_IN_USE`，不是合法 SPKI 公钥返回 `400 INVALID_IDENTITY_KEY`（失败关闭） |
| POST | `/v1/pairings` | Host Bearer | `{ticket?,expiresAt?}`（省略则服务端生成 32 字节票据、TTL≤5min）→ `201 {ticket,expiresAt,host:{name,hostId,fingerprint}}`，票据哈希入库、单次使用 |
| POST | `/v1/pairings/claim` | 无（票据即凭据） | `{ticket,client:{deviceId,name,platform,identityKey}}`（`identityKey` 同样是 base64url(SPKI DER)）→ `201 {requestId,pairingToken,host:{...},verificationCode,expiresAt}`；票据被消费；Host 必须在线，`pair.request` 帧推给 Host。`verificationCode` 仅作 v1 传输兼容字段保留，`/pair` 页面与新授权逻辑不读取、不显示、不参与判定 |
| POST | `/v1/pairings/:requestId/confirm` | `X-Pairing-Token` | 手机确认；Host 已确认则完成配对并 `Set-Cookie`（`Secure; HttpOnly; SameSite=Strict`）→ `{requestId,state,complete,host,expiresAt}` |
| GET | `/v1/pairings/:requestId` | `X-Pairing-Token` | 轮询状态；完成且未发过 cookie 时补发 `Set-Cookie` |
| POST | `/v1/pairings/:requestId/reject` | `X-Pairing-Token` | 手机拒绝（`410 PAIRING_REJECTED` 处理后续操作） |
| GET | `/v1/hosts` | Device cookie | 只列当前 cookie 授权过且未撤销的 Host |
| DELETE | `/v1/hosts/:hostId/devices/:deviceId` | Device cookie | 撤销关系（仅限本设备），关闭该设备经隧道的活动连接（4004） |
| DELETE | `/v1/hosts/:hostId` | Host Bearer | Host 注销自己的注册：级联删除该 Host 的设备授权、设备会话、配对票据/请求与静态资源，再删除 hosts 行，返回 `204`；`hostId` 不存在返回 `404 HOST_NOT_FOUND`，凭据与路径不一致返回 `403` |
| PUT | `/v1/assets?path=...&rev=...` | Host Bearer | 推送/覆盖资源（body 为原始字节，≤`ASSET_MAX_BYTES`），返回 `201 {ok,path,revision,etag,size}` |
| GET/HEAD | `/assets/:hid/:rev/*` | 无 | 按 `hid`+`rev` 隔离的静态资源；普通资源 `immutable`+`ETag`+304，HTML `no-store`、清单类 `no-cache` |
| GET | `/`、`/pair` | 无 | 配对落地页（`web/index.html`），`no-store` |

### 配对页（`/pair`）

- 二维码参数保持 `#v=1&ticket=<43 字符>&key=<Host SPKI DER base64url>`；页面只用 `ticket` 发起 claim，用 `key` **在本地**计算目标主机指纹（sha256(SPKI DER) 前 16 字节，按 8 组 4 位大写展示）。
- 页面展示节点名称、节点类型（隧道网关/自托管服务）、目标主机指纹与有效期，操作按钮为「拒绝」与「确认是本机」；**不再显示任何 8 位数字短码**，也不读取 claim 返回的 `verificationCode`。
- 授权条件不变：手机确认 + 电脑端批准 + 指纹核对一致；拒绝、过期、重放（同一票据二次 claim）都不会签发设备 cookie。

### Host 反向隧道（`/v1/tunnel`）

- Host 用注册返回的凭证以 `Authorization: Bearer` 连接 `wss://<node>/v1/tunnel`；10s 内发 `hello`（`hostId`、`version`、`capabilities`，能力取值 `http`/`ws`/`assets`）。同 `hostId` 的新连接以 4001 关闭旧连接。
- 帧：`http.request/body/body.end/cancel`、`http.response/chunk/end/error`、`ws.open/ack/frame/close`、`ping/pong`、`pair.request/approve/reject/complete`；帧头 ≤16 KiB、负载 ≤48 KiB，更大的 body 由发送端切片、接收端重组。
- 配对帧：`pair.request`（Server→Host），`pair.approve`/`pair.reject`（Host→Server），`pair.complete`（Server→Host）；Host 的决定失败只记日志，不回错误帧。
- 限制：20s ping 心跳 / 60s 失联断开、`bufferedAmount` 1 MiB 高水位背压、每 Host 64 个并发中继、每设备 16 个并发中继。
- 设备流量：已配对设备发往节点的 HTTP/WebSocket 请求由 `tunnel/proxy.ts` 经同一隧道转发给 Host；节点只在隧道断开时拒绝。

### 安全边界

- **节点能看到转发内容**：节点终止 TLS 后代理 HTTP/SSE/WebSocket 流量，节点或隧道运营者可能看到转发给本机的请求与内容；不提供端到端加密。发行方不托管任何节点。
- 不记录：私钥、cookie 明文、配对票据明文、claim token、聊天/审批内容、转发密文正文；日志只写事件名、状态码、耗时、脱敏后的设备标签。
- 持久化只存哈希（Host 凭证、设备会话、票据、claim token）；`<DATA_DIR>/node-identity.json`（`0600`）只存节点身份**公钥**，私钥不落盘、不出接口、不写日志；启动日志只打印 `nodeId`/`nodeFingerprint` 便于运维核对。
- 注册默认开放，但注册本身不授予任何访问权：只有「手机确认 + 电脑批准 + 指纹一致」才产生设备授权；注册与配对均有限流。
- `X-Forwarded-*` 仅在 `TRUST_PROXY=1` 时信任；默认按直连地址限流。
- 全局限流 + 端点级限流（注册、claim、confirm 单独收紧），超限 `429` 并带 `Retry-After`。
- 单实例设计：SQLite + 内存在线表；多实例需要共享数据库与在线协调，不在本实现范围。

### 已知问题与风险

1. 隧道帧编码约束：`pair.request.verificationCode` 为 8 位数字字符串，`/pair` 页面不读取、不显示、不参与判定；`identityKeySchema` 为 40–120 字符 Base64URL（容纳 59 字符的 SPKI DER，旧的 43 字符值仍合法），DER 结构由节点用 `createPublicKey` 校验。
2. 本节点不实现 WebRTC：设备流量一律经 Host 反向隧道转发；不做 LAN/P2P。
3. 真实 TLS 未在本机实测：TLS 由 Caddy 终止（compose 提供）。
4. 多实例不支持：在线状态与转发成员表在进程内存，SQLite 也是单写者；横向扩展需要 PostgreSQL 与共享在线协调。
5. 静态资源存 SQLite BLOB，适合单节点与中小体积资源（默认上限 16MiB/个），不适合大文件或 CDN 级流量。
6. `node-identity.json` 只含公钥，但它是节点指纹的唯一来源：部署时需备份；删除或损坏（不做静默重建）都会改变节点身份，已信任旧指纹的客户端需要重新确认。

## 自测

在 `remote-server/` 目录内：

```powershell
npm install
npx tsc -p tsconfig.json --noEmit
npm run build
npm test
node dist/remote-server/src/main.js   # 可用 PORT/DATA_DIR 临时指定
```

`npm test` 先 `tsc` 构建，再用 `node --test` 直接跑 `test/*.test.ts`（Node 24 类型剥离，测试导入编译产物），共 6 个文件 57 个用例。

## 故障排查

- 本机凭据丢失、节点仍保留该 Host 注册（重新注册返回 `409 HOST_ALREADY_REGISTERED`）：在 `remote-server/` 目录运行 `npm run admin:reset -- <hostId>`（即 `node dist/remote-server/src/tools/reset-host.js <hostId>`），它会用同一 `DATA_DIR` 直接打开 SQLite 删除该 Host 及级联数据并打印删除行数。Host 正常运行时可改用 `DELETE /v1/hosts/:hostId`（Host Bearer）自助注销。
- 启动报「节点身份文件已损坏」：检查 `DATA_DIR/node-identity.json` 是否被截断或手改；修复文件或从备份恢复，不要直接删除（会更换节点指纹）。

## 目录

```
remote-server/
  src/            服务端源码（app、http、tunnel、db、pairing、assets、identity、node-identity、tools/reset-host 运维工具）
  test/           node --test 集成测试（对编译产物运行）
  web/            配对落地页（配对入口 /pair）
  Dockerfile      多阶段构建（node:24-alpine）
  compose.yaml    server + caddy
  Caddyfile       自动 HTTPS 反代（含 Upgrade）
  .env.example    全部环境变量占位示例
```

部署步骤见仓库 `docs/self-host.md`。
