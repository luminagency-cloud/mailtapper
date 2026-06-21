import { ImapFlow } from "imapflow";

export interface ConnCfg {
  host: string;
  port: number;
  tlsMode: "ssl" | "starttls" | "none";
  allowInvalidCert: boolean;
  username: string;
}

/** Build an ImapFlow client with EXPLICIT TLS (never guessed from the port). */
export function buildClient(cfg: ConnCfg, password: string): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tlsMode === "ssl", // 'starttls' -> secure:false, ImapFlow upgrades when advertised
    tls: { rejectUnauthorized: !cfg.allowInvalidCert }, // the self-signed long-tail escape hatch
    auth: { user: cfg.username, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 7_000,
    socketTimeout: 30_000,
    logger: false,
  });
}

/** Translate raw IMAP/socket errors into something a user can act on. */
export function formatMailError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/(invalid login|authenticat|\bauth\b)/.test(msg)) return "Authentication failed. Check the email address and password.";
  if (/(timed out|timeout)/.test(msg)) return "Connection timed out. Check the host, port, and network reachability.";
  if (/(enotfound|getaddrinfo)/.test(msg)) return "Host not found. Check the server hostname.";
  if (/econnrefused/.test(msg)) return "Connection refused — is the port right? (993 = SSL, 143 = STARTTLS)";
  if (/(self.?signed|depth zero|unable to verify)/.test(msg)) return "TLS certificate not trusted. If this host uses a self-signed cert, enable allow_invalid_cert.";
  if (/(certificate|tls|ssl)/.test(msg)) return "TLS negotiation failed. Try a different tls_mode.";
  return error instanceof Error ? error.message : "Unknown connection error";
}

/** One-shot connectivity test, run BEFORE a connection is saved. */
export async function testImapConnection(
  cfg: ConnCfg,
  password: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = buildClient(cfg, password);
  try {
    await client.connect();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: formatMailError(err) };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}
