"use strict";
// Guava transcript browser. Data root comes from <html data-root>: "../" in the dev copy served at /site/,
// "./" in the published bundle. Index at <root>browser-data/index.json; every path inside the JSON
// (episode path, video, image) is relative to the data root, so the site works under any URL subpath.

const DATA_ROOT = document.documentElement.dataset.root || "./";
const MODEL_ORDER = ["guava-4b", "qwen3.5-4b"];
const LONG_REASONING = 360; // chars before reasoning collapses

const $ = (sel, el = document) => el.querySelector(sel);
const state = { index: [], cache: new Map(), cur: null, compare: false, panes: [], active: null };

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const url = (p) => (p == null ? null : /^(\/|[a-z]+:)/i.test(p) ? p : DATA_ROOT + p);
const num = (x) => typeof x === "number" && isFinite(x);
function fmtTime(s) {
  if (!num(s)) return "–";
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}
const fmtSec = (s) => (num(s) ? `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s` : "–");
function tokCount(t) {
  if (num(t)) return t;
  if (t && typeof t === "object") return Object.values(t).reduce((a, v) => a + (num(v) ? v : 0), 0) || null;
  return null;
}
function fmtTok(t) {
  if (t == null) return null;
  if (num(t)) return `${t} tok`;
  if (typeof t === "object") return Object.entries(t).map(([k, v]) => `${k} ${v}`).join(" / ");
  return String(t);
}
const outcome = (e) => (e.success === true ? "success" : e.success === false ? "fail" : "unknown");
function outcomeBadge(e) {
  const o = outcome(e);
  return h("span", { class: `badge ${o === "success" ? "ok" : o === "fail" ? "bad" : "neutral"}` },
    o === "success" ? "✓ success" : o === "fail" ? "✗ fail" : "? unknown");
}
// JSON.stringify(v, null, 2) but short arrays of primitives stay on one line.
function pretty(v) {
  return JSON.stringify(v, (k, x) => (Array.isArray(x) && x.length <= 8 && x.every((y) => y === null || typeof y !== "object")
    ? `\u0000[${x.map((y) => JSON.stringify(y)).join(", ")}]\u0000` : x), 2).replace(/"\\u0000(.*?)\\u0000"/g, (_, s) => JSON.parse(`"${s}"`));
}
const modelRank = (m) => { const i = MODEL_ORDER.indexOf(m); return i < 0 ? 99 : i; };
const cmpStr = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const epKey = (e) => e.path;

