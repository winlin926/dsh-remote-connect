# dsh-carry

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" alt="dsh-carry logo: a computer and phone linked by an infinity symbol" width="160" height="160" />
</p>

[简体中文](https://github.com/winlin926/dsh-carry/blob/main/README.md) | English

**A remote control plugin for DeepSeek Harness (DSH): operate your running DSH instance from a phone or another computer's browser.** View sessions, send messages, respond to tool approval requests, and preview files on the host computer. No phone app or additional DSH instance is required.

The remote browser opens the Web UI provided by your existing DSH host. Connect over the same local network, or set up a fixed HTTPS domain and tunnel gateway or a self-hosted public relay node for access across networks.

**On the same local network: scan the QR code on a phone, or open the pairing link on another computer, then approve the device on the host computer.**

## Quick start

In DSH, open **Plugins → Add plugin**, then find and install:

```text
@winlin926/dsh-carry
```

For `dsh web`, you can also install it into the `web` profile from the command line:

```bash
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

Install the plugin in the profile of the DSH host you want to access. The desktop app and `dsh web` use separate profiles.

### Connect over a local network

1. Connect the remote device and the computer running DSH to the same local network.
2. On the host computer, open the remote connection panel (**远程连接**), select **Same Wi-Fi** (**同一 Wi-Fi**), and enable the connection.
3. On a phone, scan the QR code. On another computer, open the full pairing link provided by **Copy link** (**复制链接**) in the panel.
4. Approve the pairing request on the computer running DSH, then continue your session in the remote browser.

## Upgrade and migration

The old package is no longer maintained. To migrate from `@winlin926/dsh-remote-connect` to `@winlin926/dsh-carry`:

1. Remove `@winlin926/dsh-remote-connect` in DSH's plugin manager.
2. Install `@winlin926/dsh-carry`.
3. Restart the DSH host.

Do not install both packages in the same profile. The new package continues to use the existing storage directory, `~/.dsh/dsh-remote-connect/<profile>`, and management API. Device authorizations, public nodes, and preferences remain available after migration; you do not need to pair your devices again.

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" alt="Remote connection panel on the host computer: enable access, pair devices, and manage authorized devices" width="760" />
</p>

<p align="center"><strong>Host computer: enable access, pair devices, and manage authorizations</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.png" alt="New DSH session in a phone browser" width="300" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" alt="DSH conversation and message input on a phone" width="300" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" alt="Workspace tools in a phone browser" width="300" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" alt="DSH general settings in a phone browser" width="300" />
</p>

<p align="center"><strong>Phone: new session · conversation · workspace tools · general settings</strong></p>

## Features

- **Browser remote control:** open the existing DSH host's Web UI from a phone or another computer to view and continue sessions, send messages, and respond to tool approval requests. Available remote features depend on the DSH host.
- **QR pairing and device management:** approve new devices on the host computer, view authorized devices, and revoke access at any time.
- **Workspace file previews:** open files and HTML pages from the host computer in the remote browser. Ordinary files can be up to 48 MiB.
- **Public access options:** use a fixed-domain tunnel gateway or deploy a `remote-server` relay node. A self-hosted node can serve multiple host computers with separate connections.
- **Node and host identity checks:** verify the node's identity before connecting. During public pairing, confirm the target host's fingerprint on both the remote device and the host computer.
- **Local HTTPS and connection diagnostics:** configure a domain certificate trusted by the remote device for local access. Startup checks validate certificates, ports, and related settings.
- **Local plugin updates:** check for updates from the host computer's remote connection panel and install them through the DSH plugin manager.

## Public access and self-hosting

Access across networks requires a trusted HTTPS public node. Use an existing tunnel gateway, or deploy `remote-server/` on your own server:

```text
Phone or computer browser → HTTPS public node → tunnel → DSH on the host computer
```

See the [self-hosted node guide](docs/self-host.md) for deployment instructions and the [public node protocol](docs/public-node.md) for the protocol specification. These detailed guides are currently in Chinese.

## Security boundaries

Paired remote devices have permissions similar to local access on the host computer. Only approve devices you trust. Public nodes terminate TLS and forward requests, so node or tunnel operators may see the forwarded content. The plugin does not provide end-to-end encryption or operate public nodes. Use trusted nodes and connect over HTTPS.

## Credits and license

This project is maintained from [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control), retaining the original author's attribution and MIT license. See [LICENSE](LICENSE).
