// Single-page chat for the core: live event list, stream filter, and a form that sends a task.
// No framework, no build, no CDN. The API token lives in localStorage, never in this markup.
// Event content is rendered with textContent only.
export const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shoalwork</title>
<style>
  body { font: 13px/1.4 ui-monospace, Menlo, monospace; margin: 0; background: #111; color: #ddd; }
  header, form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #333; }
  input, select, button { font: inherit; background: #1b1b1b; color: #ddd; border: 1px solid #444; padding: 4px 6px; }
  input[name="prompt"] { flex: 1; min-width: 240px; }
  button { cursor: pointer; }
  #status, #sent { color: #888; }
  #status { margin-left: auto; }
  #events { list-style: none; margin: 0; padding: 0 12px; }
  #events li { border-bottom: 1px solid #222; padding: 6px 0; }
  .type { color: #7fb3ff; font-weight: bold; }
  .meta { color: #888; }
  .payload { white-space: pre-wrap; word-break: break-all; color: #ccc; }
</style>
</head>
<body>
<header>
  <strong>shoalwork</strong>
  <input id="token" type="password" placeholder="API_TOKEN" autocomplete="off">
  <button id="connect" type="button">Conectar</button>
  <input id="filter" placeholder="filtrar por stream (ex: task_)">
  <span id="status">desconectado</span>
</header>
<form id="send">
  <select id="bot" aria-label="bot"></select>
  <input name="prompt" placeholder="prompt da task" required>
  <button type="submit">Enviar task</button>
  <span id="sent"></span>
</form>
<ul id="events"></ul>
<script>
(function () {
  var KEY = "shoalwork.token";
  var MAX_EVENTS = 300;
  var TYPES = [
    "task.received", "task.planned", "task.state_changed", "decision.made", "decision.outcome",
    "bot.created", "bot.state_changed", "executor.started", "executor.event", "executor.finished",
    "usage.recorded", "approval.requested", "approval.resolved", "policy.denied", "message.inbound",
    "message.outbound", "tide.fired", "watchdog.recovered", "budget.exceeded", "error.raised"
  ];
  var events = [];
  var source = null;
  var token = localStorage.getItem(KEY) || "";

  function $(id) { return document.getElementById(id); }
  function setStatus(text) { $("status").textContent = text; }

  function headers() {
    return { "authorization": "Bearer " + token, "content-type": "application/json" };
  }

  function row(event) {
    var li = document.createElement("li");
    var head = document.createElement("div");
    var type = document.createElement("span");
    type.className = "type";
    type.textContent = "#" + event.position + " " + event.type;
    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = "  " + event.streamId + "  " + event.actor + "  " + event.occurredAt;
    head.append(type, meta);
    var body = document.createElement("div");
    body.className = "payload";
    body.textContent = JSON.stringify(event.payload);
    li.append(head, body);
    if (event.type === "approval.requested") { li.append(approvalCard(event.payload)); }
    return li;
  }

  // Aprovar / Negar for a pending request. The action text is the agent's: shown as text only, never run.
  function approvalCard(payload) {
    var card = document.createElement("div");
    var what = document.createElement("span");
    var action = payload.action || {};
    what.textContent = "aprovação (" + payload.risk + "): " + action.tool + " " + (action.resource || "") + "  ";
    var state = document.createElement("span");
    state.className = "meta";
    function decide(decision) {
      fetch("/approvals/" + encodeURIComponent(payload.approvalId), {
        method: "POST", headers: headers(), body: JSON.stringify({ decision: decision, via: "web" })
      }).then(function (res) {
        if (!res.ok) { throw new Error("erro " + res.status); }
        return res.json();
      }).then(function (body) {
        state.textContent = body.result === "resolved" ? decision : "já decidida: " + (body.approval ? body.approval.status : "?");
      }).catch(function (error) { state.textContent = String(error); });
    }
    var yes = document.createElement("button");
    yes.type = "button"; yes.textContent = "Aprovar";
    yes.addEventListener("click", function () { decide("approved"); });
    var no = document.createElement("button");
    no.type = "button"; no.textContent = "Negar";
    no.addEventListener("click", function () { decide("denied"); });
    card.append(what, yes, no, state);
    return card;
  }

  function redraw() {
    var filter = $("filter").value.trim();
    var list = $("events");
    list.textContent = "";
    events.forEach(function (event) {
      if (filter === "" || event.streamId.indexOf(filter) !== -1) {
        list.append(row(event));
      }
    });
  }

  function receive(message) {
    events.unshift(JSON.parse(message.data));
    if (events.length > MAX_EVENTS) { events.length = MAX_EVENTS; }
    redraw();
  }

  function loadBots() {
    return fetch("/bots", { headers: headers() }).then(function (res) {
      if (!res.ok) { throw new Error("bots " + res.status); }
      return res.json();
    }).then(function (body) {
      var select = $("bot");
      select.textContent = "";
      body.bots.forEach(function (bot) {
        var option = document.createElement("option");
        option.value = bot.id;
        option.textContent = bot.name + " (" + bot.state + ")";
        select.append(option);
      });
    }).catch(function (error) { setStatus(String(error)); });
  }

  function connect() {
    token = $("token").value.trim() || token;
    if (token === "") { setStatus("informe o token"); return; }
    localStorage.setItem(KEY, token);
    if (source !== null) { source.close(); }
    events = [];
    redraw();
    // The server sends one named event per type, so each type needs its own listener.
    source = new EventSource("/events/live?token=" + encodeURIComponent(token));
    source.onopen = function () { setStatus("ao vivo"); };
    source.onerror = function () {
      setStatus(source.readyState === EventSource.CLOSED ? "token recusado ou servidor parado" : "reconectando");
    };
    TYPES.forEach(function (type) { source.addEventListener(type, receive); });
    loadBots();
  }

  $("connect").addEventListener("click", connect);
  $("filter").addEventListener("input", redraw);
  $("send").addEventListener("submit", function (event) {
    event.preventDefault();
    var prompt = $("send").elements.namedItem("prompt").value.trim();
    var body = {
      botId: $("bot").value,
      title: prompt.slice(0, 60),
      prompt: prompt,
      kind: "chat",
      acceptance: [],
      budget: { tokens: 200000, seconds: 1800, usd: 2 },
      tier: "light",
      origin: "api"
    };
    fetch("/tasks", { method: "POST", headers: headers(), body: JSON.stringify(body) }).then(function (res) {
      $("sent").textContent = res.ok ? "enviada" : "erro " + res.status;
      if (res.ok) { $("send").elements.namedItem("prompt").value = ""; }
    }).catch(function (error) { $("sent").textContent = String(error); });
  });

  if (token !== "") { connect(); }
})();
</script>
</body>
</html>
`
