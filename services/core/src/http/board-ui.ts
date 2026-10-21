// Kanban board of one project (T-060). No framework, no build, no CDN. The slug comes from the URL; the API
// token lives in localStorage, never in this markup. Task content is rendered with textContent only, and the
// board refreshes itself through the project's SSE stream (project:<slug>).
export const boardHtml = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self';">
<title>board · shoalwork</title>
<style>
  body { font: 13px/1.4 ui-monospace, Menlo, monospace; margin: 0; background: #111; color: #ddd; }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #333; }
  input, select, button { font: inherit; background: #1b1b1b; color: #ddd; border: 1px solid #444; padding: 4px 6px; }
  input[type="password"], input[type="text"] { min-width: 220px; }
  button { cursor: pointer; }
  #status { color: #888; margin-left: auto; }
  #board { display: flex; gap: 10px; padding: 12px; align-items: flex-start; overflow-x: auto; }
  .column { flex: 0 0 210px; background: #161616; border: 1px solid #2a2a2a; border-radius: 4px; }
  .column h2 { font-size: 12px; margin: 0; padding: 8px 10px; border-bottom: 1px solid #2a2a2a; text-transform: uppercase; letter-spacing: .05em; color: #9aa; }
  .column h2 .count { color: #666; font-weight: normal; }
  .cards { min-height: 40px; padding: 6px; display: flex; flex-direction: column; gap: 6px; }
  .card { background: #1d1d1d; border: 1px solid #333; border-radius: 3px; padding: 8px; }
  .card .title { color: #eee; word-break: break-word; }
  .card .meta { color: #888; font-size: 11px; margin-top: 4px; }
  .card .actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .card .actions button { font-size: 11px; padding: 2px 6px; }
  .card button.retry { color: #8fd39b; }
  .card button.pause { color: #e3c57e; }
  .card button.stop { color: #e08b8b; }
  .empty { color: #555; text-align: center; padding: 12px 0; }
</style>
</head>
<body>
<header>
  <strong>board</strong>
  <input id="token" type="password" placeholder="API_TOKEN" autocomplete="off">
  <button id="connect" type="button">Conectar</button>
  <input id="filter" type="text" placeholder="filtrar por título">
  <select id="state" aria-label="estado">
    <option value="">todos os estados</option>
  </select>
  <span id="status">desconectado</span>
</header>
<main id="board"></main>
<script>
(function () {
  var KEY = "shoalwork.token";
  // Same states as the server: the closed list the board renders. The order is the column order.
  var STATES = ["backlog", "ready", "in_progress", "in_review", "testing", "merging", "done", "blocked", "cancelled"];
  // The legal transitions, kept in sync with the server so only valid buttons are shown.
  var TRANSITIONS = {
    backlog: ["ready", "in_review", "blocked", "cancelled"],
    ready: ["backlog", "in_progress", "in_review", "blocked", "cancelled"],
    in_progress: ["in_review", "ready", "blocked", "cancelled"],
    in_review: ["testing", "in_progress", "ready", "done", "blocked", "cancelled"],
    testing: ["merging", "in_progress", "ready", "done", "blocked", "cancelled"],
    merging: ["done", "testing", "in_progress", "ready", "blocked", "cancelled"],
    done: [],
    blocked: ["ready", "cancelled"],
    cancelled: ["backlog"]
  };
  var slug = "";
  var token = localStorage.getItem(KEY) || "";
  var source = null;
  var tasks = [];

  function $(id) { return document.getElementById(id); }
  function setStatus(text) { $("status").textContent = text; }
  function headers() { return { "authorization": "Bearer " + token, "content-type": "application/json" }; }

  function slugOf() {
    var parts = location.pathname.split("/").filter(function (p) { return p !== ""; });
    // /projects/<slug>/board
    return parts.length >= 3 && parts[0] === "projects" ? parts[1] : "";
  }

  function canMove(from, to) { return (TRANSITIONS[from] || []).indexOf(to) !== -1; }

  function fetchJson(path, init) {
    return fetch(path, init).then(function (res) {
      if (!res.ok) { return res.json().catch(function () { return {}; }).then(function (body) { throw new Error(String(body.error || ("erro " + res.status))); }); }
      return res.json();
    });
  }

  function loadTasks() {
    if (token === "") { return Promise.resolve(); }
    return fetchJson("/projects/" + encodeURIComponent(slug) + "/tasks", { headers: headers() }).then(function (body) {
      tasks = body.tasks || [];
      redraw();
    }).catch(function (error) { setStatus(String(error)); });
  }

  function card(task) {
    var el = document.createElement("div");
    el.className = "card";
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = task.title;
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (task.issueNumber !== null ? "#" + task.issueNumber + " " : "") +
      (task.prNumber !== null ? "PR #" + task.prNumber + " " : "") +
      (task.retries > 0 ? "retries " + task.retries + " " : "");
    var actions = document.createElement("div");
    actions.className = "actions";
    function act(label, kind, path, body) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = kind;
      btn.textContent = label;
      btn.addEventListener("click", function () {
        fetchJson(path, { method: "POST", headers: headers(), body: JSON.stringify(body || {}) })
          .then(loadTasks).catch(function (error) { setStatus(String(error)); });
      });
      return btn;
    }
    var base = "/projects/" + encodeURIComponent(slug) + "/tasks/" + encodeURIComponent(task.id);
    if (canMove(task.state, "ready")) {
      actions.append(act("retry", "retry", base + "/retry"));
    }
    if (canMove(task.state, "blocked")) {
      actions.append(act("pause", "pause", base + "/move", { to: "blocked", reason: "paused" }));
    }
    if (canMove(task.state, "cancelled")) {
      actions.append(act("stop", "stop", base + "/move", { to: "cancelled", reason: "stopped" }));
    }
    el.append(title, meta);
    if (actions.children.length > 0) { el.append(actions); }
    return el;
  }

  function column(state, list) {
    var col = document.createElement("section");
    col.className = "column";
    var head = document.createElement("h2");
    var count = document.createElement("span");
    count.className = "count";
    count.textContent = " (" + list.length + ")";
    head.textContent = state;
    head.append(count);
    var cards = document.createElement("div");
    cards.className = "cards";
    if (list.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "—";
      cards.append(empty);
    } else {
      list.forEach(function (task) { cards.append(card(task)); });
    }
    col.append(head, cards);
    return col;
  }

  function redraw() {
    var filter = $("filter").value.trim().toLowerCase();
    var stateFilter = $("state").value;
    var board = $("board");
    board.textContent = "";
    STATES.forEach(function (state) {
      if (stateFilter !== "" && stateFilter !== state) { return; }
      var list = tasks.filter(function (task) {
        if (task.state !== state) { return false; }
        if (filter === "") { return true; }
        return task.title.toLowerCase().indexOf(filter) !== -1 || task.id.toLowerCase().indexOf(filter) !== -1;
      });
      board.append(column(state, list));
    });
  }

  function connect() {
    token = $("token").value.trim() || token;
    if (token === "") { setStatus("informe o token"); return; }
    localStorage.setItem(KEY, token);
    if (source !== null) { source.close(); }
    source = new EventSource("/projects/" + encodeURIComponent(slug) + "/live?token=" + encodeURIComponent(token));
    source.addEventListener("project_task.state_changed", function () { loadTasks(); });
    source.onopen = function () { setStatus("ao vivo"); };
    source.onerror = function () {
      setStatus(source.readyState === EventSource.CLOSED ? "token recusado ou servidor parado" : "reconectando");
    };
    loadTasks();
  }

  function seedStateFilter() {
    var select = $("state");
    STATES.forEach(function (state) {
      var option = document.createElement("option");
      option.value = state;
      option.textContent = state;
      select.append(option);
    });
  }

  slug = slugOf();
  if (slug === "") { setStatus("slug inválido na URL"); }
  $("connect").addEventListener("click", connect);
  $("filter").addEventListener("input", redraw);
  $("state").addEventListener("change", redraw);
  seedStateFilter();
  if (token !== "") { connect(); }
})();
</script>
</body>
</html>
`
