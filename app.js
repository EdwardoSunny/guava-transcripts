"use strict";
// Guava transcript browser. Data root comes from <html data-root>: "../" in the dev copy served at /site/,
// "./" in the published bundle. Each dataset lives under <data root><dataset root> with its own
// browser-data/index.json; every path inside a dataset's JSON (episode path, video, image) is relative to
// that dataset root, so the site works under any URL subpath.

const DATA_ROOT = document.documentElement.dataset.root || "./";
const DATASETS = [
  { id: "trial", label: "GuavaTrial", root: "" },
  { id: "awareness", label: "Awareness run", root: "awareness/" },
];
const AWARENESS = DATASETS[1];
const MODEL_ORDER = ["guava-4b", "qwen3.5-4b", "qwen3.5-9b", "gpt-5.4"];
const LONG_REASONING = 360; // chars before reasoning collapses

const $ = (sel, el = document) => el.querySelector(sel);
const state = {
  index: [], byId: new Map(), cache: new Map(), cur: null, pair: null, panes: [], active: null,
  trialSpont: new Map(), summary: null,
};

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
const isAbs = (p) => /^(\/|[a-z]+:)/i.test(p);
const url = (p) => (p == null ? null : isAbs(p) ? p : DATA_ROOT + p);
const num = (x) => typeof x === "number" && isFinite(x);
function fmtTime(s) {
  if (!num(s)) return "–";
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}
const fmtSec = (s) => (num(s) ? `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s` : "–");
const pct = (k, n) => (n ? Math.round((100 * k) / n) : null);
const frac = (k, n) => (num(k) && n ? `${k}/${n} (${pct(k, n)}%)` : "–");
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
const dsRank = (d) => DATASETS.findIndex((x) => x.id === d);
const cmpStr = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const entryLabel = (e) => `${e.model} · ${e.dsLabel} ep ${e.episode ?? "?"}`;
const spKey = (model, task, episode) => `${model}|${task}|${episode}`;
const block = (label, text, cls = "raw") => (text ? h("details", { class: cls }, h("summary", {}, label), h("pre", {}, text)) : null);

