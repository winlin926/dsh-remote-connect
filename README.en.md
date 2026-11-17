# dsh-carry

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" alt="dsh-carry logo: a computer and phone linked by an infinity symbol" width="160" height="160" />
</p>

[简体中文](https://github.com/winlin926/dsh-carry/blob/main/README.md) | English

**Operate a running DeepSeek Harness (DSH) from a phone browser.** View sessions, send messages, respond to tool approvals, and preview workspace files — no app to install, no second DSH instance.

The phone always opens the **host's own Web UI**, so what is available on the phone depends on your host version.

## Install

```bash
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

You can also search for `@winlin926/dsh-carry` under **Plugins → Add plugin** in DSH.

> **Note**: the desktop app and `dsh web` use separate profiles. Install into the profile of the **DSH host you actually want to connect to**, otherwise the panel will not appear on that machine.

## Quick start (same Wi-Fi)

1. Make sure the phone and the computer are on the same Wi-Fi.
2. On the computer, open the **Remote Control** (远程控制) panel, select **Same Wi-Fi** and turn the connection on.
3. Scan the QR code with the phone, then approve the pairing request on the computer.
4. Once paired, continue the session directly in the phone browser.

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" alt="Remote control panel on the host computer: enable access, pair devices, and manage authorized devices" width="760" />
</p>

<p align="center"><strong>Host computer: enable access, pair devices, manage authorizations</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.png" alt="New DSH session in a phone browser" width="23%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" alt="DSH conversation and message input on a phone" width="23%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" alt="Workspace tools in a phone browser" width="23%" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" alt="DSH general settings in a phone browser" width="23%" />
</p>

<p align="center"><strong>Phone: new session · conversation · workspace tools · settings</strong></p>

## Features

- **Keep using DSH on a phone**: open the host's Web UI directly to view and continue sessions, send messages and answer tool approvals. What works on the phone is decided by the host version.
- **QR pairing and device management**: a new device must be approved on the computer. Authorized devices can be reviewed and revoked at any time.
- **Workspace file previews**: open files and HTML pages from the computer's workspace on the phone. Ordinary files up to 48 MiB.
- **LAN HTTPS and connection diagnostics**: configure a domain certificate the phone trusts for the LAN entry point; startup checks validate the certificate and port settings.
- **Self-hosted access across networks**: use a fixed-domain tunnel gateway, or deploy your own `remote-server` node. One node can serve several computers with separate connections.
- **Node and host identity checks**: verify the node before connecting; during public pairing, the phone and the computer each confirm the target host fingerprint.
- **Local plugin updates**: check for updates from the panel on the computer and let the DSH plugin manager install them.

## Public access and self-hosting

Reaching DSH over mobile data or another Wi-Fi needs an HTTPS public node you trust:

```text
Phone browser → HTTPS public node → tunnel → DSH on the computer
```

Use an existing HTTPS tunnel gateway, or deploy this repository's `remote-server/` on your own server. See the [self-hosted node guide](docs/self-host.md) for deployment and the [public node protocol](docs/public-node.md) for the protocol. Both guides are currently in Chinese.

## Security boundaries

- A paired phone has permissions close to local access on the computer — **only approve devices you trust**.
- Public nodes terminate TLS and forward requests, so **node or tunnel operators may see the forwarded content**. This plugin provides no end-to-end encryption and operates no public nodes.
- Use only nodes you trust, and always connect over HTTPS.

## Migrating from the old package

The package `@winlin926/dsh-remote-connect` is deprecated. The new package keeps its runtime identifiers, so migration needs no re-pairing:

1. Remove `@winlin926/dsh-remote-connect` in DSH's plugin manager.
2. Install `@winlin926/dsh-carry`.
3. Restart the host.

Both packages cannot be installed in the same profile. Device authorizations, public nodes and preferences stay in `~/.dsh/dsh-remote-connect/<profile>` and keep working after the move.

## Credits and license

Maintained from [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control), retaining the original author's attribution and the MIT license. See [LICENSE](LICENSE).
