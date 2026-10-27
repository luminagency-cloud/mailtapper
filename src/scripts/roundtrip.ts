/**
 * Live round-trip check through the public API: mailbox A sends to B and B sends to A, then
 * each INBOX is polled until the message arrives. Opt-in; it sends real mail.
 *   MAILTAPPER_API_KEY=mtapper_live_... npm run test:roundtrip
 * Env:
 *   MAILTAPPER_API_KEY    key with connections:read, messages:read, messages:send (required)
 *   MAILTAPPER_BASE_URL   default https://mailtapper.luminagency.com
 *   ROUNDTRIP_A, ROUNDTRIP_B   connection ids; default = the first two active send-enabled ones
 *   ROUNDTRIP_TIMEOUT_SECONDS  default 120
 * Exit code 0 = both arrived. Send-side and receive-side failures are reported separately.
 */
const base = (process.env.MAILTAPPER_BASE_URL ?? "https://mailtapper.luminagency.com").replace(/\/+$/, "");
const key = process.env.MAILTAPPER_API_KEY;
const timeoutMs = Number(process.env.ROUNDTRIP_TIMEOUT_SECONDS ?? 120) * 1000;
if (!key) {
  console.error("Set MAILTAPPER_API_KEY (scopes: connections:read, messages:read, messages:send).");
  process.exit(2);
}

interface Conn { id: string; username: string; source_account: string; status: string; send_enabled: boolean }

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(base + path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}: ${data?.error ?? "no body"}`);
  return data as T;
}

const { data: conns } = await call<{ data: Conn[] }>("/v1/connections");
const usable = conns.filter((c) => c.status === "active" && c.send_enabled);
const pick = (id: string | undefined, i: number) => (id ? conns.find((c) => c.id === id) : usable[i]);
const a = pick(process.env.ROUNDTRIP_A, 0);
const b = pick(process.env.ROUNDTRIP_B, 1);
if (!a || !b || a.id === b.id) {
  console.error(`Need two different send-enabled connections; found ${usable.length}. Set ROUNDTRIP_A and ROUNDTRIP_B.`);
  process.exit(2);
}

const subject = `MailTapper test ${new Date().toISOString()}`;
const since = new Date(Date.now() - 5 * 60_000).toISOString();
const legs = [
  { from: a, to: b },
  { from: b, to: a },
].map((l) => ({ ...l, name: `${l.from.source_account} -> ${l.to.source_account}`, sent: false, arrived: false, error: "" }));

console.log(`Base ${base}\nSubject "${subject}"`);
for (const leg of legs) {
  try {
    const r = await call<{ accepted: string[]; rejected: string[] }>(`/v1/connections/${leg.from.id}/send`, {
      method: "POST",
      body: { to: [leg.to.source_account], subject, text: `Round-trip check from ${leg.from.source_account}.` },
    });
    if (r.rejected.length) throw new Error(`rejected by SMTP: ${r.rejected.join(", ")}`);
    leg.sent = true;
  } catch (err) {
    leg.error = (err as Error).message;
  }
}

const deadline = Date.now() + timeoutMs;
let poll = 0;
while (legs.some((l) => l.sent && !l.arrived) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  poll += 1;
  for (const leg of legs.filter((l) => l.sent && !l.arrived)) {
    // `poll` only changes the cache key: /v1/messages caches identical queries for CACHE_TTL_SECONDS.
    const q = new URLSearchParams({ connection_id: leg.to.id, subject, since, poll: String(poll) });
    try {
      const { data } = await call<{ data: { subject: string | null }[] }>(`/v1/messages?${q}`);
      leg.arrived = data.some((m) => m.subject === subject);
    } catch (err) {
      leg.error = (err as Error).message;
    }
  }
}

let ok = true;
for (const leg of legs) {
  const result = !leg.sent ? `FAIL (send side): ${leg.error}` : leg.arrived ? "PASS" : `FAIL (receive side): not in INBOX after ${timeoutMs / 1000}s${leg.error ? `; last error: ${leg.error}` : ""}`;
  if (result !== "PASS") ok = false;
  console.log(`${leg.name}: ${result}`);
}
process.exit(ok ? 0 : 1);

export {}; // module, for top-level await
