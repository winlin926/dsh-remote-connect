<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" width="112" height="112" alt="dsh-carry" />
</p>
<h1 align="center">dsh-carry</h1>
<p align="center"><strong>Pick up your DSH session on your phone.</strong></p>
<p>
  <img src="https://img.shields.io/static/v1?label=DSH&message=Plugin&color=8B4A38" height="20" alt="DSH | Plugin" />
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/winlin926/dsh-carry/ci.yml?branch=main&label=build" height="20" alt="build" /></a>
  <a href="https://www.npmjs.com/package/@winlin926/dsh-carry"><img src="https://img.shields.io/npm/v/@winlin926/dsh-carry?label=npm" height="20" alt="npm" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/package.json"><img src="https://img.shields.io/node/v/@winlin926/dsh-carry?label=node" height="20" alt="node" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/LICENSE"><img src="https://img.shields.io/github/license/winlin926/dsh-carry?label=license" height="20" alt="license" /></a>
</p>
<p>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/README.md">简体中文</a> · English
</p>

`dsh-carry` lets you use the DeepSeek Harness (DSH) instance running on your computer from a phone browser. Scan a QR code to pair, then continue a conversation, approve tool requests, and view workspace files or HTML previews. Your phone connects to the computer’s DSH instance, so available sessions and tools depend on the host. Version 0.7.0 adds a verified LAN/public dual route: one QR code chooses the available entry point, public pairing shows the host fingerprint first, and an established session can switch between verified routes.

## 📦 Install and pair your phone

[GitHub Release v0.7.0](https://github.com/winlin926/dsh-carry/releases/tag/v0.7.0) provides a `.tgz` package. The npm install methods below do not install 0.7.0 yet.

Install the plugin on the computer you want to reach. In the **DSH desktop app**, open **Plugins → Add plugin** and search for `@winlin926/dsh-carry`. For **`dsh web`**, run this command.

```sh
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

The desktop app and `dsh web` keep separate plugin profiles. If the Remote Control panel is missing, check which profile you installed the plugin in.

1. Put your phone and computer on the same LAN. On the computer, open **Remote Control** (远程控制), and enable the connection.
2. Scan the QR code with your phone. Check the device shown on the computer and approve the pairing request.
3. Open an existing session in your phone browser. To revoke access later, remove the phone from the authorized devices on your computer.

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" width="720" alt="Remote Control panel on the computer with a pairing QR code and a list of authorized devices" /></p>

## 📱 What you can do from your phone

| When… | On your phone |
| --- | --- |
| A task is still running when you leave your desk | Open the same conversation, read the reply, and send a follow-up. |
| A tool is waiting for approval | Review the request in the host interface and decide whether to approve it. |
| You want to inspect a generated file | Follow its workspace link to view the file or preview an HTML page in the browser. |

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-boot.png" width="30%" alt="Boot screen preview with a theme selector while DSH checks plugins" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.jpg" width="30%" alt="A new DSH session in the phone browser" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" width="30%" alt="An existing conversation with its message input on the phone" />
</p>
<p align="center">Boot screen preview · New session · Ongoing conversation</p>

<details>
<summary>More phone screenshots — workspace tools, HTML preview, and settings</summary>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" width="30%" alt="Workspace tools on the phone" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-html-preview.jpg" width="30%" alt="A workspace HTML preview on the phone" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" width="30%" alt="DSH general settings on the phone" />
</p>

</details>

## 🌐 Connecting from another network

Save a fixed HTTPS domain in connection settings or enable a self-hosted `remote-server` relay. Once the public entry is verified, the panel’s QR code opens that domain. During first-time public pairing, compare the host fingerprint on both devices.

The open domain page attempts a direct LAN connection. When both routes are available, LAN is preferred by default and you can select public-first in connection settings. The page can reconnect through the verified backup route. If the public entry is unavailable, the desktop panel shows a LAN pairing code. On HTTPS pages with Service Worker support, an established direct route can also keep workspace HTML previews available during a temporary public-route outage.

**🔒 Approve only devices you trust.** A paired phone has privileges close to local access. Public nodes terminate TLS, so their operators can read forwarded content. Choose a node you run or an operator you trust. The project does not operate a public relay.

[Self-hosting guide](docs/self-host.md) · [Public node protocol](docs/public-node.md) · [Plugin capabilities and host interfaces](docs/features.md) (guides in Chinese)

## 📄 Credits and license

Thanks to [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) for the early implementation. MIT license; copyright notice in [LICENSE](LICENSE).