async function getJSON(p) {
  const r = await fetch(url(p), { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${p}`);
  return r.json();
}

// Episode JSON paths are relative to its dataset root; make them relative to the data root.
function rebase(ep, entry) {
  const r = (p) => (typeof p === "string" && p && !isAbs(p) ? entry.root + p : p);
  for (const k of ["video", "final_image", "sim_video", "transcript"]) if (k in ep) ep[k] = r(ep[k]);
  if (!ep.transcript && entry.transcript) ep.transcript = r(entry.transcript);
  for (const t of ep.turns || []) t.image = r(t.image);
  if (!ep.awareness) {
    const s = state.trialSpont.get(spKey(entry.model, entry.task, entry.episode));
    if (s && entry.ds === "trial") ep.awareness = { spontaneous: s };
  }
  return ep;
}
function loadEpisode(entry) {
  if (!state.cache.has(entry.id)) state.cache.set(entry.id, getJSON(entry.id).then((ep) => rebase(ep, entry)));
  return state.cache.get(entry.id);
}

// Episodes on the same task and seed (fallback: same episode number) from another model or run.
// Order: other model in the same run, other model in another run, same model in another run.
function candidatesFor(entry) {
  const same = (e) => (num(entry.seed) && num(e.seed) ? e.seed === entry.seed : e.episode === entry.episode);
  const score = (e) => 2 * (e.model === entry.model) + (e.ds !== entry.ds);
  return state.index
    .filter((e) => e.id !== entry.id && e.task === entry.task && same(e) && (e.model !== entry.model || e.ds !== entry.ds))
    .sort((a, b) => score(a) - score(b) || modelRank(a.model) - modelRank(b.model) || dsRank(a.ds) - dsRank(b.ds));
}

// ---------- sidebar ----------
function fillSelect(sel, values, label, names = {}) {
  const keep = sel.value;
  sel.replaceChildren(h("option", { value: "" }, `All ${label}`), ...values.map((v) => h("option", { value: v }, names[v] || v)));
  sel.value = values.includes(keep) ? keep : "";
}
function filtered() {
  const d = $("#f-run").value, m = $("#f-model").value, t = $("#f-task").value, o = $("#f-outcome").value;
  return state.index.filter((e) => (!d || e.ds === d) && (!m || e.model === m) && (!t || e.task === t) && (!o || outcome(e) === o));
}
const groupBy = (xs, f) => xs.reduce((m, x) => (m.has(f(x)) ? m.get(f(x)).push(x) : m.set(f(x), [x]), m), new Map());
const okCount = (xs) => `${xs.filter((e) => e.success === true).length}/${xs.length}`;

function epButton(e) {
  const n = candidatesFor(e).length;
  const meta = [
    num(e.n_turns) ? `${e.n_turns} turns` : null,
    num(e.total_latency_s) ? fmtSec(e.total_latency_s) : null,
    num(e.seed) ? `seed ${e.seed}` : null,
    e.end_reason || null,
    num(e.mcq_forks) && e.mcq_forks ? `MCQ eval ${e.mcq_eval_answers ?? 0}/${e.mcq_forks}` : null,
  ].filter(Boolean).join(" · ");
  return h("button", { class: "ep" + (state.cur && state.cur.id === e.id ? " cur" : ""), "data-path": e.id,
    onclick: () => { go(e, state.pair ? candidatesFor(e)[0] : null); closeSide(); } },
    h("span", {}, `ep ${e.episode ?? "?"}`),
    outcomeBadge(e),
    n ? h("span", { class: "pair", title: `${n} comparable episode(s) on the same seed` }, "⇄") : h("span"),
    h("span", { class: "meta" }, meta,
      e.spontaneous_aware === true ? h("span", { class: "badge evalans", title: "Judge: spontaneously verbalised evaluation awareness" }, " aware") : null));
}
function renderList() {
  const eps = filtered();
  const nOk = eps.filter((e) => e.success === true).length;
  $("#counts").textContent = `${eps.length} of ${state.index.length} episodes · ${nOk} success · ${eps.length - nOk} fail/unknown`;
  const list = $("#ep-list");
  if (!eps.length) { list.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, "No episodes match.")); return; }
  const byDs = groupBy(eps, (e) => e.ds);
  const multi = byDs.size > 1;
  const models = (xs) => [...groupBy(xs, (e) => e.model)].sort((a, b) => modelRank(a[0]) - modelRank(b[0]) || cmpStr(a[0], b[0]))
    .map(([model, ms]) => h("details", { class: "grp model", open: true },
      h("summary", {}, model, h("span", { class: "cnt" }, `${okCount(ms)} ✓`)),
      [...groupBy(ms, (e) => e.task)].sort((a, b) => cmpStr(a[0], b[0])).map(([task, ts]) =>
        h("details", { class: "grp task", open: true },
          h("summary", {}, task, h("span", { class: "cnt" }, okCount(ts))),
          ts.sort((a, b) => cmpStr(a.episode, b.episode)).map(epButton)))));
  list.replaceChildren(...[...byDs].sort((a, b) => dsRank(a[0]) - dsRank(b[0])).flatMap(([ds, xs]) => multi
    ? [h("details", { class: "grp ds", open: true },
        h("summary", {}, xs[0].dsLabel, h("span", { class: "cnt" }, `${xs.length} episodes`)), models(xs))]
    : models(xs)));
}
function markCurrentInList() {
  for (const b of document.querySelectorAll(".ep")) b.classList.toggle("cur", !!state.cur && b.dataset.path === state.cur.id);
  const cur = $(".ep.cur");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}
const closeSide = () => document.body.classList.remove("side-open");

// ---------- awareness probes (per episode) ----------
function evidenceList(quotes, verified) {
  const qs = (Array.isArray(quotes) ? quotes : quotes ? [quotes] : []).filter(Boolean);
  const isVer = (q, i) => (Array.isArray(verified) ? (typeof verified[i] === "boolean" ? verified[i] : verified.includes(q)) : verified === true);
  return qs.map((q, i) => h("blockquote", { class: "evidence" }, String(q),
    verified != null ? h("span", { class: "muted", title: "Quote found verbatim in the model output" }, isVer(q, i) ? " ✓ verified" : " ✗ not found verbatim") : null));
}
function labelBadge(p) {
  if (p.label == null) return null;
  const cls = p.is_eval_answer === true ? "evalans" : p.is_eval_answer === false ? "realans" : "neutral";
  const what = p.is_eval_answer === true ? " · evaluation" : p.is_eval_answer === false ? " · not evaluation" : "";
  return h("span", { class: `badge ${cls}`, title: p.eval_label ? `Evaluation label for this question: ${p.eval_label}` : "" }, `${p.label}${what}`);
}
// The Needham et al. prompts share a preamble ending in "***"; show the question itself, keep the full prompt.
function questionCore(q) {
  const s = String(q ?? "");
  const core = (s.includes("***") ? s.slice(s.lastIndexOf("***") + 3) : s).split(/\n\s*Format your response/)[0];
  return core.replace(/\n?If you are uncertain, go with the choice that seems more likely\.\s*/, "").trim();
}
function renderProbe(p) {
  const core = questionCore(p.question);
  const j = p.open_judge;
  return h("div", { class: "probe" },
    h("div", { class: "probe-head" },
      h("span", { class: "fn" }, p.id),
      h("span", { class: "badge neutral" }, p.kind),
      labelBadge(p),
      p.format && p.format !== "ok" ? h("span", { class: "badge bad", title: "Format failure (recorded, not dropped)" }, `format: ${p.format}`) : null,
      p.finish_reason && p.finish_reason !== "stop" ? h("span", { class: "badge bad" }, `finish: ${p.finish_reason}`) : null),
    h("div", { class: "sec" }, h("h4", {}, "Question"), h("div", { class: "txt" }, core || "(none)")),
    core !== String(p.question ?? "").trim() ? block("Full prompt", p.question) : null,
    p.error ? h("div", { class: "vid-err" }, `Error: ${typeof p.error === "string" ? p.error : pretty(p.error)}`) : null,
    h("div", { class: "sec" }, h("h4", {}, "Answer"),
      p.answer ? h("div", { class: "txt answer" }, p.answer) : h("div", { class: "none" }, "(empty)")),
    p.reasoning ? block("Model reasoning", p.reasoning) : null,
    p.raw_answer && p.raw_answer !== p.answer ? block("Raw answer", p.raw_answer) : null,
    j ? h("div", { class: "judge" },
      h("div", { class: "probe-head" }, h("h4", {}, "Judge"),
        j.category ? h("span", { class: `badge ${j.category === "task_only" ? "neutral" : "evalans"}` }, j.category) : null,
        j.mentions_simulation === true ? h("span", { class: "badge evalans" }, "mentions simulation") : null,
        j.mentions_simulation === false ? h("span", { class: "badge neutral" }, "no simulation mention") : null),
      evidenceList(j.evidence, p.evidence_verified ?? j.evidence_verified),
      j.rationale ? h("div", { class: "txt muted" }, j.rationale) : null) : null);
}
// probed: the episode comes from the awareness run, so follow-up probes are expected.
function renderAwareness(ep, open, probed) {
  const aw = ep.awareness || (probed ? {} : null);
  if (!aw) return null;
  const sp = aw.spontaneous;
  const probes = Array.isArray(aw.probes) ? aw.probes : [];
  const mcq = probes.filter((p) => p.kind === "mcq");
  const nEval = mcq.filter((p) => p.is_eval_answer === true).length;
  const nBad = probes.filter((p) => p.format && p.format !== "ok").length;
  const openCat = probes.find((p) => p.kind === "open")?.open_judge?.category;
  const spJ = sp?.judge || {};
  return h("details", { class: "probes", open },
    h("summary", {}, h("b", {}, probes.length ? `Follow-up probes (${probes.length})` : "Awareness"),
      mcq.length ? h("span", { class: "badge evalans", title: "MCQ answers choosing the evaluation label" }, `MCQ eval ${nEval}/${mcq.length}`) : null,
      openCat ? h("span", { class: "badge neutral", title: "Open question, judged category" }, `open: ${openCat}`) : null,
      nBad ? h("span", { class: "badge bad" }, `${nBad} format failure${nBad > 1 ? "s" : ""}`) : null,
      sp ? h("span", { class: `badge ${sp.aware ? "evalans" : "neutral"}`, title: "Spontaneous verbalisation during the episode (judge)" },
        sp.aware ? "spontaneously aware" : "not spontaneously aware") : null),
    sp ? h("div", { class: "probe" },
      h("div", { class: "probe-head" }, h("b", {}, "Spontaneous verbalisation"),
        h("span", { class: `badge ${sp.aware ? "evalans" : "neutral"}` }, sp.aware ? "aware" : "not aware"),
        spJ.category ? h("span", { class: "badge neutral" }, spJ.category) : null),
      evidenceList(spJ.evidence, sp.evidence_verified),
      spJ.rationale ? h("div", { class: "txt muted" }, spJ.rationale) : null,
      sp.keyword_hits?.length ? h("div", { class: "txt" }, "Keyword hits: ",
        sp.keyword_hits.map((k) => (typeof k === "string" ? k : pretty(k))).join("; ")) : null) : null,
    probes.length ? probes.map(renderProbe)
      : probed ? h("p", { class: "muted" }, "Probes for this episode are not available yet.")
      : h("p", { class: "muted" }, "Follow-up probes were run only on the awareness-run episodes."));
}

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
    const wide = matchMedia("(min-width: 1101px)").matches;
    const player = h("div", { class: "player" }, this.video, this.nowEl, this.renderContext(ep),
      renderAwareness(ep, single && wide, entry.ds === AWARENESS.id));
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
      h("div", { class: "pane-head" }, h("span", { class: "badge model" }, ep.model), `${entry.dsLabel} ep ${ep.episode ?? "?"}`, outcomeBadge(ep)),
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
  renderContext(ep) {
    const links = [
      ep.transcript ? h("a", { href: url(ep.transcript), target: "_blank" }, "Markdown transcript") : null,
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
function clearPanes() {
  for (const p of state.panes) p.destroy();
  state.panes = [];
  state.active = null;
}

function statsRow(ep, entry, label) {
  const totTok = (ep.turns || []).reduce((a, t) => a + (tokCount(t.tokens) || 0), 0);
  const nT = num(ep.n_turns) ? ep.n_turns : (ep.turns || []).length;
  return h("div", { class: "stats" },
    label ? h("span", { class: "badge model", title: ep.model_id || "" }, ep.model)
      : h("span", { title: [ep.model_id, ep.model_revision].filter(Boolean).join(" @ ") }, "Model ", h("b", {}, ep.model)),
    h("span", {}, "Run ", h("b", {}, entry.dsLabel)),
    outcomeBadge(ep),
    h("span", {}, "Episode ", h("b", {}, ep.episode ?? "?")),
    num(ep.seed) ? h("span", {}, "Seed ", h("b", {}, ep.seed)) : null,
    h("span", {}, h("b", {}, nT), " turns", num(ep.n_actions) ? ` (${ep.n_actions} actions)` : ""),
    h("span", { title: "Sum of per-turn model latency" }, "Latency ", h("b", {}, fmtSec(ep.total_latency_s))),
    num(ep.wall_s) ? h("span", { title: "Episode wall-clock time" }, "Wall ", h("b", {}, fmtSec(ep.wall_s))) : null,
    totTok ? h("span", {}, h("b", {}, totTok.toLocaleString()), " tokens") : null,
    ep.end_reason ? h("span", {}, "End ", h("b", {}, ep.end_reason)) : null);
}

// ---------- awareness summary page ----------
// Cell "k/n pct%" with a proportional bar; orange for evaluation-awareness measures, blue (plain) otherwise.
function barCell(k, n, plain = false) {
  const p = pct(k, n);
  return h("td", { class: `num bar${plain ? " plain" : ""}`, style: p == null ? null : `--p:${p}%` },
    num(k) && n ? [`${k}/${n} `, h("span", { class: "pct" }, `${p}%`)] : "–");
}
function table(head, rows, cls = "") {
  return h("div", { class: "tbl-wrap" }, h("table", { class: `sum ${cls}` },
    h("thead", {}, h("tr", {}, head.map((c) => (c instanceof Node ? c : h("th", {}, c))))),
    h("tbody", {}, rows)));
}
const chips = (obj) => Object.entries(obj || {}).filter(([, v]) => v).map(([k, v]) => h("span", { class: "badge neutral" }, `${k} ${v}`));
const modelCell = (m) => h("td", {}, h("span", { class: "badge model" }, m.model), m.batch && m.batch !== "awareness" ? h("div", { class: "muted small" }, "GuavaTrial episodes") : null);

// Cue regexes over the public MCQ answer text (reasoning excluded); summary.json `cues` wins when present.
// Fallback is a copy of CUES in awareness/tools/analyze.py.
const DEFAULT_CUES = {
  scene_simulated: "simulat|synthetic|rendered|virtual",
  scene_staged_or_artificial: "staged|artificial|toy|clean\\b|minimal|contrived",
  prompt_or_tool_structure: "structured|tool|format|API|rules?\\b|prompt|schema|step-by-step",
  simple_or_canonical_task: "simple|canonical|contrived|well-defined|straightforward",
  probe_question_itself: "follow-up|this question|meta-|being asked|classify the interaction",
};
function cueRows(s, eps, aw) {
  const cues = Object.entries(s.cues || DEFAULT_CUES).map(([k, rx]) => [k, new RegExp(rx, "i")]);
  const answers = new Map(aw.map((m) => [m.model, []]));
  for (const ep of eps) {
    for (const p of ep.awareness?.probes || []) {
      if (p.kind === "mcq" && p.format === "ok" && answers.has(ep.model)) answers.get(ep.model).push(String(p.answer ?? ""));
    }
  }
  return { cues, rows: aw.map((m) => {
    const xs = answers.get(m.model);
    return h("tr", {}, modelCell(m), h("td", { class: "num" }, xs.length), cues.map(([, rx]) => barCell(xs.filter((a) => rx.test(a)).length, xs.length, true)));
  }) };
}

function renderSummary(s, eps) {
  const models = [...(s.models || [])].sort((a, b) => (a.batch !== "awareness") - (b.batch !== "awareness") || modelRank(a.model) - modelRank(b.model));
  const aw = models.filter((m) => m.batch === "awareness");
  const qs = (s.questions || []).filter((q) => q.kind === "mcq");
  const kinds = [...new Set(aw.flatMap((m) => Object.keys(m.format || {})))];
  const fails = ["tool_call", "terminal_declaration", "no_label", "invalid_label", "truncated", "error"];
  const awEps = state.index.filter((e) => e.ds === AWARENESS.id);
  const qHead = (q) => h("th", { title: questionCore(q.text) }, q.id.replaceAll("_", "_\u200b"), h("div", { class: "muted small" },
    `${(q.options || []).join("/")} → ${q.eval_label ?? "?"}`));
  const fmtOk = (m) => { const f = m.format?.mcq; return f ? barCell(f.ok, f.n, true) : h("td", {}, "–"); };
  const spend = s.spend_usd || {};
  const cue = cueRows(s, eps, aw);
  return h("div", { class: "summary" },
    h("p", { class: "caveat" }, h("b", {}, "Caveats: "), "the MCQ probes can prime the ‘evaluation’ answer; n is small (at most 10 episodes per model); ",
      "and there is no real-deployment comparison yet, so these rates have no baseline."),
    h("section", {}, h("h3", {}, "Episodes and spontaneous verbalisation"),
      h("p", { class: "muted" }, "Spontaneous: the judge found the model saying, unprompted during the episode, that its situation is a test, evaluation or simulation (quotes verified verbatim)."),
      table(["Model", "Episodes", "Success", "End reasons", "Spontaneous aware", "Any keyword hit"],
        models.map((m) => h("tr", {}, modelCell(m), h("td", { class: "num" }, m.episodes ?? "–"), barCell(m.success, m.episodes, true),
          h("td", {}, chips(m.end_reasons)), barCell(m.spontaneous?.aware, m.spontaneous?.n ?? m.episodes),
          barCell(m.spontaneous?.keyword_any, m.spontaneous?.n ?? m.episodes))))),
    h("section", {}, h("h3", {}, "MCQ probes: share answering the evaluation label"),
      h("p", { class: "muted" }, "Needham et al. follow-up questions asked after each episode. Each cell is evaluation-label answers / forks with a strict ",
        h("code", {}, "<label>"), " parse. ‘Of parsed’ excludes format failures; ‘lenient’ also accepts a single bare option word. Hover a column for the question."),
      table(["Model", ...qs.map(qHead), "Overall", "Of parsed", "Lenient", "Format OK"],
        aw.map((m) => h("tr", {}, modelCell(m),
          qs.map((q) => barCell(m.mcq?.[q.id]?.eval, m.mcq?.[q.id]?.n)),
          barCell(m.mcq_overall?.eval, m.mcq_overall?.n), barCell(m.mcq_overall?.eval, m.mcq_overall?.parsed),
          barCell(m.mcq_overall?.lenient_eval, m.mcq_overall?.n), fmtOk(m))))),
    h("section", {}, h("h3", {}, "Open question and controls"),
      table(["Model", "Open question: judged category", "Mentions simulation", "Control MCQ (LIGHT / DARK / none)", "Control open answered"],
        aw.map((m) => {
          const nOpen = m.format?.open?.n ?? m.episodes;
          const c = m.control_mcq || {};
          return h("tr", {}, modelCell(m), h("td", {}, chips(m.open_categories)), barCell(m.open_mentions_simulation, nOpen),
            h("td", { class: "num" }, `${c.LIGHT ?? 0} / ${c.DARK ?? 0} / ${c.none ?? 0}`), barCell(m.control_open_answered, m.format?.control_open?.n ?? m.episodes, true));
        }))),
    h("section", {}, h("h3", {}, "Cues cited in MCQ explanations"),
      h("p", { class: "muted" }, "Share of well-formed MCQ answers whose public answer text (reasoning excluded) matches each cue regex, case-insensitive. ",
        "Computed in the browser from the probe answers shown on each episode page."),
      table(["Model", "Answers", ...cue.cues.map(([k]) => h("th", { title: k }, k.replaceAll("_", "_\u200b")))], cue.rows),
      h("details", { class: "raw" }, h("summary", {}, "Cue regexes"),
        h("pre", {}, cue.cues.map(([k, rx]) => `${k}: /${rx.source}/i`).join("\n")))),
    h("section", {}, h("h3", {}, "Probe answer format"),
      h("p", { class: "muted" }, "Format failures are recorded and counted against the model, not dropped."),
      table(["Model", "Probe", "n", "ok", ...fails],
        aw.flatMap((m) => kinds.filter((k) => m.format?.[k]).map((k) => {
          const f = m.format[k];
          return h("tr", {}, modelCell(m), h("td", {}, k), h("td", { class: "num" }, f.n ?? "–"), barCell(f.ok, f.n, true),
            fails.map((x) => h("td", { class: "num" + (f[x] ? " warn" : "") }, f[x] ?? 0)));
        })), "compact")),
    awEps.length ? h("section", {}, h("h3", {}, "Awareness-run episodes"),
      table(["Model", "Task", "Ep", "Outcome", "MCQ eval", "Spontaneous", ""],
        awEps.map((e) => h("tr", {}, h("td", {}, h("span", { class: "badge model" }, e.model)), h("td", {}, e.task), h("td", { class: "num" }, e.episode),
          h("td", {}, outcomeBadge(e)), barCell(e.mcq_eval_answers, e.mcq_forks),
          h("td", {}, e.spontaneous_aware === true ? h("span", { class: "badge evalans" }, "aware") : e.spontaneous_aware === false ? "no" : "–"),
          h("td", {}, h("a", { href: `#ep=${encodeURIComponent(e.id)}` }, "open")))))) : null,
    qs.length ? h("section", {}, h("h3", {}, "Questions"),
      (s.questions || []).map((q) => h("details", { class: "raw" }, h("summary", {}, h("span", { class: "fn" }, q.id), ` (${q.kind})`,
        q.eval_label ? ` — evaluation label ${q.eval_label}` : ""), h("pre", {}, q.text ?? "")))) : null,
    Object.keys(spend).length ? h("section", {}, h("h3", {}, "API spend (USD)"),
      h("div", { class: "stats" }, Object.entries(spend).map(([k, v]) => h("span", {}, `${k} `, h("b", {}, num(v) ? `$${v.toFixed(3)}` : String(v)))))) : null);
}

async function showSummary() {
  state.cur = null;
  state.pair = null;
  markCurrentInList();
  clearPanes();
  setNav("awareness");
  $("#cmp-wrap").hidden = true;
  $("#hdr-task").textContent = "Evaluation-awareness probes";
  $("#hdr-instr").textContent = "Does the model think its robot episode was an evaluation? Spontaneous verbalisation during the episode, plus follow-up questions forked from the end of each episode.";
  $("#hdr-stats").replaceChildren();
  document.title = "Awareness summary — Guava transcripts";
  const panesEl = $("#panes");
  panesEl.classList.remove("compare");
  panesEl.replaceChildren(h("p", { class: "empty" }, "Loading…"));
  try {
    state.summary ??= getJSON(AWARENESS.root + "browser-data/summary.json");
    const awEntries = state.index.filter((e) => e.ds === AWARENESS.id);
    const [s, loaded] = await Promise.all([state.summary, Promise.allSettled(awEntries.map(loadEpisode))]);
    if (new URLSearchParams(location.hash.slice(1)).get("view") !== "awareness") return;
    if (s.generated_at) $("#hdr-stats").replaceChildren(h("div", { class: "stats muted" }, `Generated ${s.generated_at}`));
    panesEl.replaceChildren(renderSummary(s, loaded.filter((r) => r.status === "fulfilled").map((r) => r.value)));
  } catch (err) {
    state.summary = null;
    panesEl.replaceChildren(h("p", { class: "empty" }, `Awareness summary not available (${err.message}).`));
  }
}

// ---------- routing ----------
function epHash(entry, pair) {
  return `#ep=${encodeURIComponent(entry.id)}${pair ? `&cmp=${encodeURIComponent(pair.id)}` : ""}`;
}
function go(entry, pair) {
  const hash = epHash(entry, pair);
  if (location.hash !== hash) location.hash = hash; else route();
}
function setNav(view) {
  $("#nav-episodes").classList.toggle("on", view === "episode");
  $("#nav-awareness").classList.toggle("on", view === "awareness");
}
async function route() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("view") === "awareness") return showSummary();
  setNav("episode");
  let entry = state.byId.get(p.get("ep"));
  if (!entry) {
    entry = filtered()[0] || state.index[0];
    if (!entry) return;
    history.replaceState(null, "", epHash(entry));
  }
  const cands = candidatesFor(entry);
  const c = p.get("cmp");
  const pair = c === "1" ? cands[0] || null : cands.find((e) => e.id === c) || null;
  state.cur = entry;
  state.pair = pair;
  markCurrentInList();
  $("#nav-episodes").href = epHash(entry);

  const sel = $("#cmp-sel");
  $("#cmp-wrap").hidden = !cands.length;
  sel.replaceChildren(h("option", { value: "" }, pair ? "Exit compare" : "Compare with…"),
    ...cands.map((e) => h("option", { value: e.id }, entryLabel(e))));
  sel.value = pair ? pair.id : "";
  sel.classList.toggle("on", !!pair);
  sel.onchange = () => go(entry, state.byId.get(sel.value) || null);

  const entries = pair ? [entry, pair].sort((a, b) => modelRank(a.model) - modelRank(b.model) || dsRank(a.ds) - dsRank(b.ds)) : [entry];
  const panesEl = $("#panes");
  let eps;
  try {
    eps = await Promise.all(entries.map(loadEpisode));
  } catch (err) {
    if (state.cur === entry) panesEl.replaceChildren(h("p", { class: "empty" }, `Failed to load episode: ${err.message}`));
    return;
  }
  if (state.cur !== entry || state.pair !== pair) return; // a newer navigation won the race
  clearPanes();
  const ep = eps[0];
  $("#hdr-task").textContent = ep.task ?? entry.task;
  $("#hdr-instr").textContent = ep.instruction ?? "";
  $("#hdr-stats").replaceChildren(...eps.map((e, i) => statsRow(e, entries[i], !!pair)));
  document.title = `${ep.task} · ${pair ? "compare" : ep.model} ep ${ep.episode} — Guava transcripts`;
  state.panes = eps.map((e, i) => new Pane(e, entries[i], !pair));
  panesEl.classList.toggle("compare", !!pair);
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
$("#nav-awareness").addEventListener("click", closeSide);
$("#hdr-instr").onclick = (e) => e.currentTarget.classList.toggle("full");
for (const id of ["#f-run", "#f-model", "#f-task", "#f-outcome"]) $(id).addEventListener("change", renderList);
window.addEventListener("hashchange", route);

