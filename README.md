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
</p>
<p>
  简体中文 · <a href="https://github.com/winlin926/dsh-carry/blob/main/README.en.md">English</a>
</p>

　　`dsh-carry` 是一个 DSH 插件，手机扫码配对后就能接着用电脑上的会话、审批工具请求、查看工作区文件和 HTML 预览。0.7.0 起支持局域网与公网双线路，一张二维码自动选入口，断线自动切换，不用重新扫码。

## 📦 安装与首次连接

　　[GitHub Release v0.7.0](https://github.com/winlin926/dsh-carry/releases/tag/v0.7.0) 提供 `.tgz` 安装包；下面的 npm 命令暂时还是 0.6.5。

　　在要远程访问的电脑上装插件。**桌面版**：「插件 → 添加插件」搜 `@winlin926/dsh-carry`。**`dsh web`**：

```sh
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

　　桌面版和 `dsh web` 各有各的插件目录。找不到「远程控制」面板的话，看一下插件装到了哪个 profile。

1. 手机和电脑连同一个局域网。电脑上打开「远程控制」，开启连接。
2. 手机扫二维码，电脑核对设备、批准配对。
3. 打开一个已有会话就能用了。想收回权限，去电脑的已授权设备列表里删掉那台手机。

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" width="720" alt="电脑端远程控制面板，显示配对二维码和已授权设备列表" /></p>

## 📱 手机上能做什么

| 场景 | 操作 |
| --- | --- |
| 离开工位，任务还在跑 | 打开同一个会话，看回复、继续聊。 |
| 工具请求等你确认 | 查看请求，批准或拒绝。 |
| 想看刚生成的文件 | 点文件链接，直接预览。 |

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-boot.png" width="30%" alt="启动页预览，顶部可选主题，中央显示插件检查进度" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.jpg" width="30%" alt="手机浏览器中的 DSH 新会话" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" width="30%" alt="手机上已有的对话和消息输入框" />
</p>
<p align="center">启动页预览 · 新会话 · 继续对话</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" width="30%" alt="手机上的工作区工具入口" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-html-preview.jpg" width="30%" alt="手机上的工作区 HTML 预览" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" width="30%" alt="手机上的 DSH 通用设置" />
</p>
<p align="center">工作区工具 · HTML 预览 · 设置</p>

## 🌐 离开局域网后怎么连？

　　在「连接设置」填一个固定 HTTPS 域名，或者自己部署仓库里的 `remote-server` 中继节点。公网入口验证通过后，面板的二维码会指向该域名。首次公网配对时双方核对主机指纹。

　　打开的域名页面会顺便尝试局域网直连。两条路都通的时候默认走局域网，也可以在「连接设置」改成公网优先。某条线路断了会自动切到另一条。公网不可用时面板换回局域网二维码。HTTPS 页面支持 Service Worker 的话，公网暂时断了也能通过已有直连继续看工作区 HTML 预览。

　　**🔒 只批准你信任的设备。** 配对后的手机权限接近本机操作。公网节点会终止 TLS，运营者能看到转发内容——没有端到端加密，请用自己部署或信任的节点。项目不运营公共节点。

[自托管部署指南](docs/self-host.md) · [公网节点协议](docs/public-node.md) · [插件能力与宿主接口](docs/features.md)

## 📄 致谢与许可

　　感谢 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 的早期实现。MIT 许可，版权声明见 [LICENSE](LICENSE)。
