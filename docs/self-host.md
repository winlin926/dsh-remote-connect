# 自托管公网中继节点（remote-server）

`remote-server/` 是一个可自托管的公网中继节点：它让已配对的 Host（电脑上的 DSH）与手机在
跨网络时仍能建立连接。节点做三件事——公开自己的节点身份、配对登记、静态资源与隧道流量转发。

**信任边界（务必理解）：HTTPS/WSS 只保护「手机到节点」「主机到节点」这两段传输。节点会终止
TLS 并代理 HTTP/SSE/WebSocket 转发，节点或隧道运营者可能看到转发的请求与内容；本服务不提供
端到端加密。本仓库的发行方不托管任何节点。请只把节点交给你信任的运营者。**

**数据边界**：服务端不持有 Host/手机的私钥，不落盘聊天或审批内容，日志对 token、ticket、
cookie、authorization、identityKey、ciphertext 等字段打码；持久化内容见第 8 节。

## 1. 前置条件

- 一台有公网 IP 的 Linux 主机（或 VPS），建议 1 vCPU / 1 GiB 内存起。
- 一个域名（示例 `relay.example.com`），A/AAAA 记录指向该主机。
- 安全组/防火墙放行：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | ACME HTTP-01 校验与 HTTPS 跳转 |
| 443 | TCP | HTTPS + WSS `/v1/tunnel`（Host 反向隧道） |

- Docker Engine 24+ 与 Compose v2。

## 2. 部署

```powershell
git clone <this-repository> dsh
cd dsh/remote-server
Copy-Item .env.example .env
```

编辑 `.env`，至少改这几项（其余保持默认即可）：

- `SITE_ADDRESS`：公网域名，如 `relay.example.com`
- `PUBLIC_ORIGIN`：`https://` + 同一域名
- `ACME_EMAIL`：证书通知邮箱

启动：

```powershell
docker compose up -d --build
docker compose ps
```

Caddy 首次启动会向 Let's Encrypt 申请证书（需要 DNS 已生效、80/443 可达），通常几十秒内完成。

**注册默认开放**：`POST /v1/hosts` 不需要注册令牌。节点靠注册限流（同源/同 IP 的频率与并发上限）
与双端授权保护——注册本身不授予跨主机访问权，只有「手机确认 + 电脑批准 + 指纹一致」才产生设备
授权。不需要、也不要在 `.env` 里配置任何共享令牌。

**节点身份**：首次启动时，节点在数据目录生成 Ed25519 节点身份并持久保存到
`/data/node-identity.json`（`DATA_DIR` 即 compose 数据卷内的 `/data`；文件权限 `0600`，原子写）。
节点在启动时就有身份，不依赖是否已有 Host 注册。**该文件只保存节点身份公钥，生成时的私钥不保留**：不要删除、
不要覆盖、不要提交到 Git 或放进公开备份。丢失或更换它会让节点指纹变化，所有已添加该节点的
客户端都需要重新确认（见第 5 节）。

## 3. 健康检查

```powershell
curl.exe -sS https://relay.example.com/healthz
curl.exe -sS https://relay.example.com/v1/config
curl.exe -sS https://relay.example.com/.well-known/dsh-remote
```

`/healthz` 返回 `{"ok":true,"version":"0.6.1"}`。

`/.well-known/dsh-remote` 是 v2 统一节点契约，返回形如：

```json
{
  "protocol": 2,
  "kind": "service",
  "name": "My Public Node",
  "version": "0.6.1",
  "capabilities": ["pairing", "cache", "official-ui"],
  "node": {
    "id": "<43 字符 base64url>",
    "fingerprint": "<32 位小写 hex>",
    "publicKey": "<Ed25519 SPKI DER 的 base64url>"
  }
}
```

服务节点**不会**返回扁平的 `hostId`/`fingerprint`：一个节点可以被多台 Host 共用，扁平字段无法
如实表达。`node.id` = `base64url(sha256(SPKI DER))`，`node.fingerprint` = 同一摘要前 16 字节的
小写十六进制；界面上展示为 8 组 4 位大写，如 `0E2E-A5C3-9BEC-BE17-4B29-8006-E0B1-4EA0`。
`/v1/config` 返回公开配置（协议、类型、名称、版本、能力），不含任何密钥。

## 4. 接入 Host 与手机

1. 在 Host（电脑上的 DSH）的公网节点列表里填 `https://relay.example.com` 并添加。插件会请求
   发现文档，显示节点名称、类型（自托管服务）、协议版本（`v2`）与节点指纹（8 组 4 位大写）。
   核对指纹与第 3 节一致后保存。
2. Host 生成配对二维码（`https://relay.example.com/#v=1&ticket=...&key=...`）。
3. 手机扫码打开 `/pair` 落地页，页面展示节点名称、节点类型与**目标主机指纹**（8 组 4 位大写）。
   页面不再显示 8 位比较码。
