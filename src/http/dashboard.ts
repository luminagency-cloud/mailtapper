/**
 * The only human surface in v1: a thin connection-manager page served at GET / .
 * Self-contained (no build step, no framework). The page holds no secrets — the
 * operator pastes an API key (kept in localStorage) and the page's fetch() calls
 * carry it as the Bearer token to the same-origin /v1/* control-plane endpoints.
 *
 * NOTE: serving "/" is unauthenticated (the shell only). For anything beyond a
 * single-operator self-host, put it behind Caddy basic-auth / an IP allowlist / a VPN.
 * The inner JS uses string concatenation (no backticks or template interpolation) so it embeds cleanly.
 */
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mailtapper — Connections</title>
<style>
  :root { --ink:#1a1d24; --muted:#5b6573; --line:#e4e7ec; --bg:#fbfcfd; --accent:#25636b;
    --chip:#eef3f4; --ok:#1a7f53; --err:#b42318; --warn:#9a6a00; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:860px; margin:0 auto; padding:40px 22px 80px; }
  header { display:flex; align-items:baseline; gap:10px; border-bottom:2px solid var(--ink);
    padding-bottom:12px; margin-bottom:22px; }
  h1 { font-size:24px; margin:0; }
  h2 { font-size:17px; margin:28px 0 12px; }
  .muted { color:var(--muted); } .small { font-size:12px; }
  section { margin-bottom:14px; }
  .keybar { display:flex; align-items:center; gap:8px; background:#fff; border:1px solid var(--line);
    border-radius:8px; padding:10px 12px; }
  .keybar label { font-weight:600; }
  input, select { font:inherit; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:#fff; }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:0; }
  .keybar input { flex:1; }
  button { font:inherit; cursor:pointer; border:1px solid var(--accent); background:var(--accent); color:#fff;
    padding:7px 13px; border-radius:6px; }
  button.ghost { background:#fff; color:var(--ink); border-color:var(--line); padding:4px 9px; font-size:13px; }
  button.danger { color:var(--err); border-color:#f0c5c0; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; background:#fff;
    border:1px solid var(--line); border-radius:8px; padding:16px; }
  .grid label { display:flex; flex-direction:column; gap:4px; font-size:13px; font-weight:600; color:var(--muted); }
  .grid label input, .grid label select { font-weight:400; color:var(--ink); }
  .grid label.check { flex-direction:row; align-items:center; gap:8px; grid-column:1 / -1; }
  .grid button[type=submit] { grid-column:1 / -1; justify-self:start; }
  .msg { min-height:18px; font-size:13px; margin:8px 2px 0; }
  .msg.ok { color:var(--ok); } .msg.err, .err { color:var(--err); }
  table { width:100%; border-collapse:collapse; font-size:13px; background:#fff;
    border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:9px 11px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:var(--chip); font-size:12px; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .badge.ok { background:#e6f4ec; color:var(--ok); }
  .badge.err { background:#fbeae8; color:var(--err); }
  .badge.warn { background:#fbf2dd; color:var(--warn); }
  td.actions { white-space:nowrap; }
  #refresh { margin-left:8px; }
</style>
</head>
<body>
<div class="wrap">
  <header><h1>🛠️ Mailtapper</h1><span class="muted">connection manager</span></header>

  <section class="keybar">
    <label for="key">API key</label>
    <input id="key" type="password" placeholder="mtapper_live_..." autocomplete="off" />
    <button id="saveKey">Save</button>
    <span id="keyState" class="muted small"></span>
  </section>

  <section>
    <h2>Add a mailbox</h2>
    <form id="addForm" class="grid" autocomplete="off">
      <label>Label <input name="label" placeholder="Work" /></label>
      <label>Host <input name="host" required placeholder="mail.yourhost.com" /></label>
      <label>Port <input name="port" type="number" value="993" required /></label>
      <label>TLS mode
        <select name="tls_mode">
          <option value="ssl">ssl (implicit, 993)</option>
          <option value="starttls">starttls (143/587)</option>
          <option value="none">none</option>
        </select>
      </label>
      <label class="check"><input name="allow_invalid_cert" type="checkbox" /> Allow invalid / self-signed cert</label>
      <label>Username <input name="username" required placeholder="you@yourdomain.com" /></label>
      <label>Password <input name="password" type="password" required /></label>
      <label>Source account <input name="source_account" placeholder="(defaults to username)" /></label>
      <label>Provider tag <input name="provider" value="imap_generic" /></label>
      <button type="submit">Validate &amp; add</button>
    </form>
    <p id="addMsg" class="msg"></p>
  </section>

  <section>
    <h2>Connections <button id="refresh" class="ghost">refresh</button></h2>
    <table>
      <thead><tr><th>Label</th><th>Account</th><th>Host</th><th>TLS</th><th>Status</th><th>Last check</th><th></th></tr></thead>
      <tbody id="connBody"><tr><td colspan="7" class="muted">Set your API key to load connections.</td></tr></tbody>
    </table>
  </section>
</div>

<script>
  var $ = function (s) { return document.querySelector(s); };
  function getKey() { return localStorage.getItem("mtap_key") || ""; }
  function reflectKey() { $("#keyState").textContent = getKey() ? "saved" : "not set"; }
  $("#key").value = getKey();
  reflectKey();
  $("#saveKey").onclick = function () { localStorage.setItem("mtap_key", $("#key").value.trim()); reflectKey(); loadConns(); };

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m];
    });
  }
  function badge(status) {
    var c = status === "active" ? "ok" : status === "error" ? "err" : "warn";
    return "<span class='badge " + c + "'>" + esc(status) + "</span>";
  }

  async function api(path, opts) {
    opts = opts || {};
    var key = getKey();
    if (!key) throw new Error("Set your API key first.");
    var headers = { authorization: "Bearer " + key, "content-type": "application/json" };
    var res = await fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body });
    var text = await res.text();
    var data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }

  async function loadConns() {
    var body = $("#connBody");
    if (!getKey()) { body.innerHTML = "<tr><td colspan='7' class='muted'>Set your API key to load connections.</td></tr>"; return; }
    body.innerHTML = "<tr><td colspan='7' class='muted'>Loading...</td></tr>";
    try {
      var out = await api("/v1/connections");
      var rows = (out && out.data) || [];
      if (!rows.length) { body.innerHTML = "<tr><td colspan='7' class='muted'>No connections yet. Add one above.</td></tr>"; return; }
      body.innerHTML = rows.map(function (c) {
        var when = c.last_validated_at ? new Date(c.last_validated_at).toLocaleString() : "—";
        var errLine = c.last_error ? "<div class='err small'>" + esc(c.last_error) + "</div>" : "";
        return "<tr>" +
          "<td>" + (esc(c.label) || "—") + "</td>" +
          "<td>" + esc(c.source_account) + "</td>" +
          "<td>" + esc(c.host) + ":" + esc(c.port) + "</td>" +
          "<td>" + esc(c.tls_mode) + "</td>" +
          "<td>" + badge(c.status) + errLine + "</td>" +
          "<td class='muted small'>" + when + "</td>" +
          "<td class='actions'><button class='ghost' data-test='" + esc(c.id) + "'>test</button> " +
          "<button class='ghost danger' data-del='" + esc(c.id) + "'>delete</button></td>" +
          "</tr>";
      }).join("");
    } catch (e) {
      body.innerHTML = "<tr><td colspan='7' class='err'>" + esc(e.message) + "</td></tr>";
    }
  }

  $("#refresh").onclick = loadConns;

  $("#addForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var f = ev.target, msg = $("#addMsg");
    var payload = {
      label: f.label.value || undefined,
      host: f.host.value.trim(),
      port: Number(f.port.value),
      tls_mode: f.tls_mode.value,
      allow_invalid_cert: f.allow_invalid_cert.checked,
      username: f.username.value.trim(),
      password: f.password.value,
      source_account: f.source_account.value.trim() || undefined,
      provider: f.provider.value.trim() || undefined
    };
    msg.textContent = "Validating..."; msg.className = "msg";
    try {
      var c = await api("/v1/connections", { method: "POST", body: JSON.stringify(payload) });
      msg.textContent = "Added (" + c.status + ")"; msg.className = "msg ok";
      f.reset(); f.port.value = "993"; f.provider.value = "imap_generic";
      loadConns();
    } catch (e) { msg.textContent = e.message; msg.className = "msg err"; }
  });

  $("#connBody").addEventListener("click", async function (ev) {
    var btn = ev.target.closest("button"); if (!btn) return;
    var testId = btn.getAttribute("data-test"), delId = btn.getAttribute("data-del");
    try {
      if (testId) { btn.textContent = "..."; await api("/v1/connections/" + testId + "/test", { method: "POST" }); loadConns(); }
      if (delId) { if (!confirm("Delete this connection?")) return; await api("/v1/connections/" + delId, { method: "DELETE" }); loadConns(); }
    } catch (e) { alert(e.message); }
  });

  loadConns();
</script>
</body>
</html>
`;
