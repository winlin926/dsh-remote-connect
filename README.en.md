<img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" width="112" height="112" alt="dsh-carry" />
<h1>dsh-carry</h1>
<p><strong>Pick up your DSH session on your phone.</strong></p>
<p>
  <img src="https://img.shields.io/static/v1?label=DSH&message=Plugin&color=8B4A38" height="20" alt="DSH | Plugin" />
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/winlin926/dsh-carry/ci.yml?branch=main&label=build" height="20" alt="build" /></a>
  <a href="https://www.npmjs.com/package/@winlin926/dsh-carry"><img src="https://img.shields.io/npm/v/@winlin926/dsh-carry?label=npm" height="20" alt="npm" /></a>
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fwinlin926%2F49d5d742a7e999a6c40935ac190623e7%2Fraw%2Ftest-count.json" height="20" alt="tests" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/package.json"><img src="https://img.shields.io/node/v/@winlin926/dsh-carry?label=node" height="20" alt="node" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/LICENSE"><img src="https://img.shields.io/github/license/winlin926/dsh-carry?label=license" height="20" alt="license" /></a>
</p>
<p>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/README.md">简体中文</a> · English
</p>

`dsh-carry` is a DSH plugin. Scan a QR code from your phone to pair, then pick up any session on your computer — continue conversations, approve tool requests, and preview workspace files or HTML pages. Since 0.7.0, LAN and public routes share one QR code; the connection auto-selects the best entry and fails over without re-pairing.

## 📦 Install and pair your phone

[GitHub Release v0.7.0](https://github.com/winlin926/dsh-carry/releases/tag/v0.7.0) provides a `.tgz` package; the npm command below still installs 0.6.5.

Install the plugin on the computer you want to reach. **DSH desktop app**: open **Plugins → Add plugin** and search for `@winlin926/dsh-carry`. **`dsh web`**:

```sh
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

1. Get your phone and computer on the same LAN. Open **Remote Control** on the computer and enable the connection.
2. Scan the QR code on your phone; approve the device on your computer.
3. Open an existing session — you're in. To revoke access later, remove the phone from the authorized-device list on the computer.

<details>
<summary>Show the plugin panel</summary>

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" width="720" alt="Remote Control panel on the computer with a pairing QR code and a list of authorized devices" /></p>

</details>

## 📱 What you can do from your phone

<table align="center">
  <tr><th>When…</th><th>What to do</th></tr>
  <tr><td>A task keeps running after you leave your desk</td><td>Open the same session, read the reply, keep talking.</td></tr>
  <tr><td>A tool is waiting for approval</td><td>Review the request, approve or reject.</td></tr>
  <tr><td>You want to see a generated file</td><td>Tap the file link and preview it.</td></tr>
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

Add a fixed HTTPS domain in connection settings, or deploy the included `remote-server` relay. Once the public entry passes verification, the panel's QR code points to that domain. On first public pairing, both sides compare the host fingerprint.

The opened page also tries a direct LAN connection. When both routes are up, LAN wins by default — you can flip this to public-first in connection settings. If one route drops, the page switches to the other. When the public entry is down, the panel falls back to a LAN QR code. On HTTPS pages with Service Worker support, an established direct connection can still open workspace HTML previews while the public route is temporarily out.

**🔒 Only approve devices you trust.** A paired phone has near-local privileges. Public nodes terminate TLS, so their operators can read forwarded traffic — there is no end-to-end encryption. Use a node you run yourself or an operator you trust. The project does not run a public relay.

[Self-hosting guide](docs/self-host.md) · [Public node protocol](docs/public-node.md) · [Plugin capabilities and host interfaces](docs/features.md) (guides in Chinese)

## 📄 Credits and license

Thanks to [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) for the early implementation. MIT license; copyright notice in [LICENSE](LICENSE).
