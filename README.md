<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" width="112" height="112" alt="dsh-carry" />
</p>
<h1 align="center">dsh-carry</h1>
<p align="center"><strong>电脑上的 DSH 会话，拿起手机接着用。</strong></p>
<p>
  <img src="https://img.shields.io/static/v1?label=DSH&message=Plugin&color=8B4A38" height="20" alt="DSH | Plugin" />
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/winlin926/dsh-carry/ci.yml?branch=main&label=build" height="20" alt="build" /></a>
  <a href="https://www.npmjs.com/package/@winlin926/dsh-carry"><img src="https://img.shields.io/npm/v/@winlin926/dsh-carry?label=npm" height="20" alt="npm" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/package.json"><img src="https://img.shields.io/node/v/@winlin926/dsh-carry?label=node" height="20" alt="node" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/LICENSE"><img src="https://img.shields.io/github/license/winlin926/dsh-carry?label=license" height="20" alt="license" /></a>
  简体中文 · <a href="https://github.com/winlin926/dsh-carry/blob/main/README.en.md">English</a> · <a href="https://www.npmjs.com/package/@winlin926/dsh-carry">npm 包</a> · <a href="https://github.com/winlin926/dsh-carry/releases">发行记录</a>
</p>

`dsh-carry` 让你通过手机浏览器远程使用电脑上运行的 DeepSeek Harness（DSH）。扫码配对后，可以继续会话、审批工具请求，并查看工作区文件或 HTML 预览。手机连接的是电脑上的 DSH 实例，可用会话和工具由宿主提供。

## 📦 安装与首次连接

在要远程访问的电脑上安装插件。**桌面版**在 DSH 的「插件 → 添加插件」中搜索 `@winlin926/dsh-carry`。**使用 `dsh web`** 时，运行：

```sh
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

桌面版和 `dsh web` 各自管理插件。如果电脑上找不到「远程控制」面板，先确认插件装在正在使用的那个 profile 中。

1. 让手机和电脑连接同一 Wi-Fi。在电脑上打开「远程控制」，选择「同一 Wi-Fi」并开启连接。
2. 用手机扫描面板上的二维码，在电脑上核对设备并批准配对。
3. 在手机浏览器中打开已有会话。以后要收回权限，在电脑的已授权设备列表中撤销该手机即可。

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" width="720" alt="电脑端远程控制面板，显示配对二维码和已授权设备列表" /></p>

## 📱 手机上能做什么

| 场景 | 在手机上操作 |
| --- | --- |
| 离开工位，任务还在跑 | 打开电脑上的会话，查看回复，继续发消息。 |
| 工具请求正在等你确认 | 在宿主界面里查看请求，决定是否批准。 |
| 想看刚生成的文件 | 点开工作区文件链接，在浏览器中查看文件或预览 HTML 页面。 |

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-boot.png" width="30%" alt="启动页预览，顶部可选主题，中央显示插件检查进度" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.png" width="30%" alt="手机浏览器中的 DSH 新会话" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" width="30%" alt="手机上已有的对话和消息输入框" />
</p>
<p align="center">启动页预览 · 新会话 · 继续对话</p>

<details>
<summary>查看更多手机界面：工作区工具与设置</summary>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" width="32%" alt="手机上的工作区工具入口" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" width="32%" alt="手机上的 DSH 通用设置" />
</p>

</details>

## 🌐 离开同一 Wi-Fi 后怎么连？

同一局域网内，手机可以直连电脑。换成移动数据或其他 Wi-Fi 时，可使用固定域名的 HTTPS 隧道网关，或自行部署仓库里的 `remote-server` 中继节点。公网配对时，在手机与电脑上核对主机指纹，确认连接的是自己的电脑。

**🔒 只批准你信任的设备。** 已配对的手机拥有接近本机的操作权限。公网节点会终止 TLS，运营者可以看到转发内容。这条链路没有端到端加密，请使用自己部署或信任的节点。项目不运营公共节点。

[自托管部署指南](docs/self-host.md) · [公网节点协议](docs/public-node.md) · [插件能力与宿主接口](docs/features.md)

## 📄 致谢与许可

感谢 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 的早期实现。MIT 许可，版权声明见 [LICENSE](LICENSE)。
