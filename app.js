"use strict";
// Усе працює в браузері: запити до EasyWay йдуть з телефона користувача, серверу нічого не передається.
const API = "https://gps.easyway.info/api/city/lutsk";
const MIN = 60000;
const DEFAULTS = { origin: "", dest: "", walkTo: 5, walkFrom: 3, safety: 5, buffer: 1, perStop: 1.5, when: "" };
const KIND = { trol: "тролейбус", bus: "автобус" };
const $ = (id) => document.getElementById(id);

// --- сховище (може бути недоступне) ---
function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("kv-settings") || "{}") }; } catch { return { ...DEFAULTS }; }
}
function save(s) { try { localStorage.setItem("kv-settings", JSON.stringify(s)); } catch { /* без збереження */ } }
let cfg = load();

// --- EasyWay ---
async function getJSON(path) {
  const r = await fetch(API + path, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  if (j.status !== "ok") throw new Error("EasyWay: " + JSON.stringify(j).slice(0, 120));
  return j.data;
}
const stopInfo = (id) => getJSON(`/lang/ua/stop/${id}`);
const routeInfo = (id) => getJSON(`/route/${id}`);

function kindOf(r) {
  if (r.transport_key === "trol") return "trol";
  return /маршрут/i.test(r.transport_name || "") ? "marshrutka" : "bus";
}
const kindName = (k) => (k === "marshrutka" ? "маршрутка" : KIND[k] || k);

// мінімальна к-ть перегонів від a до b у порядку руху
function hopsBetween(seq, a, b) {
  let best = null;
  seq.forEach((s, i) => {
    if (s !== a) return;
    for (let j = i + 1; j < seq.length; j++) {
      if (seq[j] === b) { best = best === null ? j - i : Math.min(best, j - i); break; }
    }
  });
  return best;
}

// рейси (route_id:trip_id), що їдуть з origin в dest, -> перегони; кеш на добу
async function matchingTrips(origin, dest, a, b) {
  const key = `kv-trips-${origin}-${dest}`;
  try {
    const c = JSON.parse(localStorage.getItem(key) || "null");
    if (c && Date.now() - c.at < 24 * 60 * MIN) return c.trips;
  } catch { /* кеш недоступний */ }
  const inB = new Set(b.routes.map((r) => r.route_id));
  const ids = [...new Set(a.routes.map((r) => r.route_id))].filter((id) => inB.has(id));
  const trips = {};
  await Promise.all(ids.map(async (rid) => {
    const info = await routeInfo(rid);
    for (const d of info.directions) {
      const seq = d.stops.map((s) => String(s.stop_id));
      const h = hopsBetween(seq, origin, dest);
      if (h !== null) trips[`${rid}:${d.trip_id}`] = h;
    }
  }));
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), trips })); } catch { /* ок */ }
  return trips;
}

async function plan(deadline, now) {
  const a = await stopInfo(cfg.origin);
  const b = await stopInfo(cfg.dest);
  const trips = await matchingTrips(cfg.origin, cfg.dest, a, b);
  const opts = [];
  for (const r of a.routes) {
    const hops = trips[`${r.route_id}:${r.trip_id}`];
    if (hops === undefined || !r.works_now || r.disabled) continue;
    for (const t of r.times || []) {
      const at = t.arrival_time * 1000;
      if (at > deadline) continue;
      const arrive = at + hops * cfg.perStop * MIN;
      const spare = Math.floor((deadline - (arrive + cfg.walkFrom * MIN)) / MIN);
      const leave = at - (cfg.walkTo + cfg.buffer) * MIN;
      if (spare < cfg.safety || leave < now) continue;
      opts.push({ route: r.route_name, kind: kindOf(r), leave, board: at, arrive, spare, gps: t.source === "gps" });
    }
  }
  return opts.sort((x, y) => y.board - x.board).slice(0, 3);
}

// --- відображення ---
const hhmm = (ms) => new Date(ms).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
let tick = null;

