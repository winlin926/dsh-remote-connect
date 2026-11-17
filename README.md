# dsh-carry

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" alt="dsh-carry 标志：电脑与手机通过无限符号连接" width="160" height="160" />
</p>

简体中文 | [English](https://github.com/winlin926/dsh-carry/blob/main/README.en.md)

**DSH 远程控制插件：用手机或另一台电脑的浏览器，远程操作正在运行的 DeepSeek Harness（DSH）。** 查看会话、发送消息、处理工具审批，或预览电脑上的文件；手机无需安装 App，也无需另起一个 DSH 实例。

远程浏览器打开的是当前 DSH 宿主提供的 Web 界面。手机或另一台电脑可通过同一局域网连接；跨网络访问可配置固定 HTTPS 域名和隧道网关，或部署自托管公网节点。

**同一局域网：手机扫码，另一台电脑打开配对链接，在宿主电脑确认后即可连接。**

## 快速安装

在 DSH 的「插件 → 添加插件」中搜索并安装：

```text
@winlin926/dsh-carry
```

也可以将插件安装到 `dsh web` 使用的 `web` profile：

```bash
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

请安装到你准备连接的 DSH 宿主所在 profile。桌面版和 `dsh web` 使用各自独立的 profile。

### 局域网连接

1. 让访问设备与运行 DSH 的电脑处于同一局域网。
2. 在运行 DSH 的电脑上打开「远程连接」，选择「同一 Wi-Fi」并开启连接。
3. 手机扫描二维码；另一台电脑则在浏览器中打开面板「复制链接」提供的完整配对链接。
4. 在运行 DSH 的电脑上确认配对请求，然后在远程浏览器中继续会话。

## 升级与迁移

旧包已停止更新，从 `@winlin926/dsh-remote-connect` 迁移到 `@winlin926/dsh-carry`：

1. 在 DSH 的「插件」里移除 `@winlin926/dsh-remote-connect`。
2. 安装 `@winlin926/dsh-carry`。
3. 重启宿主。

新旧包不能同时装到同一个 profile。新包继续读取旧存储目录 `~/.dsh/dsh-remote-connect/<profile>` 和旧管理接口，所以设备授权、公网节点和偏好文件迁移后照常可用，不需要重新扫码配对。

## 界面预览

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" alt="电脑上的远程连接面板：开启连接、扫码配对与管理已授权设备" width="760" />
</p>

<p align="center"><strong>电脑上：开启连接、扫码配对、管理已授权设备</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.png" alt="手机上的 DSH 新会话界面" width="23%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" alt="手机上的 DSH 对话与输入框" width="23%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" alt="手机上的工作区工具入口" width="23%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" alt="手机上的 DSH 通用设置界面" width="23%" />
</p>

<p align="center"><strong>手机上：新会话 · 对话 · 工作区工具 · 通用设置</strong></p>

## 主要功能

- **浏览器远程控制 DSH**：从手机或另一台电脑直接打开当前宿主的 Web 界面，查看和继续会话、发送消息、处理工具审批。远程端可用功能由 DSH 宿主决定。
- **扫码配对与设备管理**：在电脑上批准新设备；查看已授权设备并随时撤销访问。
- **工作区文件预览**：在远程浏览器中打开宿主电脑上的文件和 HTML 页面；普通文件最大支持 48 MiB。
- **按需选择公网连接方式**：使用固定域名隧道网关，或自行部署 `remote-server` 服务节点。自托管节点支持多台电脑分别连接同一节点。
- **节点和主机身份校验**：连接前核对节点身份；公网配对时由访问设备和宿主电脑分别确认目标主机指纹。
- **局域网 HTTPS 与连接诊断**：可为局域网入口配置受访问设备信任的域名证书；启动时检查证书和端口等配置。
- **本机插件更新**：从电脑上的远程连接面板检查更新，并交由 DSH 插件管理器安装。

## 外网与自托管

跨网络访问需要一个你信任的 HTTPS 公网节点。可以使用已有隧道网关，也可以把 `remote-server/` 部署到自己的服务器：

```text
手机或电脑浏览器 → HTTPS 公网节点 → 隧道 → 宿主电脑上的 DSH
```

自托管部署步骤见[服务节点指南](docs/self-host.md)。节点协议说明见[公网节点协议](docs/public-node.md)。

## 安全边界

已配对的远程设备拥有与宿主电脑本机相近的操作权限，只批准你信任的设备。公网节点会终止 TLS 并转发请求，节点或隧道运营者可能看到转发内容；插件不提供端到端加密，也不运营公共节点。请使用可信节点，并通过 HTTPS 连接。

## 致谢与许可证

本项目基于 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 维护，保留原作者署名和 MIT 许可证。许可证见 [LICENSE](LICENSE)。
