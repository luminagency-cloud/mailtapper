import net from "node:net";

// These tests mock SMTP and IMAP. If anything dials a socket, fail instead of sending mail.
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function blockedConnect(this: net.Socket, ...args: unknown[]) {
  const target = args
    .map((part) => {
      if (part && typeof part === "object") {
        const rec = part as { host?: string; port?: number; path?: string };
        if (rec.path) return rec.path;
        if (rec.host || rec.port) return `${rec.host ?? ""}:${rec.port ?? ""}`;
      }
      return typeof part === "string" || typeof part === "number" ? String(part) : "";
    })
    .filter(Boolean)
    .join(" ");
  throw new Error(`Refusing to open a network socket during tests${target ? ` (${target})` : ""}`);
} as unknown as typeof original;

void original;