function countdownText(leave) {
  const m = Math.round((leave - Date.now()) / MIN);
  if (m <= 0) return "<b>виходь зараз</b>";
  return m >= 60 ? `через <b>${Math.floor(m / 60)} год ${m % 60} хв</b>` : `через <b>${m} хв</b>`;
}
function optHTML(o) {
  return `<span class="badge ${o.gps ? "gps" : "schedule"}">${o.gps ? "GPS" : "розклад"}</span>`;
}
function render(opts, deadline) {
  const el = $("result");
  el.hidden = false;
  clearInterval(tick);
  if (!opts.length) {
    el.innerHTML = `<p class="empty">На пару о ${hhmm(deadline)} із запасом нічого не встигаєш. Спробуй пізнішу пару або зменш мінімальний запас у налаштуваннях.</p>`;
    return;
  }
  const best = opts[0];
  const rest = opts.slice(1).map((o) => `<li class="opt"><span>вийти о <b>${hhmm(o.leave)}</b> · ${kindName(o.kind)} ${o.route}</span>${optHTML(o)}</li>`).join("");
  el.innerHTML = `
    <div class="count">Пара о ${hhmm(deadline)}. Виходь о</div>
    <div class="big">${hhmm(best.leave)}</div>
    <div class="count" id="cd">${countdownText(best.leave)}</div>
    <div class="meta"><span>${kindName(best.kind)} <b>${best.route}</b></span>${optHTML(best)}<span class="count">приїдеш о ${hhmm(best.arrive)}, запас ${best.spare} хв</span></div>
    ${rest ? `<ul style="margin-top:14px">${rest}</ul>` : ""}`;
  tick = setInterval(() => { const cd = $("cd"); if (cd) cd.innerHTML = countdownText(best.leave); }, 15000);
}

function setStatus(t) { $("status").textContent = t; }

async function go() {
  const [h, m] = ($("when").value || "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) { setStatus("Вкажи час початку пари"); return; }
  const now = Date.now();
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) { setStatus("Цей час уже минув. Запити даних працюють лише на сьогодні."); return; }
  cfg.when = $("when").value; save(cfg);
  $("go").disabled = true; setStatus("Завантажую дані…");
  try {
    render(await plan(d.getTime(), now), d.getTime());
    setStatus("Оновлено о " + hhmm(Date.now()));
  } catch (e) {
    $("result").hidden = false;
    $("result").innerHTML = `<p class="error">Немає даних про транспорт (${e.message}). Перевір інтернет і спробуй ще раз.</p>`;
    setStatus("");
  } finally { $("go").disabled = false; }
}

// --- налаштування ---
async function checkName(inputId, nameId) {
  const v = $(inputId).value.trim(), out = $(nameId);
  out.className = "name"; out.textContent = "";
  if (!v) return null;
  if (!/^\d+$/.test(v)) { out.className = "name err"; out.textContent = "Id має бути числом"; return null; }
  try { const s = await stopInfo(v); out.textContent = "✓ " + s.name; return v; }
  catch { out.className = "name err"; out.textContent = "Такої зупинки не знайдено"; return null; }
}
function showSettings(on) {
  $("settings").hidden = !on;
  $("settingsBtn").setAttribute("aria-expanded", String(on));
}
function fillSettings() {
  $("origin").value = cfg.origin; $("dest").value = cfg.dest;
  $("walkTo").value = cfg.walkTo; $("walkFrom").value = cfg.walkFrom; $("safety").value = cfg.safety;
}
const num = (id, fallback) => { const v = parseFloat($(id).value.replace(",", ".")); return Number.isFinite(v) && v >= 0 ? v : fallback; };

async function saveSettings() {
  const [o, d] = await Promise.all([checkName("origin", "originName"), checkName("dest", "destName")]);
  if (!o || !d) return;
  cfg = { ...cfg, origin: o, dest: d, walkTo: num("walkTo", 5), walkFrom: num("walkFrom", 3), safety: num("safety", 5) };
  save(cfg); showSettings(false); refreshMain();
}
function refreshMain() {
  const ready = cfg.origin && cfg.dest;
  $("main").hidden = !ready;
  if (cfg.when) $("when").value = cfg.when;
  if (!ready) showSettings(true);
}

$("settingsBtn").addEventListener("click", () => { fillSettings(); showSettings($("settings").hidden); });
$("save").addEventListener("click", saveSettings);
$("go").addEventListener("click", go);
$("origin").addEventListener("change", () => checkName("origin", "originName"));
$("dest").addEventListener("change", () => checkName("dest", "destName"));
// автооновлення, поки сторінка відкрита
setInterval(() => { if (!document.hidden && !$("result").hidden && $("when").value) go(); }, 60000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
fillSettings(); refreshMain();
