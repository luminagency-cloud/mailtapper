/**
 * The only human surface in v1: a thin admin + connection-manager page served at GET / .
 * Self-contained (no build step, no framework). The page holds no secrets. The operator
 * pastes an API key (kept in localStorage) and fetch() carries it as a Bearer token to
 * same-origin /v1/* endpoints.
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
<title>Mailtapper Admin</title>
<style>
  :root {
    --ink:#000; --muted:#000; --line:#000; --bg:#fff; --accent:#000;
    --chip:#000; --ok:#000; --err:#000; --warn:#000; --panel:#fff; --hi:#ffd400;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:18px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:40px 24px 88px; }
  header { display:flex; align-items:baseline; gap:12px; border-bottom:3px solid var(--ink);
    padding-bottom:14px; margin-bottom:22px; }
  h1 { font-size:32px; line-height:1.15; margin:0; letter-spacing:0; }
  h2 { font-size:24px; line-height:1.2; margin:30px 0 14px; }
  .muted { color:var(--muted); } .small { font-size:15px; }
  section { margin-bottom:20px; }
  .keybar { display:flex; align-items:center; gap:10px; background:var(--panel); border:2px solid var(--line);
    border-radius:8px; padding:13px 14px; }
  .keybar label { font-weight:700; white-space:nowrap; }
  input, select { font:inherit; color:#000; padding:10px 11px; border:2px solid var(--line); border-radius:6px; background:#fff; }
  input::placeholder { color:#000; }
  input:focus, select:focus { outline:4px solid var(--hi); outline-offset:2px; }
  .keybar input { flex:1; min-width:160px; }
  button { font:inherit; cursor:pointer; border:1px solid var(--accent); background:var(--accent);
    padding:10px 16px; border-radius:6px; }
  button { border:2px solid #000; background:#000; color:var(--hi); font-weight:700; }
  button.ghost { background:#fff; color:#000; border-color:#000; padding:7px 12px; font-size:16px; }
  button.danger { color:#000; border-color:#000; }
  .tabs { display:flex; gap:8px; margin:22px 0 6px; border-bottom:2px solid var(--line); }
  .tab { border:2px solid #000; border-bottom:0; border-radius:6px 6px 0 0; background:#fff; color:#000;
    padding:11px 14px 10px; font-weight:800; }
  .tab.active { background:#000; color:var(--hi); border-color:#000; }
  .view { display:none; }
  .view.active { display:block; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px 16px; background:var(--panel);
    border:2px solid var(--line); border-radius:8px; padding:18px; }
  .grid label { display:flex; flex-direction:column; gap:6px; font-size:16px; font-weight:700; color:var(--muted); }
  .grid label input, .grid label select { font-weight:400; color:var(--ink); }
  .grid label.check { flex-direction:row; align-items:center; gap:10px; grid-column:1 / -1; }
  .advanced { grid-column:1 / -1; display:grid; grid-template-columns:1fr 1fr; gap:14px 16px; }
  .advanced summary { grid-column:1 / -1; cursor:pointer; font-weight:800; }
  .account-label { display:block; font-size:15px; font-weight:700; margin-top:4px; }
  .form-actions { grid-column:1 / -1; display:flex; gap:10px; flex-wrap:wrap; }
  .hidden { display:none; }
  .msg { min-height:22px; font-size:16px; margin:10px 2px 0; }
  .msg.ok { color:#000; } .msg.err, .err { display:inline-block; background:#000; color:var(--hi); padding:2px 6px; }
  .action-row { display:flex; align-items:center; gap:8px; flex-wrap:nowrap; }
  .pull-toggle { display:flex; align-items:center; gap:6px; white-space:nowrap; font-size:15px; font-weight:700; }
  .pull-toggle input { width:18px; height:18px; }
  .result { border:2px solid #000; border-radius:8px; margin:0; padding:12px; background:#fff; }
  .result-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
  .result-title { margin:0; font-weight:800; }
  .result pre { margin:0; padding:10px; border:2px solid #000; background:#000; color:var(--hi);
    white-space:pre-wrap; word-break:break-word; max-height:340px; overflow:auto;
    font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .table-wrap { width:100%; overflow-x:auto; border:2px solid var(--line); border-radius:8px; background:var(--panel); }
  table { width:100%; border-collapse:collapse; font-size:16px; min-width:820px; }
  th, td { text-align:left; padding:12px 13px; border-bottom:2px solid var(--line); vertical-align:top; }
  th { background:var(--chip); color:var(--hi); font-size:15px; white-space:nowrap; }
  tbody tr:last-child td { border-bottom:0; }
  .badge { display:inline-block; padding:3px 9px; border-radius:999px; font-size:15px; font-weight:800; }
  .badge.ok, .badge.err, .badge.warn { background:#000; color:var(--hi); }
  .pill { display:inline-block; margin:0 5px 5px 0; padding:4px 8px; border:2px solid var(--line);
    border-radius:999px; color:var(--muted); background:#fff; white-space:nowrap; }
  td.actions { white-space:nowrap; min-width:430px; }
  .heading-row { display:flex; align-items:center; gap:10px; justify-content:space-between; }
  .heading-row h2 { margin-right:auto; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:15px; color:#000; background:#fff; }
  @media (max-width: 720px) {
    .wrap { padding:24px 14px 64px; }
    header { flex-direction:column; gap:0; }
    .keybar { align-items:stretch; flex-wrap:wrap; }
    .keybar label { width:100%; }
    .keybar input { flex-basis:100%; }
    .grid, .advanced { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header><h1>Mailtapper</h1><span class="muted">admin</span></header>

  <section class="keybar">
    <label for="key">API key</label>
    <input id="key" type="password" placeholder="mtapper_live_..." autocomplete="off" />
    <button id="saveKey">Save</button>
    <span id="keyState" class="muted small"></span>
  </section>

  <nav class="tabs" aria-label="Dashboard sections">
    <button class="tab active" data-tab="clients" type="button">Accounts</button>
    <button class="tab" data-tab="mailboxes" type="button">Mailboxes</button>
  </nav>

  <section id="clientsView" class="view active">
    <h2>Create account</h2>
    <form id="createClientForm" class="grid" autocomplete="off">
      <label>Account name <input name="client_name" required placeholder="Acme project" /></label>
      <label>Tier
        <select name="tier">
          <option value="free">free</option>
          <option value="pro">pro</option>
          <option value="scale">scale</option>
        </select>
      </label>
      <div class="form-actions">
        <button type="submit">Create account &amp; key</button>
      </div>
    </form>
    <p id="clientMsg" class="msg"></p>
    <div id="clientKeyResult" class="result hidden" aria-live="polite">
      <div class="result-head">
        <p class="result-title">New API key</p>
        <button id="closeClientKey" class="ghost" type="button">close</button>
      </div>
      <pre id="clientKeyBody"></pre>
    </div>

    <div class="heading-row">
      <h2>Accounts</h2>
      <button id="refreshClients" class="ghost" type="button">refresh</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Tier</th><th>Mailboxes</th><th>API key</th><th>Last activity</th><th>Created</th><th>ID</th><th></th></tr></thead>
        <tbody id="clientBody"><tr><td colspan="8" class="muted">Set your API key to load accounts.</td></tr></tbody>
      </table>
    </div>
  </section>

  <section id="mailboxesView" class="view">
    <h2 id="mailboxFormTitle">Add mailbox connection</h2>
    <form id="addForm" class="grid" autocomplete="off">
      <label>Email / username <input name="username" required placeholder="you@yourdomain.com" /></label>
      <label>Password <input name="password" type="password" required /></label>
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
      <details class="advanced">
        <summary>Optional metadata</summary>
        <label>Label <input name="label" placeholder="Work, Support, Billing" /></label>
        <label>Host name (optional) <input name="provider" placeholder="imap_generic" /></label>
      </details>
      <div class="form-actions">
        <button id="saveMailbox" type="submit">Validate &amp; add</button>
        <button id="cancelEdit" class="ghost hidden" type="button">cancel edit</button>
      </div>
    </form>
    <p id="addMsg" class="msg"></p>

    <div class="heading-row">
      <h2>Mailbox connections</h2>
      <button id="refreshConns" class="ghost" type="button">refresh</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Account</th><th>Host</th><th>TLS</th><th>Status</th><th>Last check</th><th></th></tr></thead>
        <tbody id="connBody"><tr><td colspan="7" class="muted">Set your API key to load connections.</td></tr></tbody>
      </table>
    </div>
  </section>
</div>

<script>
  var $ = function (s) { return document.querySelector(s); };
  var mailboxResults = {};
  var mailboxById = {};
  var editingMailboxId = null;
  var session = null;
  function getKey() { return localStorage.getItem("mtap_key") || ""; }
  function reflectKey() { $("#keyState").textContent = getKey() ? "saved" : "not set"; }
  $("#key").value = getKey();
  reflectKey();

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m];
    });
  }
  function badge(status) {
    var c = status === "active" || status === "pro" || status === "scale" ? "ok" : status === "error" ? "err" : "warn";
    return "<span class='badge " + c + "'>" + esc(status) + "</span>";
  }
  function fmtDate(value) {
    return value ? new Date(value).toLocaleString() : "never";
  }

  function showClientKey(title, payload) {
    $("#clientKeyResult").classList.remove("hidden");
    $("#clientKeyBody").textContent = title + "\\n\\n" +
      "API key (shown once):\\n" + payload.api_key + "\\n\\n" +
      "Scopes: " + ((payload.scopes || []).join(", ") || "none");
  }

  function isAdmin() {
    return !!(session && session.is_admin);
  }

  function applySessionUi() {
    var accountsTab = document.querySelector("[data-tab='clients']");
    if (accountsTab) accountsTab.classList.toggle("hidden", !isAdmin());
    if (!isAdmin() && $("#clientsView").classList.contains("active")) showTab("mailboxes");
  }

  async function loadSession() {
    if (!getKey()) {
      session = null;
      applySessionUi();
      return;
    }
    try {
      session = await api("/v1/me");
      applySessionUi();
    } catch (e) {
      session = null;
      applySessionUi();
      throw e;
    }
  }

  async function api(path, opts) {
    var result = await apiResult(path, opts);
    if (!result.http_ok) throw new Error((result.data && result.data.error) || ("HTTP " + result.status));
    return result.data;
  }

  async function apiResult(path, opts) {
    opts = opts || {};
    var key = getKey();
    if (!key) throw new Error("Set your API key first.");
    var headers = { authorization: "Bearer " + key, "content-type": "application/json" };
    var res = await fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body });
    var text = await res.text();
    var data = text ? JSON.parse(text) : null;
    return { status: res.status, http_ok: res.ok, data: data };
  }

  function setMailboxResult(id, title, result) {
    mailboxResults[id] = { title: title, result: result };
    var row = document.querySelector("[data-result-row='" + id + "']");
    if (row) row.outerHTML = renderResultRow(id);
  }

  function clearMailboxResult(id) {
    delete mailboxResults[id];
    var row = document.querySelector("[data-result-row='" + id + "']");
    if (row) row.remove();
  }

  function renderResultRow(id) {
    var entry = mailboxResults[id];
    if (!entry) return "";
    return "<tr data-result-row='" + esc(id) + "'><td colspan='6'>" +
      "<div class='result' aria-live='polite'>" +
      "<div class='result-head'><p class='result-title'>" + esc(entry.title) + "</p>" +
      "<button class='ghost' data-close-result='" + esc(id) + "' type='button'>close</button></div>" +
      "<pre>" + esc(JSON.stringify(entry.result, null, 2)) + "</pre>" +
      "</div></td></tr>";
  }

  function resetMailboxForm() {
    var f = $("#addForm");
    editingMailboxId = null;
    $("#mailboxFormTitle").textContent = "Add mailbox connection";
    $("#saveMailbox").textContent = "Validate & add";
    $("#cancelEdit").classList.add("hidden");
    f.reset();
    f.querySelector(".advanced").open = false;
    f.port.value = "993";
    f.provider.value = "";
    f.password.required = true;
    f.password.placeholder = "";
  }

  function editMailbox(id) {
    var c = mailboxById[id];
    if (!c) return;
    var f = $("#addForm");
    editingMailboxId = id;
    $("#mailboxFormTitle").textContent = "Edit mailbox connection";
    $("#saveMailbox").textContent = "Validate & save";
    $("#cancelEdit").classList.remove("hidden");
    f.label.value = c.label || "";
    f.host.value = c.host || "";
    f.port.value = c.port || 993;
    f.tls_mode.value = c.tls_mode || "ssl";
    f.allow_invalid_cert.checked = !!c.allow_invalid_cert;
    f.username.value = c.username || "";
    f.password.value = "";
    f.password.required = false;
    f.password.placeholder = "leave blank to keep current password";
    f.provider.value = c.provider === "imap_generic" ? "" : c.provider || "";
    f.querySelector(".advanced").open = !!c.label;
    $("#addMsg").textContent = "Editing " + (c.username || c.id);
    $("#addMsg").className = "msg";
    f.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showTab(name) {
    if (name === "clients" && !isAdmin()) name = "mailboxes";
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === name);
    });
    $("#clientsView").classList.toggle("active", name === "clients");
    $("#mailboxesView").classList.toggle("active", name === "mailboxes");
    localStorage.setItem("mtap_tab", name);
    if (name === "clients") loadClients();
    if (name === "mailboxes") loadConns();
  }
  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () { showTab(btn.getAttribute("data-tab")); });
  });

  async function loadClients() {
    var body = $("#clientBody");
    if (!getKey()) { body.innerHTML = "<tr><td colspan='8' class='muted'>Set your API key to load accounts.</td></tr>"; return; }
    body.innerHTML = "<tr><td colspan='8' class='muted'>Loading...</td></tr>";
    try {
      var out = await api("/v1/admin/clients");
      var rows = (out && out.data) || [];
      if (!rows.length) { body.innerHTML = "<tr><td colspan='8' class='muted'>No accounts yet.</td></tr>"; return; }
      body.innerHTML = rows.map(function (client) {
        var c = client.connections || {};
        var k = client.api_keys || {};
        var conn = "<span class='pill'>" + esc(c.total || 0) + " total</span>" +
          "<span class='pill'>" + esc(c.active || 0) + " active</span>" +
          (c.error ? "<span class='pill err'>" + esc(c.error) + " error</span>" : "");
        var keys = k.active === 1
          ? "<span class='pill'>1 active</span>"
          : "<span class='pill err'>" + esc(k.active || 0) + " active</span>";
        if ((k.total || 0) !== (k.active || 0)) keys += "<span class='pill'>" + esc(k.total || 0) + " historical</span>";
        return "<tr>" +
          "<td>" + esc(client.name) + "</td>" +
          "<td>" + badge(client.tier) + "</td>" +
          "<td>" + conn + "</td>" +
          "<td>" + keys + "</td>" +
          "<td class='muted small'>" + fmtDate(client.last_activity_at) + "</td>" +
          "<td class='muted small'>" + fmtDate(client.created_at) + "</td>" +
          "<td><code>" + esc(client.id) + "</code></td>" +
          "<td class='actions'><button class='ghost danger' data-rotate-client='" + esc(client.id) + "' type='button'>rotate key</button></td>" +
          "</tr>";
      }).join("");
    } catch (e) {
      body.innerHTML = "<tr><td colspan='8' class='err'>" + esc(e.message) + "</td></tr>";
    }
  }

  async function loadConns() {
    var body = $("#connBody");
    if (!getKey()) { body.innerHTML = "<tr><td colspan='6' class='muted'>Set your API key to load connections.</td></tr>"; return; }
    body.innerHTML = "<tr><td colspan='6' class='muted'>Loading...</td></tr>";
    try {
      var out = await api("/v1/connections");
      var rows = (out && out.data) || [];
      mailboxById = {};
      if (!rows.length) { body.innerHTML = "<tr><td colspan='6' class='muted'>No mailbox connections yet.</td></tr>"; return; }
      body.innerHTML = rows.map(function (c) {
        mailboxById[c.id] = c;
        var when = c.last_validated_at ? new Date(c.last_validated_at).toLocaleString() : "never";
        var errLine = c.last_error ? "<div class='err small'>" + esc(c.last_error) + "</div>" : "";
        var labelLine = c.label ? "<span class='account-label'>" + esc(c.label) + "</span>" : "";
        return "<tr>" +
          "<td>" + esc(c.username) + labelLine + "</td>" +
          "<td>" + esc(c.host) + ":" + esc(c.port) + "</td>" +
          "<td>" + esc(c.tls_mode) + "</td>" +
          "<td>" + badge(c.status) + errLine + "</td>" +
          "<td class='muted small'>" + when + "</td>" +
          "<td class='actions'><div class='action-row'>" +
          "<button class='ghost' data-test='" + esc(c.id) + "'>test</button>" +
          "<label class='pull-toggle'><input type='checkbox' data-pull='" + esc(c.id) + "' /> pull JSON</label>" +
          "<button class='ghost' data-edit='" + esc(c.id) + "'>edit</button>" +
          "<button class='ghost danger' data-del='" + esc(c.id) + "'>delete</button>" +
          "</div></td>" +
          "</tr>" +
          renderResultRow(c.id);
      }).join("");
    } catch (e) {
      body.innerHTML = "<tr><td colspan='6' class='err'>" + esc(e.message) + "</td></tr>";
    }
  }

  $("#saveKey").onclick = function () {
    localStorage.setItem("mtap_key", $("#key").value.trim());
    reflectKey();
    loadSession()
      .then(function () { showTab(isAdmin() ? "clients" : "mailboxes"); })
      .catch(function (e) { $("#keyState").textContent = e.message; });
  };
  $("#refreshClients").onclick = loadClients;
  $("#refreshConns").onclick = loadConns;
  $("#cancelEdit").onclick = function () { resetMailboxForm(); $("#addMsg").textContent = ""; };
  $("#closeClientKey").onclick = function () { $("#clientKeyResult").classList.add("hidden"); $("#clientKeyBody").textContent = ""; };

  $("#createClientForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var f = ev.target, msg = $("#clientMsg");
    msg.textContent = "Creating account...";
    msg.className = "msg";
    try {
      var payload = { name: f.client_name.value.trim(), tier: f.tier.value };
      var out = await api("/v1/admin/clients", { method: "POST", body: JSON.stringify(payload) });
      msg.textContent = "Created " + out.name;
      msg.className = "msg ok";
      f.reset();
      showClientKey("Account: " + out.name + " (" + out.id + ")", out);
      loadClients();
    } catch (e) { msg.textContent = e.message; msg.className = "msg err"; }
  });

  $("#clientBody").addEventListener("click", async function (ev) {
    var btn = ev.target.closest("button"); if (!btn) return;
    var rotateId = btn.getAttribute("data-rotate-client");
    if (!rotateId) return;
    if (!confirm("Rotate this account key? Existing active key(s) will stop working.")) return;
    try {
      btn.textContent = "...";
      btn.disabled = true;
      var out = await api("/v1/admin/clients/" + rotateId + "/api-key/rotate", { method: "POST" });
      showClientKey("Account: " + out.client.name + " (" + out.client.id + ")", out);
      loadClients();
    } catch (e) {
      alert(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "rotate key";
    }
  });

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
      source_account: f.username.value.trim(),
      provider: f.provider.value.trim() || "imap_generic"
    };
    if (!editingMailboxId || f.password.value) payload.password = f.password.value;
    msg.textContent = editingMailboxId ? "Validating update..." : "Validating...";
    msg.className = "msg";
    try {
      var c = editingMailboxId
        ? await api("/v1/connections/" + editingMailboxId, { method: "PATCH", body: JSON.stringify(payload) })
        : await api("/v1/connections", { method: "POST", body: JSON.stringify(payload) });
      msg.textContent = (editingMailboxId ? "Saved" : "Added") + " (" + c.status + ")";
      msg.className = "msg ok";
      resetMailboxForm();
      loadConns();
      loadClients();
    } catch (e) { msg.textContent = e.message; msg.className = "msg err"; }
  });

  $("#connBody").addEventListener("click", async function (ev) {
    var btn = ev.target.closest("button"); if (!btn) return;
    var testId = btn.getAttribute("data-test"), delId = btn.getAttribute("data-del");
    var editId = btn.getAttribute("data-edit"), closeId = btn.getAttribute("data-close-result");
    try {
      if (closeId) { clearMailboxResult(closeId); return; }
      if (editId) { editMailbox(editId); return; }
      if (testId) {
        btn.textContent = "...";
        btn.disabled = true;
        setMailboxResult(testId, "Testing mailbox connection...", { pending: true });
        var testResult = await apiResult("/v1/connections/" + testId + "/test", { method: "POST" });
        var pullBox = document.querySelector("[data-pull='" + testId + "']");
        var includeEmail = !!(pullBox && pullBox.checked);
        var combined = {
          connection_test: {
            request: "POST /v1/connections/" + testId + "/test",
            status: testResult.status,
            http_ok: testResult.http_ok,
            body: testResult.data
          }
        };
        if (includeEmail && testResult.http_ok && testResult.data && testResult.data.ok) {
          var messagePath = "/v1/messages?connection_id=" + encodeURIComponent(testId) + "&limit=1";
          var messageResult = await apiResult(messagePath);
          combined.latest_email_json = {
            request: "GET " + messagePath,
            status: messageResult.status,
            http_ok: messageResult.http_ok,
            body: messageResult.data
          };
        } else if (includeEmail) {
          combined.latest_email_json = { skipped: "Connection test did not return ok:true." };
        }
        setMailboxResult(testId, includeEmail ? "Mailbox test + latest email JSON" : "Mailbox test result", combined);
        loadConns();
        loadClients();
      }
      if (delId) { if (!confirm("Delete this connection?")) return; await api("/v1/connections/" + delId, { method: "DELETE" }); loadConns(); loadClients(); }
    } catch (e) {
      if (testId) setMailboxResult(testId, "Mailbox test failed before the API returned a result", { error: e.message });
      alert(e.message);
    } finally {
      if (testId) { btn.disabled = false; btn.textContent = "test"; }
    }
  });

  loadSession()
    .then(function () { showTab(localStorage.getItem("mtap_tab") || (isAdmin() ? "clients" : "mailboxes")); })
    .catch(function () { showTab("mailboxes"); });
</script>
</body>
</html>
`;