async function getJSON(p) {
  const r = await fetch(url(p), { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${p}`);
  return r.json();
}
async function loadEpisode(entry) {
  if (!state.cache.has(entry.path)) state.cache.set(entry.path, getJSON(entry.path));
  return state.cache.get(entry.path);
}

// Same task, other model, same seed (fallback: same episode number).
function pairOf(entry) {
  const others = state.index.filter((e) => e.task === entry.task && e.model !== entry.model);
  if (num(entry.seed)) { const s = others.find((e) => e.seed === entry.seed); if (s) return s; }
  return others.find((e) => e.episode === entry.episode) || null;
}

// ---------- sidebar ----------
function fillSelect(sel, values, label) {
  const keep = sel.value;
  sel.replaceChildren(h("option", { value: "" }, `All ${label}`), ...values.map((v) => h("option", { value: v }, v)));
  sel.value = values.includes(keep) ? keep : "";
}
function filtered() {
  const m = $("#f-model").value, t = $("#f-task").value, o = $("#f-outcome").value;
  return state.index.filter((e) => (!m || e.model === m) && (!t || e.task === t) && (!o || outcome(e) === o));
}
function renderList() {
  const eps = filtered();
  const nOk = eps.filter((e) => e.success === true).length;
  $("#counts").textContent = `${eps.length} of ${state.index.length} episodes · ${nOk} success · ${eps.length - nOk} fail/unknown`;
  const byModel = new Map();
  for (const e of eps) {
    if (!byModel.has(e.model)) byModel.set(e.model, new Map());
    const bt = byModel.get(e.model);
    if (!bt.has(e.task)) bt.set(e.task, []);
    bt.get(e.task).push(e);
  }
  const list = $("#ep-list");
  if (!eps.length) { list.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, "No episodes match.")); return; }
  list.replaceChildren(...[...byModel].sort((a, b) => modelRank(a[0]) - modelRank(b[0]) || cmpStr(a[0], b[0])).map(([model, tasks]) => {
    const all = [...tasks.values()].flat();
    return h("details", { class: "grp model", open: true },
      h("summary", {}, model, h("span", { class: "cnt" }, `${all.filter((e) => e.success === true).length}/${all.length} ✓`)),
      ...[...tasks].sort((a, b) => cmpStr(a[0], b[0])).map(([task, list]) =>
        h("details", { class: "grp task", open: true },
          h("summary", {}, task, h("span", { class: "cnt" }, `${list.filter((e) => e.success === true).length}/${list.length}`)),
          ...list.sort((a, b) => cmpStr(a.episode, b.episode)).map((e) =>
            h("button", { class: "ep" + (state.cur && epKey(state.cur) === epKey(e) ? " cur" : ""), "data-path": e.path,
              onclick: () => { go(e, state.compare); closeSide(); } },
              h("span", {}, `ep ${e.episode ?? "?"}`),
              outcomeBadge(e),
              pairOf(e) ? h("span", { class: "pair", title: "Paired episode from the other model exists" }, "⇄") : h("span"),
              h("span", { class: "meta" }, [
                num(e.n_turns) ? `${e.n_turns} turns` : null,
                num(e.total_latency_s) ? fmtSec(e.total_latency_s) : null,
                num(e.seed) ? `seed ${e.seed}` : null,
                e.end_reason || null,
              ].filter(Boolean).join(" · "))))))
    );
  }));
}
function markCurrentInList() {
  for (const b of document.querySelectorAll(".ep")) b.classList.toggle("cur", !!state.cur && b.dataset.path === state.cur.path);
  const cur = $(".ep.cur");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}
const closeSide = () => document.body.classList.remove("side-open");

// ---------- episode panes ----------
class Pane {
  constructor(ep, entry, single) {
    this.ep = ep;
    this.entry = entry;
    this.turns = Array.isArray(ep.turns) ? ep.turns : [];
    this.cur = -1;
    this.raf = 0;
    this.video = h("video", { controls: true, playsinline: true, preload: "auto" });
    this.nowEl = h("div", { class: "now" });
    this.listEl = h("ol", { class: "turns" }, this.turns.map((t, i) => this.renderTurn(t, i)));
    const player = h("div", { class: "player" }, this.video, this.nowEl, this.renderContext(ep, entry));
    this.blobUrl = null;
    if (ep.video) {
      this.setSource(url(ep.video));
      this.video.addEventListener("error", () => {
        player.prepend(h("div", { class: "vid-err" }, `Video failed to load: ${ep.video}`));
        this.video.hidden = true;
      });
    } else {
      this.video.hidden = true;
      player.prepend(h("div", { class: "vid-err" }, "No video for this episode."));
    }
    this.el = h("section", { class: "pane" + (single ? " single" : ""), onpointerdown: () => setActive(this) },
      h("div", { class: "pane-head" }, h("span", { class: "badge model" }, ep.model), `ep ${ep.episode ?? "?"}`, outcomeBadge(ep)),
      player, this.listEl);
    this.el.pane = this;
    const tick = () => this.sync();
    const loop = () => { this.sync(); this.raf = requestAnimationFrame(loop); };
    this.video.addEventListener("timeupdate", tick);
    this.video.addEventListener("seeked", tick);
    this.video.addEventListener("loadedmetadata", tick);
    this.video.addEventListener("play", () => { setActive(this); cancelAnimationFrame(this.raf); loop(); });
    for (const ev of ["pause", "ended", "emptied"]) this.video.addEventListener(ev, () => { cancelAnimationFrame(this.raf); tick(); });
    this.sync();
  }

  // Seeking needs HTTP Range support; GitHub Pages has it, `python -m http.server` does not.
  // Probe with a 2-byte range request: a 206 means stream from the URL; a 200 means the server
  // ignored the range and sent the whole (small) MP4, which becomes a seekable blob.
  async setSource(src) {
    let use = src;
    try {
      const r = await fetch(src, { headers: { Range: "bytes=0-1" } });
      if (r.status === 200) {
        const blob = await r.blob();
        if (!this.destroyed) use = this.blobUrl = URL.createObjectURL(blob);
      } else {
        await r.arrayBuffer();
      }
    } catch {
      // fall through to the plain URL so the <video> error handler reports the failure
    }
    if (!this.destroyed) this.video.src = use;
  }

  // Episode-level material that is not tied to one turn: prompts, final frame, Markdown transcript.
  renderContext(ep, entry) {
    const block = (label, text) => (text ? h("details", { class: "raw" }, h("summary", {}, label), h("pre", {}, text)) : null);
    const transcript = ep.transcript || entry.transcript;
    const links = [
      transcript ? h("a", { href: url(transcript), target: "_blank" }, "Markdown transcript") : null,
      ep.final_image ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); openLightbox(url(ep.final_image)); } }, "Final frame") : null,
      ep.sim_video ? h("a", { href: url(ep.sim_video), target: "_blank" }, "Raw sim video") : null,
    ].filter(Boolean);
    return h("div", { class: "ctx" },
      links.length ? h("div", { class: "links" }, links) : null,
      block("System prompt", ep.system_prompt),
      block("Initial observation text", ep.initial_observation_text));
  }

  renderTurn(t, i) {
    const start = t.video_start_s, end = t.video_end_s;
    const lat = num(t.latency_s) ? fmtSec(t.latency_s) : "latency –";
    const call = t.tool_call;
    const reasoning = t.reasoning == null ? "" : String(t.reasoning);
    const long = reasoning.length > LONG_REASONING || reasoning.split("\n").length > 6;
    const rTxt = h("div", { class: "txt" + (long ? " clamp" : "") }, reasoning);
    const fb = t.feedback;
    const head = h("div", { class: "turn-head" },
      h("span", { class: "idx" }, `Turn ${t.index ?? i}`),
      h("span", { class: "ts", title: "Click the turn to seek here" }, `${fmtTime(start)} – ${fmtTime(end)}`),
      h("span", {}, lat),
      fmtTok(t.tokens) ? h("span", { title: "Generated tokens" }, fmtTok(t.tokens)) : null,
      num(t.prompt_tokens) ? h("span", { title: "Prompt tokens" }, `${t.prompt_tokens.toLocaleString()} prompt`) : null,
      t.finish_reason && t.finish_reason !== "stop" ? h("span", { class: "badge bad" }, `finish: ${t.finish_reason}`) : null,
      t.not_executed ? h("span", { class: "badge bad", title: typeof t.not_executed === "string" ? t.not_executed : "" }, "not executed") : null,
      t.parser && t.parser.strict_valid === false ? h("span", { class: "badge neutral", title: pretty(t.parser) }, "non-strict parse") : null,
      t.action_ok === true ? h("span", { class: "badge ok" }, "action ok") : t.action_ok === false ? h("span", { class: "badge bad" }, "action failed") : null,
      t.terminal ? h("span", { class: `badge ${t.terminal === "complete" ? "ok" : "bad"}` }, `terminal: ${t.terminal}`) : null);
    const text = h("div", { class: "turn-text" },
      h("div", { class: "sec reasoning" }, h("h4", {}, "Reasoning"),
        reasoning ? rTxt : h("div", { class: "none" }, "(none)"),
        long ? h("button", { class: "more", onclick: (e) => {
          const c = rTxt.classList.toggle("clamp");
          e.currentTarget.textContent = c ? "Show more" : "Show less";
        } }, "Show more") : null),
      h("div", { class: "sec call" }, h("h4", {}, "Tool call"),
        call && call.name != null
          ? [h("span", { class: "fn" }, call.name), h("pre", {}, pretty(call.args ?? {}))]
          : h("div", { class: "none" }, t.terminal ? "(none — terminal turn)" : "(no tool call)")),
      fb != null && fb !== "" ? h("div", { class: "sec feedback" }, h("h4", {}, "Environment feedback"),
        h("div", { class: "txt" }, typeof fb === "string" ? fb : pretty(fb))) : null,
      t.raw_response != null ? h("details", { class: "raw" }, h("summary", {}, "Raw response"),
        h("pre", {}, typeof t.raw_response === "string" ? t.raw_response : pretty(t.raw_response))) : null);
    const img = t.image ? h("img", { class: "thumb", loading: "lazy", src: url(t.image), alt: `Observation for turn ${t.index ?? i}`,
      onclick: (e) => { e.stopPropagation(); openLightbox(url(t.image)); } }) : null;
    return h("li", { class: "turn", "data-i": i,
      onclick: (e) => {
        if (e.target.closest("button, summary, a, pre, img") || String(getSelection())) return;
        this.seekTurn(i);
      } },
      head, h("div", { class: "turn-body" + (img ? "" : " noimg") }, img, text));
  }

  turnAt(time) {
    let best = -1;
    for (let i = 0; i < this.turns.length; i++) {
      const s = this.turns[i].video_start_s;
      if (num(s) && s <= time + 1e-6) best = i;
    }
    return best;
  }

  sync() {
    const t = this.video.currentTime || 0;
    this.setCur(this.turnAt(t));
    const d = this.video.duration;
    this.nowEl.replaceChildren(
      h("span", {}, h("b", {}, fmtTime(t)), ` / ${fmtTime(num(d) ? d : this.turns.at(-1)?.video_end_s)}`),
      h("span", {}, this.cur >= 0
        ? [h("b", {}, `Turn ${this.turns[this.cur].index ?? this.cur}`), ` (${this.cur + 1} of ${this.turns.length})`]
        : `${this.turns.length} turns`));
  }

  setCur(i, scroll = true) {
    if (i === this.cur) return;
    const prev = this.listEl.children[this.cur];
    if (prev) prev.classList.remove("cur");
    this.cur = i;
    const el = this.listEl.children[i];
    if (!el) return;
    el.classList.add("cur");
    if (scroll) this.scrollToTurn(el);
  }

  scrollToTurn(el) {
    const box = this.listEl;
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - 6); // instant: smooth scroll lags or aborts in throttled windows and at high playback rates
    }
  }

  seekTurn(i) {
    const t = this.turns[i];
    if (!t) return;
    setActive(this);
    if (num(t.video_start_s) && !this.video.hidden) this.video.currentTime = t.video_start_s + 1e-3;
    this.setCur(i);
    this.sync();
  }

  step(d) {
    const n = this.turns.length;
    if (!n) return;
    this.seekTurn(Math.min(n - 1, Math.max(0, (this.cur < 0 ? (d > 0 ? -1 : 0) : this.cur) + d)));
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
  }
}

function setActive(p) {
  state.active = p;
  for (const q of state.panes) q.el.classList.toggle("active", q === p && state.panes.length > 1);
}

function statsRow(ep, label) {
  const totTok = (ep.turns || []).reduce((a, t) => a + (tokCount(t.tokens) || 0), 0);
  const nT = num(ep.n_turns) ? ep.n_turns : (ep.turns || []).length;
  return h("div", { class: "stats" },
    label ? h("span", { class: "badge model", title: ep.model_id || "" }, ep.model)
      : h("span", { title: [ep.model_id, ep.model_revision].filter(Boolean).join(" @ ") }, "Model ", h("b", {}, ep.model)),
    outcomeBadge(ep),
    h("span", {}, "Episode ", h("b", {}, ep.episode ?? "?")),
    num(ep.seed) ? h("span", {}, "Seed ", h("b", {}, ep.seed)) : null,
    h("span", {}, h("b", {}, nT), " turns", num(ep.n_actions) ? ` (${ep.n_actions} actions)` : ""),
    h("span", { title: "Sum of per-turn model latency" }, "Latency ", h("b", {}, fmtSec(ep.total_latency_s))),
    num(ep.wall_s) ? h("span", { title: "Episode wall-clock time" }, "Wall ", h("b", {}, fmtSec(ep.wall_s))) : null,
    totTok ? h("span", {}, h("b", {}, totTok.toLocaleString()), " tokens") : null,
    ep.end_reason ? h("span", {}, "End ", h("b", {}, ep.end_reason)) : null);
}

// ---------- routing ----------
function go(entry, compare) {
  const hash = `#ep=${encodeURIComponent(entry.path)}${compare ? "&cmp=1" : ""}`;
  if (location.hash !== hash) location.hash = hash; else route();
}
async function route() {
  const p = new URLSearchParams(location.hash.slice(1));
  let entry = state.index.find((e) => e.path === p.get("ep"));
  if (!entry) {
    entry = filtered()[0] || state.index[0];
    if (!entry) return;
    history.replaceState(null, "", `#ep=${encodeURIComponent(entry.path)}`);
  }
  const pair = pairOf(entry);
  state.compare = p.get("cmp") === "1" && !!pair;
  state.cur = entry;
  markCurrentInList();

  const cmpBtn = $("#cmp-btn");
  cmpBtn.hidden = !pair;
  if (pair) {
    cmpBtn.textContent = state.compare ? "Exit compare" : `Compare with ${pair.model}`;
    cmpBtn.classList.toggle("on", state.compare);
    cmpBtn.title = `${pair.model} ep ${pair.episode}${num(pair.seed) ? ", seed " + pair.seed : ""}`;
    cmpBtn.onclick = () => go(entry, !state.compare);
  }

  const entries = state.compare ? [entry, pair].sort((a, b) => modelRank(a.model) - modelRank(b.model)) : [entry];
  const panesEl = $("#panes");
  let eps;
  try {
    eps = await Promise.all(entries.map(loadEpisode));
  } catch (err) {
    panesEl.replaceChildren(h("p", { class: "empty" }, `Failed to load episode: ${err.message}`));
    return;
  }
  if (state.cur !== entry) return; // a newer navigation won the race
  for (const p of state.panes) p.destroy();
  const ep = eps[0];
  $("#hdr-task").textContent = ep.task ?? entry.task;
  $("#hdr-instr").textContent = ep.instruction ?? "";
  $("#hdr-stats").replaceChildren(...eps.map((e) => statsRow(e, state.compare)));
  document.title = `${ep.task} · ${state.compare ? "compare" : ep.model} ep ${ep.episode} — Guava transcripts`;
  state.panes = eps.map((e, i) => new Pane(e, entries[i], !state.compare));
  panesEl.classList.toggle("compare", state.compare);
  panesEl.replaceChildren(...state.panes.map((p) => p.el));
  setActive(state.panes[0]);
}

// ---------- keyboard / misc ----------
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, select, textarea, [contenteditable]")) return;
  if ($("#lightbox").open) return;
  const p = state.active || state.panes[0];
  if (!p) return;
  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    if (!p.video.hidden) (p.video.paused || p.video.ended) ? p.video.play() : p.video.pause();
  } else if (e.key === "j") { e.preventDefault(); p.step(1); }
  else if (e.key === "k") { e.preventDefault(); p.step(-1); }
}, true);

