# DSH Remote Connect

**在手机浏览器上继续使用电脑里正在运行的 DeepSeek Harness（DSH）。** 查看会话、发送消息、处理工具审批，或预览电脑上的文件；无需安装手机 App，也无需另起一个 DSH 实例。

适合需要离开电脑时继续跟进 DSH 任务的开发者，也适合希望通过固定 HTTPS 域名从外网连接、并愿意自行部署公网节点的用户。插件让手机连接到你正在使用的 DSH 宿主，手机界面由宿主提供。

**同一 Wi-Fi：扫码并在电脑确认即可连接。** 跨网络访问可使用自己的 HTTPS 隧道网关，或部署本仓库提供的自托管节点。

**v0.6.0 稳定版** · 适配 DSH 0.2.2 系列 · 需要 Node.js 24.9 或更高版本

## 快速安装

在 DSH 的「插件 → 添加插件」中搜索并安装：

```text
@winlin926/dsh-remote-connect
```

也可以将插件安装到 `dsh web` 使用的 `web` profile：

```bash
dsh plugin --profile web add @winlin926/dsh-remote-connect@latest
```

请安装到你准备连接的 DSH 宿主所在 profile。桌面版和 `dsh web` 使用各自独立的 profile。

### 局域网连接

1. 让手机和电脑连接同一个 Wi-Fi。
2. 在电脑 DSH 中打开「远程连接」，选择「同一 Wi-Fi」并开启连接。
3. 用手机扫描二维码，然后在电脑上确认配对请求。
4. 在手机浏览器中继续会话。

## 界面预览

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/desktop-connect.png" alt="电脑上的远程连接面板：开启连接、扫码配对与管理已授权设备" width="760" />
</p>

<p align="center"><strong>电脑上：开启连接、扫码配对、管理已授权设备</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-session.png" alt="手机上的 DSH 新会话界面" width="300" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-chat.jpg" alt="手机上的 DSH 对话与输入框" width="300" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-tools.jpg" alt="手机上的工作区工具入口" width="300" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-settings.png" alt="手机上的 DSH 通用设置界面" width="300" />
</p>

<p align="center"><strong>手机上：新会话 · 对话 · 工作区工具 · 通用设置</strong></p>

## 主要功能

- **手机继续使用 DSH**：直接打开当前宿主的 Web 界面，查看和继续会话、发送消息、处理工具审批。手机端可用功能由 DSH 宿主决定。
- **扫码配对与设备管理**：在电脑上批准新设备；查看已授权设备并随时撤销访问。
- **工作区文件预览**：在手机上打开电脑中的文件和 HTML 页面；普通文件最大支持 48 MiB。
- **按需选择公网连接方式**：使用固定域名隧道网关，或自行部署 `remote-server` 服务节点。自托管节点支持多台电脑分别连接同一节点。
- **节点和主机身份校验**：连接前核对节点身份；公网配对时由手机和电脑分别确认目标主机指纹。
- **局域网 HTTPS 与连接诊断**：可为局域网入口配置受手机信任的域名证书；启动时检查证书和端口等配置。
- **本机插件更新**：从电脑上的远程连接面板检查更新，并交由 DSH 插件管理器安装。

## 从 0.5.0 升级到 0.6.0

`0.5.0` 已支持手机访问当前 DSH 界面、局域网扫码配对、文件预览和固定域名网关。`0.6.0` 在这些能力上完善了公网连接的配置、身份确认和维护：

- 将公网入口整合为节点列表，可添加、检测、切换和删除节点；保留旧版 v1 网关兼容。
- 新增可自托管的 `remote-server`。电脑主动连接服务节点，通过反向隧道转发手机的 HTTP、SSE 和 WebSocket 请求；一个节点可以连接多台电脑。
- 升级到 v2 节点身份协议，将节点身份与电脑主机身份分开校验。节点身份发生变化时会暂停连接，等待本机确认。
- 公网配对改为手机和电脑双端核对主机指纹；删除自托管节点时，同时注销该电脑在节点上的注册。
- 增加局域网 HTTPS、启动诊断，以及确认主机身份后才执行的局域网回退。
- 从本机面板通过 DSH 官方插件管理器检查和安装更新。
- 移除未接入产品流程的 WebRTC、TURN 和独立控制面，减少不再使用的组件。

从 `0.5.0` 升级后，原有局域网授权可以继续使用；通过旧公网入口授权的设备需要重新扫码配对。

## 外网与自托管

在移动网络或其他 Wi-Fi 下访问，需要一个你信任的 HTTPS 公网节点。可以使用已有隧道网关，也可以把 `remote-server/` 部署到自己的服务器：

```text
手机浏览器 → HTTPS 公网节点 → 隧道 → 电脑上的 DSH
```

自托管部署步骤见[服务节点指南](docs/self-host.md)。节点协议说明见[公网节点协议](docs/public-node.md)。

## 安全边界

已配对手机拥有与电脑本机相近的操作权限，只批准你信任的设备。公网节点会终止 TLS 并转发请求，节点或隧道运营者可能看到转发内容；插件不提供端到端加密，也不运营公共节点。请使用可信节点，并通过 HTTPS 连接。

## 致谢与许可证

本项目基于 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 维护，保留原作者署名和 MIT 许可证。许可证见 [LICENSE](LICENSE)。