async function init() {
  const [indexes, spont] = await Promise.all([
    Promise.allSettled(DATASETS.map((ds) => getJSON(ds.root + "browser-data/index.json"))),
    getJSON(AWARENESS.root + "spontaneous.json").catch(() => []),
  ]);
  for (const s of Array.isArray(spont) ? spont : []) {
    if (s.batch !== "guavatrial") continue;
    state.trialSpont.set(spKey(s.model, s.task, s.episode),
      { aware: s.aware, judge: s.judge, evidence_verified: s.evidence_verified, keyword_hits: s.keyword_hits });
  }
  state.index = DATASETS.flatMap((ds, i) => {
    const r = indexes[i];
    if (r.status !== "fulfilled") return [];
    const idx = r.value;
    return (Array.isArray(idx) ? idx : idx.episodes || []).filter((e) => e && e.path).map((e) => {
      const entry = { ...e, id: ds.root + e.path, ds: ds.id, dsLabel: ds.label, root: ds.root };
      if (entry.spontaneous_aware == null && ds.id === "trial") entry.spontaneous_aware = state.trialSpont.get(spKey(e.model, e.task, e.episode))?.aware;
      return entry;
    });
  }).sort((a, b) => dsRank(a.ds) - dsRank(b.ds) || modelRank(a.model) - modelRank(b.model) || cmpStr(a.model, b.model) || cmpStr(a.task, b.task) || cmpStr(a.episode, b.episode));
  state.byId = new Map(state.index.map((e) => [e.id, e]));
  if (!state.index.length) {
    const why = indexes.map((r) => r.reason?.message).filter(Boolean).join("; ");
    $("#panes").replaceChildren(h("p", { class: "empty" }, `No episode index yet${why ? ` (${why})` : ""}.`));
    $("#counts").textContent = "0 episodes";
    return;
  }
  const uniq = (k) => [...new Set(state.index.map((e) => e[k]))].filter((v) => v != null);
  const dss = uniq("ds");
  fillSelect($("#f-run"), dss, "runs", Object.fromEntries(DATASETS.map((d) => [d.id, d.label])));
  $("#f-run").closest("label").hidden = dss.length < 2;
  $("#nav-awareness").hidden = !dss.includes(AWARENESS.id);
  fillSelect($("#f-model"), uniq("model").sort((a, b) => modelRank(a) - modelRank(b) || cmpStr(a, b)), "models");
  fillSelect($("#f-task"), uniq("task").sort(cmpStr), "tasks");
  renderList();
  route();
}
init();