function openLightbox(src) {
  const d = $("#lightbox");
  $("img", d).src = src;
  d.showModal();
}
$("#lightbox").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("#open-side").onclick = () => document.body.classList.add("side-open");
$("#close-side").onclick = closeSide;
$("#scrim").onclick = closeSide;
$("#hdr-instr").onclick = (e) => e.currentTarget.classList.toggle("full");
for (const id of ["#f-model", "#f-task", "#f-outcome"]) $(id).addEventListener("change", renderList);
window.addEventListener("hashchange", route);

async function init() {
  let idx;
  try {
    idx = await getJSON("browser-data/index.json");
  } catch (err) {
    $("#panes").replaceChildren(h("p", { class: "empty" }, `No episode index yet (${err.message}).`));
    $("#counts").textContent = "0 episodes";
    return;
  }
  state.index = (Array.isArray(idx) ? idx : idx.episodes || []).filter((e) => e && e.path)
    .sort((a, b) => modelRank(a.model) - modelRank(b.model) || cmpStr(a.model, b.model) || cmpStr(a.task, b.task) || cmpStr(a.episode, b.episode));
  const uniq = (k) => [...new Set(state.index.map((e) => e[k]))].filter((v) => v != null);
  fillSelect($("#f-model"), uniq("model").sort((a, b) => modelRank(a) - modelRank(b) || cmpStr(a, b)), "models");
  fillSelect($("#f-task"), uniq("task").sort(cmpStr), "tasks");
  renderList();
  if (!state.index.length) { $("#panes").replaceChildren(h("p", { class: "empty" }, "The episode index is empty.")); return; }
  route();
}
init();
