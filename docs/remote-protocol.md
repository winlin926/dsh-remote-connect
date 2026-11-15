# Browser remote protocol v1

The public HTTPS origin serves the QR landing page, host resources, and authenticated JSON APIs. Both endpoints open outbound WebSockets to `/v1/control`; the Server only authenticates devices, authorizes a single Host/Client relationship, coordinates ICE, and relays opaque Noise ciphertext.

## Pairing

Host registration is one time. `POST /v1/hosts` accepts `{ deviceId, name, identityKey, clientVersion }` and returns an opaque Host credential. The credential is stored by the Host and is never included in a QR code.

An authenticated Host calls `POST /v1/pairings` with `{ ticket, expiresAt }`. `ticket` is 32 random bytes encoded as canonical base64url; expiry is at most five minutes. The response includes the server-verified Host descriptor. The QR URL is `/pair#v=1&ticket=...&host=...&key=...`; the browser removes the fragment from its visible history before its first request. The Host public key in the QR is the trust anchor for this pairing.

The browser creates or reuses an X25519 browser identity in IndexedDB, then calls `POST /v1/pairings/claim` with `{ ticket, client: { deviceId, name, platform, identityKey } }`. The service verifies the ticket hash and Host descriptor, allocates a short-lived request, and returns `{ requestId, host, verificationCode, expiresAt }`. The eight-digit comparison code is independently computed by the browser and Host from the ticket, Host key, and Client key. Only its equality is displayed; it is not an authentication credential.

The browser explicitly confirms the Host identity and code. Separately, the Host UI displays the same code and requires local approval. The pairing is complete only after both decisions. A new browser receives a Secure, HttpOnly, SameSite=Strict service cookie; an existing browser must present its cookie and the same pinned Client key. The Host persists the paired Client descriptor locally. Tickets and pending requests are single use, expire within five minutes, and cannot grant access to another Host.

`GET /v1/hosts` lists only Hosts paired with the authenticated browser. `DELETE /v1/hosts/:hostId/devices/:deviceId` revokes one relationship and closes its active connections. A changed Host key fails closed and requires a new QR pairing. The browser cookie is scoped to the HTTPS service origin; clearing browser storage or changing origins requires pairing again.

## Control and data

The WebSocket uses the vendored protocol's bounded JSON control frame format. `hello` authenticates `host` or `client` credentials; `hello.ack` negotiates protocol v1 and capabilities. Pairing adds `pair.request`, `pair.approve`, `pair.reject`, `pair.complete`, and `device.revoked` frames.

`connect.request` is authorized only for an active paired relationship. The Server sends `connect.incoming` to the Host and returns `connect.accepted` to the browser. One ICE session tries LAN, P2P, and configured TURN candidates. Each selected path uses the same Noise IK handshake and pinned Host identity. If RTC is unavailable or ICE fails within the negotiated connection budget, both peers use the authenticated WSS Relay. The Server validates connection, device, target, frame-size, rate, and backpressure limits; it does not decrypt, persist, or log Noise payloads.

On the selected data carrier, `RemoteMessage` requests and events carry the Host HTTP/Remote API bridge. Unknown-result mutations are never replayed when a connection closes. A reconnect creates a new connection ID, rechecks authorization, and performs a fresh Noise handshake.

Static DSH shell assets use HTTPS with revisioned, browser-cacheable URLs. The Host's live client-bundle manifest is checked on entry. Bundle and asset URLs include the Host ID and manifest revision so that private assets never share a cache key across Hosts. DSH API calls and the `/api/remote.mux` WebSocket use the authenticated encrypted data carrier.

## Limits and deployment

The service requires HTTPS/WSS. Host registration, pairing claims, active connections, pending RPCs, and relay bytes are rate- and size-limited. A configured TURN service uses expiring HMAC credentials; TURN carries encrypted packets and is not replaced by an HTTPS reverse proxy. Self-hosting uses the same protocol and requires a durable SQLite database on one service instance, or PostgreSQL plus shared presence/relay coordination for multiple instances.

Custom domains are optional HTTPS aliases. The domain owner proves control with a DNS TXT challenge and maps the name to the service. The edge terminates TLS and must preserve the original validated host; Host-to-Server connections and cookies remain scoped to the selected origin. The default service origin remains usable without custom DNS.
