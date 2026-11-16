# 自托管公网中继节点（remote-server）

`remote-server/` 是一个可自托管的公网中继节点：它让已配对的 Host（电脑上的 DSH）与手机在
跨网络时仍能建立加密连接。节点只做三件事——配对登记、控制帧路由、静态资源与 TURN 凭据分发。

**安全边界一句话：本服务只是中继，不解密任何业务数据；不记录聊天/审批内容；私钥只在 Host
和手机上，服务端只保存哈希与公钥指纹。**

## 1. 前置条件

- 一台有公网 IP 的 Linux 主机（或 VPS），建议 1 vCPU / 1 GiB 内存起。
- 一个域名（示例 `relay.example.com`），A/AAAA 记录指向该主机。
- 安全组/防火墙放行：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | ACME HTTP-01 校验与 HTTPS 跳转 |
| 443 | TCP | HTTPS + WSS `/v1/control` |
| 3478 | TCP/UDP | TURN（仅启用 relay 的 TURN 能力时需要） |
| 49160-49200 | UDP | TURN 中继端口段 |

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
- `HOST_REGISTRATION_TOKEN`：长随机值，保护 Host 注册接口（生成：
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`）
- 若启用 TURN：`TURN_URLS`、`TURN_SECRET`、`PUBLIC_IP`、`TURN_REALM`

启动：

```powershell
docker compose up -d --build
docker compose ps
```

Caddy 首次启动会向 Let's Encrypt 申请证书（需要 DNS 已生效、80/443 可达），通常几十秒内完成。

## 3. 健康检查

```powershell
curl.exe -sS https://relay.example.com/healthz
curl.exe -sS https://relay.example.com/.well-known/dsh-remote
```

`/healthz` 返回 `{"ok":true,"version":"0.6.0"}`。

`/.well-known/dsh-remote` 是统一节点契约，返回形如：

```json
{"protocol":1,"kind":"service","name":"My Public Node","version":"0.6.0","capabilities":["pairing","cache","official-ui","relay"],"hostId":"<43 字符 base64url>","fingerprint":"<32 位小写 hex>"}
```

尚未有 Host 注册时，`hostId` 为 `A`×43、`fingerprint` 为 `0`×32 的占位值（格式合法、明显为空）。

## 4. 接入 Host 与手机

1. 在 Host（电脑上的 DSH）里把节点地址设为 `https://relay.example.com`，填入
   `HOST_REGISTRATION_TOKEN`（若配置了）后注册；Host 会收到一次性凭证，只保存在本机。
2. Host 生成配对二维码（`https://relay.example.com/pair#v=1&ticket=...&host=...&key=...`）。
3. 手机扫码打开 `/pair` 落地页，页面展示 Host 名称与 8 位比较码；Host 端同时显示同一比较码。
4. 手机点「确认」，Host 端本地点「批准」——**两个独立决定都完成**后才签发设备 cookie 并建立关系。
   任一端拒绝、票据过期（≤5 分钟）或已被使用都会失败关闭。

## 5. 备份与恢复

数据都在 SQLite 单文件里（compose 卷 `data` → 容器 `/data/remote-server.sqlite`）。

```powershell
# 备份（在线一致性由 SQLite WAL 保证，建议低峰期）
docker compose cp remote-server:/data/remote-server.sqlite .\backup-remote-server.sqlite
# 或整卷快照
docker run --rm -v dsh-remote-server_data:/data -v ${PWD}:/backup alpine tar czf /backup/data.tgz -C /data .
```

恢复：停服务 → 把备份文件放回卷内 `/data/remote-server.sqlite`（同时删除 `-wal`/`-shm`）→ 启服务。
数据库里的凭证与配对票据只有 SHA-256 哈希，泄露备份不等于泄露可用凭证。

## 6. 升级

```powershell
git pull
cd remote-server
docker compose up -d --build
```

数据库迁移是版本表 + 幂等 `CREATE TABLE IF NOT EXISTS`，重启时自动执行，无需手工迁移脚本。

## 7. 撤销设备 / 关闭节点

- 撤销某台手机：手机端「删除此 Host」会调 `DELETE /v1/hosts/:hostId/devices/:deviceId`；
  服务端立即删除该设备会话、关闭其 WebSocket（关闭码 4004），并通知 Host。
- Host 自己也能通过 `device.revoked` 控制帧撤销设备。
- 在电脑面板删除某个自托管节点时，插件会先调用 `DELETE /v1/hosts/:hostId`（Host Bearer，只允许删除自己）
  撤销该 Host 在节点上的注册并级联清理设备、关系、会话、票据与资源；撤销失败不阻断本地删除，面板会提示
  「节点上的主机注册可能仍在…」，此时在节点上执行 `npm run admin:reset -- <hostId>` 直接删库再重试添加。
- 彻底下线：`docker compose down`（保留数据卷）或 `docker compose down -v`（同时删除数据，不可恢复）。

## 8. 安全说明（如实）

- 服务端**不持有**任何私钥，**不解密** Noise/业务密文，**不落盘**中继数据，**不记录**聊天/审批内容；
  日志对 token、ticket、cookie、authorization、identityKey、ciphertext 等字段一律打码。
- 持久化的只有：Host 公钥及其派生 `hostId`/`fingerprint`、Host 凭证哈希、配对票据哈希、
  设备身份公钥、设备会话哈希、配对关系、静态资源内容。
- 传输安全由 Caddy 终止 TLS；服务端只在 `TRUST_PROXY=1` 时信任 `X-Forwarded-*`。
- 所有写接口校验 Origin，设备 cookie 为 `Secure; HttpOnly; SameSite=Strict` 并绑定 HTTPS origin。
- 有多层限流（HTTP、注册、配对、升级、控制帧），帧大小上限控制帧 64 KiB / 中继帧 1 MiB，另有背压与空闲超时。

## 9. 已知限制

- **单实例**：在线状态与转发成员表在进程内存，SQLite 为单写者；多实例需要 PostgreSQL 与共享在线协调，
  当前不支持水平扩展。
- 本节点不做 WebRTC：`hello.ack` 返回 `webrtcEnabled:false`，连接一律走 WSS 中继；LAN/P2P 由 Host 与手机协商，
  失败时回退中继。
- 未配置 TURN 时 `/v1/turn-credentials` 返回 `501 TURN_NOT_CONFIGURED`，节点能力里也不含 `turn`。
- 本仓库交付环境未实测真实 TLS 证书签发与真实 coturn 连通性（仅单测覆盖凭据算法）；上线前请按第 3 节验收。
- 设备身份统一用 Base64URL(SPKI DER)（与 `src/host-identity.ts` 一致）：Host 与手机提交的都是 SPKI DER 公钥，
  节点只做 DER 合法性校验与 sha256 推导，不持有、不上传任何私钥。
