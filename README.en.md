<img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" width="112" height="112" alt="dsh-carry" />
<h1>dsh-carry</h1>
<p><strong>Pick up your DSH session on your phone.</strong></p>
<p>
  <img src="https://img.shields.io/static/v1?label=DSH&message=Plugin&color=8B4A38" height="20" alt="DSH | Plugin" />
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/winlin926/dsh-carry/ci.yml?branch=main&label=build" height="20" alt="build" /></a>
  <a href="https://www.npmjs.com/package/@winlin926/dsh-carry"><img src="https://img.shields.io/npm/v/@winlin926/dsh-carry?label=npm" height="20" alt="npm" /></a>
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/static/v1?label=tests&message=372%20passing&color=2ea44f" height="20" alt="372 tests passing" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/package.json"><img src="https://img.shields.io/node/v/@winlin926/dsh-carry?label=node" height="20" alt="node" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/LICENSE"><img src="https://img.shields.io/github/license/winlin926/dsh-carry?label=license" height="20" alt="license" /></a>
</p>
<p>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/README.md">简体中文</a> · English
</p>

`dsh-carry` lets you use the DeepSeek Harness (DSH) instance running on your computer from a phone browser. Scan a QR code to pair, then continue a conversation, approve tool requests, and view workspace files or HTML previews. Your phone connects to the computer’s DSH instance, so available sessions and tools depend on the host.

**Setting up public access from scratch?** Follow the [SakuraFrp public-access walkthrough](docs/public-access-sakura.md) (in Chinese), from buying a domain to connecting your phone.

<details>
<summary>Show the phone recording (26-second GIF): answer a question card, watch a tool run, open an HTML preview</summary>

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/demo.gif" width="320" alt="Screen recording: answering a question card, watching a tool run, and opening an HTML preview on a phone" /></p>

</details>

## 📦 Install and pair your phone

Install the plugin on the computer you want to reach. In the **DSH desktop app**, open **Plugins → Add plugin** and search for `@winlin926/dsh-carry`. For **`dsh web`**, run this command.

```sh
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

1. On the computer, open **Remote Control** (远程控制) and enable the connection. Pick which entry the QR code should point at: public first (when a domain or node is configured) or LAN first.
2. Scan the single QR code with your phone — both entries share one pairing ticket. Check the device shown on the computer and approve the pairing request.
3. Open an existing session in your phone browser. To revoke access later, remove the phone from the authorized devices on your computer.

<details>
<summary>Show the plugin panel</summary>

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" width="720" alt="Remote Control panel on the computer with a pairing QR code and a list of authorized devices" /></p>

</details>

## 📱 What you can do from your phone

<table align="center">
  <tr><th>When…</th><th>On your phone</th></tr>
  <tr><td>A task is still running when you leave your desk</td><td>Open the same conversation, read the reply, and send a follow-up.</td></tr>
  <tr><td>A tool is waiting for approval</td><td>Review the request in the host interface and decide whether to approve it.</td></tr>
  <tr><td>You want to inspect a generated file</td><td>Follow its workspace link to view the file or preview an HTML page in the browser.</td></tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-boot.png" width="30%" alt="Boot screen preview with a theme selector while DSH checks plugins" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.jpg" width="30%" alt="A new DSH session in the phone browser" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" width="30%" alt="An existing conversation with its message input on the phone" />
</p>
<p align="center">Boot screen preview · New session · Ongoing conversation</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" width="30%" alt="Workspace tools on the phone" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-html-preview.jpg" width="30%" alt="A workspace HTML preview on the phone" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" width="30%" alt="DSH general settings on the phone" />
</p>
<p align="center">Workspace tools · HTML preview · Settings</p>

## 🌐 Connecting from another network

With a fixed-domain HTTPS tunnel gateway (or the included `remote-server` relay), both entries are served by one listener and the QR code points at the priority you picked. When the public route dies while the phone is on the same network, the page switches to the LAN entry by itself and asks for no new scan; leaving the network is a manual step — open the public address the panel shows. During public pairing, compare the host fingerprint on both devices to confirm you have reached your computer.

**🔒 Approve only devices you trust.** A paired phone has privileges close to local access. Public nodes terminate TLS, so their operators can read forwarded content. Choose a node you run or an operator you trust. The project does not operate a public relay.

[Self-hosting guide](docs/self-host.md) · [Public node protocol](docs/public-node.md) · [Plugin capabilities and host interfaces](docs/features.md) (guides in Chinese)

## 📄 Credits and license

Thanks to [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) for the early implementation. MIT license; copyright notice in [LICENSE](LICENSE).