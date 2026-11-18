# dsh-carry

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" alt="dsh-carry 标志：电脑与手机通过无限符号连接" width="160" height="160" />
</p>

简体中文 | [English](https://github.com/winlin926/dsh-carry/blob/main/README.en.md)

**用手机浏览器远程操作电脑上正在运行的 DeepSeek Harness（DSH）。** 查看会话、发送消息、处理工具审批、预览工作区文件，不用装 App，也不用另起一个 DSH 实例。

手机打开的始终是**当前宿主自己的 Web 界面**，所以能用的功能由宿主版本决定。

## 安装

```bash
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

也可以在 DSH 的「插件 → 添加插件」里搜索 `@winlin926/dsh-carry` 安装。

> **注意**：桌面版和 `dsh web` 使用各自独立的 profile。请把插件安装到你**实际要连接的那个 DSH 宿主**所在的 profile，否则面板不会出现在你要连的那台机器上。

## 快速上手（同一 Wi-Fi）

1. 确保手机和电脑连接在同一个 Wi-Fi 下。
2. 在电脑端 DSH 中打开「远程控制」面板，选择「同一 Wi-Fi」并开启连接。
3. 用手机扫描二维码，并在电脑端确认这次配对请求。
4. 配对完成后，直接在手机浏览器里继续当前会话。

## 界面预览

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" alt="电脑上的远程控制面板：开启连接、扫码配对与管理已授权设备" width="760" />
</p>

<p align="center"><strong>电脑上：开启连接、扫码配对、管理已授权设备</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-boot.png" alt="手机上的启动界面：正在加载模块，显示真实模块进度" width="44%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.png" alt="手机上的 DSH 新会话界面" width="44%" />
</p>

<p align="center"><strong>手机上：启动界面 · 新会话</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" alt="手机上的 DSH 对话与输入框" width="30%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" alt="手机上的工作区工具入口" width="30%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" alt="手机上的 DSH 通用设置界面" width="30%" />
</p>

<p align="center"><strong>手机上：对话 · 工作区工具 · 通用设置</strong></p>

## 主要功能

- **手机继续使用 DSH**：直接打开当前宿主的 Web 界面，查看和继续会话、发送消息、处理工具审批；手机端可用功能由宿主版本决定。
- **扫码配对与设备管理**：新设备必须在电脑端批准才能接入；已授权设备可随时查看和撤销。
- **工作区文件预览**：在手机上打开电脑工作区内的文件与 HTML 页面，普通文件最大支持 48 MiB。
- **局域网 HTTPS 与连接诊断**：可为局域网入口配置受手机信任的域名证书，启动时自动检查证书与端口配置。
- **跨网络自托管接入**：可接入固定域名隧道网关，或自行部署 `remote-server` 节点；单节点支持多台电脑分别接入。
- **节点与主机身份校验**：连接前核对节点身份；公网配对时由手机与电脑双端确认目标主机指纹。
- **本机插件更新**：可在电脑端面板直接检查更新，并交由 DSH 插件管理器安装。

## 外网访问与自托管

在移动网络或其他 Wi-Fi 下访问，需要一个你信任的 HTTPS 公网节点：

```text
手机浏览器 → HTTPS 公网节点 → 隧道 → 电脑上的 DSH
```

可以接入已有的 HTTPS 隧道网关，也可以把本仓库的 `remote-server/` 部署到自己的服务器。部署步骤见[服务节点指南](docs/self-host.md)，协议说明见[公网节点协议](docs/public-node.md)。

## 安全边界

- 已配对手机拥有与电脑本机相近的操作权限，**请只批准你信任的设备**。
- 公网节点会终止 TLS 并转发请求，**节点或隧道运营者可以看到转发内容**；本插件不提供端到端加密，也不运营任何公共节点。
- 请只使用你信任的节点，并始终通过 HTTPS 连接。

## 从旧包迁移

旧包 `@winlin926/dsh-remote-connect` 已弃用，新包继承它的运行时标识，迁移不用重新配对：

1. 在 DSH 的「插件」里移除 `@winlin926/dsh-remote-connect`。
2. 安装 `@winlin926/dsh-carry`。
3. 重启宿主。

新旧包不能同时装在同一个 profile。设备授权、公网节点和偏好仍保存在 `~/.dsh/dsh-remote-connect/<profile>`，迁移后照常可用。

## 致谢与许可证

本项目基于 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 维护，保留原作者署名和 MIT 许可证。许可证见 [LICENSE](LICENSE)。