4. 手机点「确认」，Host 端本地点「批准」——**两个独立决定都完成、且两端显示的指纹一致**后才
   签发设备 cookie 并建立关系。任一端拒绝、票据过期（≤5 分钟）或已被使用都会失败关闭。

**多 Host 共用同一节点**：同一节点可以注册多台 Host，节点指纹不变；各 Host 的设备、配对关系、
静态资产与隧道互相隔离，任何 Host 的凭据都不能读写其它 Host 的资源或隧道。

## 5. 备份与恢复

`data` 卷保存 `node-identity.json`（节点身份公钥）和 `remote-server.sqlite`（注册、授权、会话与资源）。丢失公钥文件会改变节点指纹，已信任该节点的客户端需重新确认；丢失数据库会丢失注册与配对记录。

快照前停止服务端，完整保存数据卷；运行中的 SQLite 不能只复制主数据库文件而遗漏 WAL。

```powershell
docker compose stop remote-server
docker run --rm -v dsh-remote-server_data:/data:ro -v ${PWD}:/backup alpine tar czf /backup/data.tgz -C /data .
docker compose start remote-server
```

恢复时停止服务端，在空数据卷中还原完整快照，再启动。数据库中的凭证和票据是哈希，但设备关系与静态资源仍属于私有运行数据；快照和运行目录不提交公开仓库。

## 6. 升级

```powershell
git pull
cd remote-server
docker compose up -d --build
```

数据卷保留 `node-identity.json`，**升级不改变节点指纹**。数据库迁移是版本表 + 幂等
`CREATE TABLE IF NOT EXISTS`，重启时自动执行，无需手工迁移脚本。

## 7. 撤销设备 / 关闭节点

- 撤销某台手机：手机端「删除此 Host」会调 `DELETE /v1/hosts/:hostId/devices/:deviceId`；
  服务端立即删除该设备会话、关闭它经隧道的活动连接（关闭码 4004）。
- 电脑端面板的「删除此设备」改的是 Host 本机配对状态，不经过节点；如要连同节点上的注册一起清掉，用上面的接口或重新注册。
- 在电脑面板删除某个自托管节点时，插件会先调用 `DELETE /v1/hosts/:hostId`（Host Bearer，只允许删除自己）
  撤销该 Host 在节点上的注册并级联清理设备、关系、会话、票据与资源；撤销失败不阻断本地删除，面板会提示
  「节点上的主机注册可能仍在…」，此时在节点上执行 `npm run admin:reset -- <hostId>` 直接删库再重试添加。
- 彻底下线：`docker compose down`（保留数据卷）或 `docker compose down -v`（同时删除数据，不可恢复）。

## 8. 安全说明（如实）

- **节点能看到转发内容**：节点终止 TLS 后以明文代理 HTTP/SSE/WebSocket 流量，节点或隧道运营者
  可能看到转发给本机的请求与内容；不提供端到端加密。不要把节点运营者视为不可见内容的保护者。
- 服务端**不持有** Host/手机的私钥，**不落盘**聊天或审批内容，**不记录**聊天/审批内容；
  日志对 token、ticket、cookie、authorization、identityKey、ciphertext 等字段一律打码。
- 持久化内容包括：节点身份公钥（`node-identity.json`）、Host 公钥及其派生
  `hostId`/`fingerprint`、Host 凭证哈希、配对票据哈希、设备身份公钥、设备会话哈希、配对关系、
  静态资源内容。
- 传输安全由 Caddy 终止 TLS；服务端只在 `TRUST_PROXY=1` 时信任 `X-Forwarded-*`。
- 所有写接口校验 Origin，设备 cookie 为 `Secure; HttpOnly; SameSite=Strict` 并绑定 HTTPS origin。
- 有多层限流（HTTP、注册、配对、升级、隧道帧），隧道帧头上限 16 KiB、负载上限 48 KiB（大包由发送端切片），另有背压与空闲超时。
  注册默认开放由这些限流与双端授权共同兜底；若需要限制来源，请在 Caddy/反向代理层做 IP 白名单，
  不要引入应用内共享令牌。

## 9. 已知限制

- **单实例**：在线状态与转发成员表在进程内存，SQLite 为单写者；多实例需要 PostgreSQL 与共享在线协调，
  当前不支持水平扩展。
- 设备公网流量经 Host 反向隧道（`/v1/tunnel`）转发；局域网入口直接访问 Host 网关，不实现 WebRTC/P2P。
- 本仓库交付环境未实测真实 TLS 证书签发；上线前请按第 3 节验收。
- 设备身份统一用 Base64URL(SPKI DER)（与 `src/host-identity.ts` 一致）：Host 与手机提交的都是 SPKI DER 公钥，
  节点只做 DER 合法性校验与 sha256 推导，不持有、不上传任何私钥。
