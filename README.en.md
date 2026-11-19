<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" width="112" height="112" alt="dsh-carry" />
</p>
<h1 align="center">dsh-carry</h1>
<p align="center"><strong>Pick up your DSH session on your phone.</strong></p>
<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/31a9e5729812e46646e2b1ca02883d701ed95477/assets/dsh-plugin.svg" alt="DSH | Plugin" />
</p>
<p align="center">
  <a href="https://github.com/winlin926/dsh-carry/blob/main/README.md">简体中文</a> · English · <a href="https://www.npmjs.com/package/@winlin926/dsh-carry">npm package</a> · <a href="https://github.com/winlin926/dsh-carry/releases">Releases</a>
</p>

`dsh-carry` lets you use the DeepSeek Harness (DSH) instance running on your computer from a phone browser. Scan a QR code to pair, then continue a conversation, approve tool requests, and view workspace files or HTML previews. Your phone connects to the computer’s DSH instance, so available sessions and tools depend on the host.

## 📦 Install and pair your phone

Install the plugin on the computer you want to reach. In the **DSH desktop app**, open **Plugins → Add plugin** and search for `@winlin926/dsh-carry`. For **`dsh web`**, run this command.

```sh
dsh plugin --profile web add @winlin926/dsh-carry@latest
```

The desktop app and `dsh web` keep separate plugin profiles. If the Remote Control panel is missing, check which profile you installed the plugin in.

1. Connect your phone and computer to the same Wi-Fi. On the computer, open **Remote Control** (远程控制), select **Same Wi-Fi** (同一 Wi-Fi), and enable the connection.
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
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.png" width="30%" alt="A new DSH session in the phone browser" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" width="30%" alt="An existing conversation with its message input on the phone" />
</p>
<p align="center">Boot screen preview · New session · Ongoing conversation</p>

<details>
<summary>More phone screenshots — workspace tools and settings</summary>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" width="32%" alt="Workspace tools on the phone" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" width="32%" alt="DSH general settings on the phone" />
</p>

</details>

## 🌐 Connecting from another network

On the same LAN, the phone can connect directly to your computer. For mobile data or another Wi-Fi network, use an HTTPS tunnel gateway with a fixed domain or deploy the included `remote-server` relay. During public pairing, compare the host fingerprint on both devices to confirm you have reached your computer.

**🔒 Approve only devices you trust.** A paired phone has privileges close to local access. Public nodes terminate TLS, so their operators can read forwarded content. Choose a node you run or an operator you trust. The project does not operate a public relay.

[Self-hosting guide](docs/self-host.md) · [Public node protocol](docs/public-node.md) · [Plugin capabilities and host interfaces](docs/features.md) (guides in Chinese)

## 📄 Credits and license

Based on [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control), with the original attribution preserved. Released under the [MIT License](LICENSE).
