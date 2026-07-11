#!/usr/bin/env node
// Nightly diagnostic (S12.4): can this runner reach the WebRTC media plane at all?
// - STUN binding request over UDP to stun.cloudflare.com:3478 (the §7.1 ICE config's STUN)
// - TCP connect to turn.cloudflare.com:{3478,443} (TURN/TLS fallback path)
// Informational only — always exits 0; the job log shows which egress paths work so a red
// @realtime suite can be attributed (UDP blocked → TURN-only; TCP 443 blocked → no path).
import dgram from "node:dgram";
import net from "node:net";

function stunProbe(host, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    // Minimal RFC 5389 binding request: type 0x0001, length 0, magic cookie, 12-byte tx id.
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);
    req.writeUInt16BE(0x0000, 2);
    req.writeUInt32BE(0x2112a442, 4);
    for (let i = 8; i < 20; i += 1) req[i] = Math.floor(Math.random() * 256);
    const timer = setTimeout(() => {
      sock.close();
      resolve(false);
    }, 4000);
    sock.on("message", () => {
      clearTimeout(timer);
      sock.close();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    sock.send(req, port, host);
  });
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 4000 });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(false));
  });
}

const stunUdp = await stunProbe("stun.cloudflare.com", 3478);
const turnTcp3478 = await tcpProbe("turn.cloudflare.com", 3478);
const turnTcp443 = await tcpProbe("turn.cloudflare.com", 443);
console.log(
  `webrtc-egress-probe: STUN udp/3478=${stunUdp} TURN tcp/3478=${turnTcp3478} TURN tcp/443=${turnTcp443}`,
);
if (!stunUdp)
  console.log("webrtc-egress-probe: UDP looks blocked — media must relay over TURN/TCP-TLS");
