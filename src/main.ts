import {
  Globe,
  MAX_TRACES,
  TRACE_COLORS,
  buildChain,
  chainDistance,
  flagEmoji,
  greatCirclePoints,
  haversine,
  type ChainLayer,
  type ChainNode,
  type OriginInfo,
} from "./globe";
import {
  cablePath,
  fetchCableDetail,
  inferCables,
  loadCables,
  type CableCandidate,
  type CableFeature,
  type CableInfo,
} from "./cables";
import { parseTraceText } from "./parse";
import { enrichIps, startTrace, type TraceHandle } from "./tracer";
import type { GeoInfo, Hop, TraceRecord } from "./types";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

type TraceStatus = "running" | "loading" | "done" | "error" | "stopped";

interface Trace {
  id: string;
  label: string;
  family: 4 | 6 | 0; // 0 = 貼り付けで不明
  targetIp?: string;
  hops: Map<number, Hop>;
  status: TraceStatus;
  statusMsg: string;
  cmd?: string;
  handle: TraceHandle | null;
  lastInfo: string | null;
  slot: number;
  ts: number;
  saved: boolean;
  lastChainLen: number;
  /** 発信元 (このマシンの現在地) を経路の起点として描くか。
   *  他所で採取した貼り付け・履歴では実在しない区間になるため false */
  useOrigin: boolean;
}

const traces = new Map<string, Trace>();
const geoByIp = new Map<string, GeoInfo>();
const rdnsByIp = new Map<string, string>();
let origin: OriginInfo | null = null;
let follow = true;
let uiMessage: string | null = null; // 一時的な操作エラー等の表示 (renderStatus が描画)
let cables: CableInfo[] = []; // 海底ケーブル (読み込み後)
const cableInferCache = new Map<string, CableCandidate[]>(); // 区間キー → 推定結果
const legPathCache = new Map<string, [number, number][] | null>(); // 区間キー → ケーブル沿いの線形

const globe = new Globe();
if (import.meta.env.DEV) {
  (window as unknown as { __globe: Globe }).__globe = globe;
}

const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function sortedTraces(): Trace[] {
  return [...traces.values()].sort((a, b) => a.slot - b.slot);
}

function freeSlot(): number {
  const used = new Set([...traces.values()].map((t) => t.slot));
  for (let s = 0; s < MAX_TRACES; s++) if (!used.has(s)) return s;
  return -1;
}

function anyRunning(): boolean {
  return [...traces.values()].some((t) => t.status === "running");
}

function sortedHops(t: Trace): Hop[] {
  return [...t.hops.values()].sort((a, b) => a.ttl - b.ttl);
}

function familyBadge(family: 4 | 6 | 0): string {
  return family === 4 ? "IPv4" : family === 6 ? "IPv6" : "貼付";
}

// ---------------------------------------------------------------------------
// 履歴 (localStorage)
// ---------------------------------------------------------------------------

const HISTORY_KEY = "traceroute-globe:history:v1";
const HISTORY_MAX = 20;

function loadHistory(): TraceRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? (JSON.parse(raw) as TraceRecord[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

let history: TraceRecord[] = loadHistory();

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* プライベートモード等では保存しない */
  }
}

function saveHistoryRecord(t: Trace) {
  if (t.saved || t.hops.size === 0) return;
  t.saved = true;
  history.unshift({
    id: t.id,
    label: t.label,
    family: t.family,
    targetIp: t.targetIp,
    ts: t.ts,
    hops: sortedHops(t),
  });
  history = history.slice(0, HISTORY_MAX);
  persistHistory();
  renderHistory();
}

// ---------------------------------------------------------------------------
// DOM 参照
// ---------------------------------------------------------------------------

const hostInput = $<HTMLInputElement>("#host");
const runButton = $<HTMLButtonElement>("#run");
const statusBox = $<HTMLElement>("#status");
const statusLine = $<HTMLElement>("#status-line");
const cmdLine = $<HTMLElement>("#cmd-line");
const hopsPanel = $<HTMLElement>("#hops");
const hopsTitle = $<HTMLElement>("#hops-title");
const hopSections = $<HTMLElement>("#hop-sections");
const asmapPanel = $<HTMLElement>("#asmap");
const asmapRows = $<HTMLElement>("#asmap-rows");
const historyBox = $<HTMLElement>("#history-box");
const historyList = $<HTMLOListElement>("#history-list");

function segValue(id: string): string {
  return $(`#${id}`).querySelector<HTMLButtonElement>("button.active")!.dataset.value!;
}

for (const segId of ["seg-family", "seg-proto"]) {
  const seg = $(`#${segId}`);
  seg.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    seg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
}

const tabLive = $<HTMLButtonElement>("#tab-live");
const tabPaste = $<HTMLButtonElement>("#tab-paste");
const liveForm = $<HTMLFormElement>("#live-form");
const pasteForm = $<HTMLFormElement>("#paste-form");
tabLive.addEventListener("click", () => setTab(true));
tabPaste.addEventListener("click", () => setTab(false));
function setTab(live: boolean) {
  tabLive.classList.toggle("active", live);
  tabPaste.classList.toggle("active", !live);
  liveForm.hidden = !live;
  pasteForm.hidden = live;
}

// 行き先プリセット
const PRESETS = [
  { label: "🇫🇮 funet", host: "ftp.funet.fi" },
  { label: "🇺🇸 he.net", host: "www.he.net" },
  { label: "🇺🇸 routeviews", host: "route-views.routeviews.org" },
  { label: "🇩🇪 fau", host: "ftp.fau.de" },
  { label: "🇦🇺 aarnet", host: "mirror.aarnet.edu.au" },
  { label: "🇯🇵 wide", host: "www.wide.ad.jp" },
];
{
  const box = $("#presets");
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset";
    b.textContent = p.label;
    b.title = p.host;
    b.addEventListener("click", () => {
      hostInput.value = p.host;
      hostInput.focus();
    });
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function statusShort(t: Trace): string {
  switch (t.status) {
    case "running":
      return "実行中";
    case "loading":
      return "位置情報 取得中";
    case "done":
      return "完了";
    case "stopped":
      return "中断";
    case "error":
      return t.statusMsg || "エラー";
  }
}

function renderStatus() {
  const list = sortedTraces();
  statusBox.hidden = list.length === 0;
  const running = anyRunning();
  runButton.textContent = running ? "停止" : "トレース開始";
  runButton.classList.toggle("danger", running);

  if (uiMessage) statusBox.hidden = false;
  statusLine.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = running ? "dot dot-run" : "dot";
  statusLine.append(dot);
  const text = list.map((t) => `${familyBadge(t.family)}: ${statusShort(t)}`).join(" · ");
  statusLine.append(document.createTextNode(" " + (text || uiMessage || "-")));
  if (uiMessage && text) {
    const warn = document.createElement("span");
    warn.className = "ui-message";
    warn.textContent = uiMessage;
    statusLine.append(warn);
  }
  const label = document.createElement("label");
  label.className = "follow";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = follow;
  cb.addEventListener("change", () => (follow = cb.checked));
  label.append(cb, document.createTextNode("追従"));
  statusLine.append(label);

  cmdLine.textContent = list
    .filter((t) => t.cmd)
    .map((t) => t.cmd)
    .join("\n");
}

function geoText(geo: GeoInfo | undefined): string {
  if (!geo) return "位置情報 取得中…";
  if (geo.status === "private") return "プライベート / CGN アドレス";
  if (geo.status === "fail") return "位置情報なし";
  const place = [geo.city, geo.country].filter(Boolean).join(", ");
  const asn = geo.as ? ` · ${geo.as.split(" ")[0]}` : "";
  const src = geo.source === "ipmap" ? " · IPmap" : "";
  return `${flagEmoji(geo.countryCode)} ${place}${asn}${src}`;
}

/** 光ファイバの往復 ≈ 10ms / 1000km → RTT 1ms あたり最大 100km */
const KM_PER_MS = 100;
/** RTT のジッタ許容 (ms)。バックボーンでも数十 ms 揺れるので大きめに取る */
const RTT_SLACK_MS = 15;

/**
 * 位置候補 (IPmap / ip-api) を RTT の物理整合性で選び直す。
 * - 発信元が分かるライブトレース: 発信元からの距離 ≤ 100km × RTT
 * - それに加えて、RTT 差が最も小さい隣接ホップ (位置既知) との距離 ≤ 100km × (|ΔRTT| + 15)
 * どの候補も通らなければ一次候補を残しつつ地図から除外 (⚠)
 */
function resolveGeo(t: Trace): void {
  const o = t.useOrigin && origin?.geo.status === "ok" ? origin.geo : null;
  const hops = sortedHops(t);
  // 隣接判定の基準には各ホップの一次候補 (サーバが選んだもの) を使う
  const primaryOf = (h: Hop) => {
    const g = h.geo;
    if (!g || g.status !== "ok") return null;
    const c = g.candidates?.[0];
    return c ?? (g.lat != null && g.lon != null ? { lat: g.lat, lon: g.lon } : null);
  };
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    hop.geoSuspect = false;
    const g = hop.geo;
    if (!g || g.status !== "ok" || hop.rtt == null) continue;
    const candidates = g.candidates?.length
      ? g.candidates
      : g.lat != null && g.lon != null
        ? [{ source: g.source ?? "ip-api", lat: g.lat, lon: g.lon, city: g.city, country: g.country, countryCode: g.countryCode }]
        : [];
    if (candidates.length === 0) continue;

    // 基準となる隣接ホップ: RTT 差が最小の、位置が分かっているホップ
    let ref: { lat: number; lon: number; dRtt: number } | null = null;
    for (const dir of [-1, 1]) {
      for (let j = i + dir; j >= 0 && j < hops.length; j += dir) {
        const other = hops[j];
        if (other.rtt == null) continue;
        const p = primaryOf(other);
        if (!p) continue;
        const dRtt = Math.abs(hop.rtt - other.rtt);
        if (!ref || dRtt < ref.dRtt) ref = { lat: p.lat, lon: p.lon, dRtt };
        break;
      }
    }

    const plausible = (c: { lat: number; lon: number }) => {
      if (o && o.lat != null && o.lon != null) {
        if (haversine(o.lat, o.lon, c.lat, c.lon) > hop.rtt! * KM_PER_MS * 1_000 * 1.15 + 50_000) return false;
      }
      if (ref) {
        if (haversine(ref.lat, ref.lon, c.lat, c.lon) > (ref.dRtt + RTT_SLACK_MS) * KM_PER_MS * 1_000) return false;
      }
      return true;
    };

    const chosen = candidates.find(plausible);
    const pick = chosen ?? candidates[0];
    g.lat = pick.lat;
    g.lon = pick.lon;
    g.city = pick.city ?? g.city;
    g.country = pick.country ?? g.country;
    g.countryCode = pick.countryCode ?? g.countryCode;
    g.source = pick.source;
    g.geoScore = pick.score;
    g.geoEngines = pick.engines;
    if (!chosen) hop.geoSuspect = true;
  }
}

function chainOf(t: Trace): ChainNode[] {
  resolveGeo(t);
  return buildChain(sortedHops(t), t.useOrigin ? origin : null, t.targetIp);
}

/** ノードの最小 RTT (ms)。発信元は 0、RTT の無いノードは null */
function nodeMinRtt(n: ChainNode): number | null {
  if (n.isOrigin && n.hops.length === 0) return 0;
  let m: number | null = null;
  for (const h of n.hops) {
    if (h.rtt != null && (m == null || h.rtt < m)) m = h.rtt;
  }
  return m;
}

/** 区間の推定キー (RTT 差も含めて、順位付けが変わる条件ごとにキャッシュ) */
function legKey(a: ChainNode, b: ChainNode): { key: string; rttDelta: number | null } {
  const ra = nodeMinRtt(a);
  const rb = nodeMinRtt(b);
  const rttDelta = ra != null && rb != null ? rb - ra : null;
  return { key: `${a.key}>${b.key}:${rttDelta == null ? "-" : Math.round(rttDelta)}`, rttDelta };
}

function candidatesFor(a: ChainNode, b: ChainNode): CableCandidate[] {
  const { key, rttDelta } = legKey(a, b);
  let cands = cableInferCache.get(key);
  if (!cands) {
    cands = inferCables(a, b, cables, rttDelta);
    cableInferCache.set(key, cands);
  }
  return cands;
}

/** 各区間の海底ケーブル推定。キーは区間の終点ノードの先頭ホップ TTL */
function legCableCandidates(t: Trace): Map<number, CableCandidate[]> {
  const map = new Map<number, CableCandidate[]>();
  if (cables.length === 0) return map;
  const nodes = chainOf(t);
  for (let i = 0; i + 1 < nodes.length; i++) {
    const cands = candidatesFor(nodes[i], nodes[i + 1]);
    const firstHop = nodes[i + 1].hops[0];
    if (cands.length > 0 && firstHop) map.set(firstHop.ttl, cands);
  }
  return map;
}

// ---- 陸上区間の道路沿い推定 (OSRM) ----
// 長距離ファイバは道路・鉄道沿いに敷設されることが多い (InterTubes, SIGCOMM 2015)
// ので、海底ケーブルに該当しない陸上区間は道路ルートで近似する

interface RoadPath {
  coords: [number, number][];
  distance: number; // m
}
const roadPathCache = new Map<string, RoadPath | null | "pending">();

function isTerrestrialLeg(a: ChainNode, b: ChainNode, len: number): boolean {
  if (len < 80_000 || len > 3_000_000) return false;
  const sameCountry = !!a.countryCode && a.countryCode === b.countryCode;
  return sameCountry || len < 1_500_000;
}

function requestRoadPath(a: ChainNode, b: ChainNode, len: number): void {
  const key = `${a.key}>${b.key}`;
  if (roadPathCache.has(key)) return;
  roadPathCache.set(key, "pending");
  const q = new URLSearchParams({ from: `${a.lng},${a.lat}`, to: `${b.lng},${b.lat}` });
  void fetch(`/api/route?${q}`)
    .then((r) => r.json())
    .then((j: { code?: string; distance?: number | null; coordinates?: [number, number][] | null }) => {
      let val: RoadPath | null = null;
      // 大きく迂回するルート (海を回り込む等) は道路沿いとはみなさない
      if (
        j.code === "Ok" &&
        Array.isArray(j.coordinates) &&
        j.coordinates.length >= 2 &&
        typeof j.distance === "number" &&
        j.distance <= len * 2.2
      ) {
        val = { coords: j.coordinates, distance: j.distance };
      }
      roadPathCache.set(key, val);
      if (val && traces.size > 0) {
        renderAll();
        updateGlobe();
      }
    })
    .catch(() => roadPathCache.set(key, null));
}

/** 道路沿い推定を適用した区間: 終点ノードの先頭ホップ TTL → 道路距離 (km) */
function legRoadInfo(t: Trace): Map<number, number> {
  const map = new Map<number, number>();
  const nodes = chainOf(t);
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (legPathCache.get(legKey(a, b).key)) continue; // ケーブル線形が優先
    const road = roadPathCache.get(`${a.key}>${b.key}`);
    const firstHop = b.hops[0];
    if (road && road !== "pending" && firstHop) map.set(firstHop.ttl, road.distance / 1000);
  }
  return map;
}

/**
 * 区間ごとの線形の上書き。
 * - 推定ケーブルがある区間: ホップ → (大円) → 着陸点 → ケーブルの敷設ルート → 着陸点 → (大円) → ホップ
 * - 陸上区間: 道路ルート (取得できるまでは大円)
 */
function legPathsFor(t: Trace): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>();
  const nodes = chainOf(t);
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const chainKey = `${a.key}>${b.key}`;
    const len = haversine(a.lat, a.lng, b.lat, b.lng);
    let path: [number, number][] | null = null;
    if (cables.length > 0) {
      const { key } = legKey(a, b);
      const cached = legPathCache.get(key);
      if (cached !== undefined) {
        path = cached;
      } else {
        const best = candidatesFor(a, b)[0];
        const core = best ? cablePath(best.cable, a, b) : null;
        if (core) {
          const start = { lng: core[0][0], lat: core[0][1] };
          const end = { lng: core[core.length - 1][0], lat: core[core.length - 1][1] };
          const lead = greatCirclePoints(a, start, haversine(a.lat, a.lng, start.lat, start.lng));
          const tail = greatCirclePoints(end, b, haversine(end.lat, end.lng, b.lat, b.lng));
          path = [...lead, ...core.slice(1), ...tail.slice(1)];
        }
        legPathCache.set(key, path);
      }
    }
    if (!path && isTerrestrialLeg(a, b, len)) {
      const road = roadPathCache.get(chainKey);
      if (road === undefined) requestRoadPath(a, b, len);
      else if (road && road !== "pending") path = road.coords;
    }
    if (path) map.set(chainKey, path);
  }
  return map;
}

/** 距離と光ファイバ理論RTTの統計行 */
function statsText(t: Trace, nodes: ChainNode[]): string {
  const dist = chainDistance(nodes);
  if (dist < 10_000) return "";
  const km = dist / 1000;
  const parts = [`経路 ≥ ${Math.round(km).toLocaleString("ja-JP")} km`];
  // 光ファイバ中の光速 ≈ 200,000 km/s → 往復理論値 = km / 100 ms
  const theory = km / 100;
  parts.push(`光理論 ≥ ${theory.toFixed(1)} ms`);
  if (t.targetIp) {
    const rtts = sortedHops(t)
      .filter((h) => h.ip === t.targetIp && h.rtt != null)
      .map((h) => h.rtt as number);
    if (rtts.length > 0) {
      const actual = Math.min(...rtts);
      parts.push(`実測 ${actual.toFixed(1)} ms (効率 ${Math.min(100, (theory / actual) * 100).toFixed(0)}%)`);
    }
  }
  return parts.join(" · ");
}

function buildHopRow(
  t: Trace,
  hop: Hop,
  cableCands?: CableCandidate[],
  roadKm?: number,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "hop";
  const ttl = document.createElement("span");
  ttl.className = "ttl";
  ttl.textContent = String(hop.ttl);
  const main = document.createElement("div");
  main.className = "hop-main";
  if (hop.ip === null && !hop.hostname) {
    li.classList.add("timeout");
    main.innerHTML = `<div class="hop-ip">* 応答なし</div>`;
  } else {
    const ipLine = document.createElement("div");
    ipLine.className = "hop-ip";
    ipLine.textContent = hop.ip ?? "";
    if (hop.hostname) {
      const host = document.createElement("span");
      host.className = "hop-host";
      host.textContent = hop.hostname;
      ipLine.append(" ", host);
    }
    const metaLine = document.createElement("div");
    metaLine.className = "hop-meta";
    const rtt = hop.rtt != null ? `${hop.rtt.toFixed(1)} ms` : "";
    metaLine.textContent = [
      geoText(hop.ip ? hop.geo : { status: "fail" }),
      rtt,
      hop.geoSuspect ? "⚠ RTTと矛盾する位置 (地図から除外)" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (hop.geo?.geoEngines?.length) {
      metaLine.title = `IPmap engines: ${hop.geo.geoEngines.join(", ")} (score ${hop.geo.geoScore ?? "-"})`;
    }
    main.append(ipLine, metaLine);
    if (cableCands && cableCands.length > 0) {
      // この行のホップへ至る区間が海底ケーブルを通ると推定される場合
      const hint = document.createElement("div");
      hint.className = "cable-hint";
      hint.append("🌊 海底ケーブル (推定)");
      cableCands.forEach((c, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cable-name" + (i === 0 ? " best" : "");
        b.textContent = c.cable.name;
        b.title =
          `着陸点までの距離: ${Math.round(c.landingA / 1000)} km / ${Math.round(c.landingB / 1000)} km` +
          ` · 線形 ${Math.round(c.pathLen / 1000).toLocaleString("ja-JP")} km (RTT 期待値 +${c.expectedMs.toFixed(0)} ms)`;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          globe.setCableHighlights(c.cable.features);
          globe.flyToCable(c.cable);
        });
        hint.append(b);
      });
      main.append(hint);
    }
    if (roadKm != null) {
      const road = document.createElement("div");
      road.className = "road-hint";
      road.textContent = `🛣 陸上区間: 道路沿いで推定 (${Math.round(roadKm).toLocaleString("ja-JP")} km)`;
      main.append(road);
    }
    if (hop.geo?.status === "ok" && !hop.geoSuspect) {
      li.classList.add("clickable");
      li.addEventListener("click", () => flyToHop(t, hop));
    } else {
      li.classList.add("nogeo");
    }
  }
  if (hop.ip != null && t.targetIp != null && hop.ip === t.targetIp) li.classList.add("dest");
  li.append(ttl, main);
  return li;
}

function renderHopPanel() {
  const list = sortedTraces();
  const nonEmpty = list.filter((t) => t.hops.size > 0);
  hopsPanel.hidden = nonEmpty.length === 0;
  if (nonEmpty.length === 0) return;
  hopsTitle.textContent =
    list.length === 1
      ? `${list[0].label}${list[0].targetIp && list[0].targetIp !== list[0].label ? ` (${list[0].targetIp})` : ""}`
      : `経路比較 (${list.length})`;

  hopSections.innerHTML = "";
  for (const t of list) {
    const sec = document.createElement("section");
    sec.className = "trace-sec";

    const head = document.createElement("div");
    head.className = "trace-head";
    const dot = document.createElement("span");
    dot.className = "trace-dot";
    dot.style.background = TRACE_COLORS[t.slot].ui;
    const badge = document.createElement("span");
    badge.className = "trace-badge";
    badge.textContent = familyBadge(t.family);
    const name = document.createElement("span");
    name.className = "trace-name";
    name.textContent = t.label;
    name.title = t.targetIp ?? "";
    const st = document.createElement("span");
    st.className = "trace-status";
    st.textContent = statusShort(t);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "trace-remove";
    rm.title = "この経路を消す";
    rm.textContent = "✕";
    rm.addEventListener("click", () => removeTrace(t.id));
    head.append(dot, badge, name, st, rm);
    sec.append(head);

    const nodes = chainOf(t);
    const stats = statsText(t, nodes);
    if (stats) {
      const statsEl = document.createElement("div");
      statsEl.className = "trace-stats";
      statsEl.textContent = stats;
      sec.append(statsEl);
    }

    const ol = document.createElement("ol");
    ol.className = "hop-list";
    const cands = legCableCandidates(t);
    const roads = legRoadInfo(t);
    for (const hop of sortedHops(t)) {
      ol.append(buildHopRow(t, hop, cands.get(hop.ttl), roads.get(hop.ttl)));
    }
    sec.append(ol);
    hopSections.append(sec);
  }
}

// ---------------------------------------------------------------------------
// AS サブウェイマップ
// ---------------------------------------------------------------------------

interface AsBlock {
  kind: "as" | "private" | "lost" | "pending" | "noas";
  asId?: string; // 例: AS4713
  orgName?: string;
  hops: Hop[];
}

function buildAsBlocks(t: Trace): AsBlock[] {
  const blocks: AsBlock[] = [];
  for (const hop of sortedHops(t)) {
    let kind: AsBlock["kind"];
    let asId: string | undefined;
    let orgName: string | undefined;
    if (hop.ip === null) {
      kind = "lost";
    } else if (hop.geo?.status === "private") {
      kind = "private";
    } else if (hop.geo?.status === "ok" && hop.geo.as) {
      kind = "as";
      const sp = hop.geo.as.indexOf(" ");
      asId = sp > 0 ? hop.geo.as.slice(0, sp) : hop.geo.as;
      orgName = sp > 0 ? hop.geo.as.slice(sp + 1) : hop.geo.org || hop.geo.isp;
    } else if (hop.geo?.status === "ok") {
      kind = "noas"; // 位置は分かるがAS情報がない
    } else if (!hop.geo) {
      kind = "pending"; // 応答はあったがジオ情報が未着 — タイムアウトの ✕ とは区別する
    } else {
      kind = "lost"; // ジオ取得失敗
    }
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && last.asId === asId) {
      last.hops.push(hop);
    } else {
      blocks.push({ kind, asId, orgName, hops: [hop] });
    }
  }
  return blocks;
}

function renderAsMap() {
  const list = sortedTraces().filter((t) => t.hops.size > 0);
  asmapPanel.hidden = list.length === 0;
  if (list.length === 0) return;

  asmapRows.innerHTML = "";
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "as-row";
    const badge = document.createElement("span");
    badge.className = "trace-badge";
    badge.style.borderColor = TRACE_COLORS[t.slot].ui;
    badge.style.color = TRACE_COLORS[t.slot].ui;
    badge.textContent = familyBadge(t.family);
    row.append(badge);

    const blocks = buildAsBlocks(t);
    blocks.forEach((b, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "as-sep";
        sep.textContent = "→";
        row.append(sep);
      }
      const el = document.createElement(b.kind === "as" ? "a" : "span");
      el.className = `as-block as-${b.kind}`;
      if (b.kind === "as" && b.asId) {
        const a = el as HTMLAnchorElement;
        a.href = `https://bgp.tools/${b.asId}`;
        a.target = "_blank";
        a.rel = "noopener";
        a.title = `${b.asId} ${b.orgName ?? ""} を bgp.tools で開く`;
      }
      const label = document.createElement("span");
      label.className = "as-label";
      label.textContent =
        b.kind === "as"
          ? (b.asId ?? "AS?")
          : b.kind === "private"
            ? "Private/CGN"
            : b.kind === "noas"
              ? "AS不明"
              : b.kind === "pending"
                ? "取得中…"
                : "✕";
      el.append(label);
      if (b.kind === "as" && b.orgName) {
        const org = document.createElement("span");
        org.className = "as-org";
        org.textContent = b.orgName.length > 18 ? b.orgName.slice(0, 17) + "…" : b.orgName;
        el.append(org);
      }
      const dots = document.createElement("span");
      dots.className = "as-hops";
      for (const h of b.hops) {
        const d = document.createElement("span");
        d.className = "as-hop";
        d.textContent = String(h.ttl);
        d.title = [h.ip ?? "*", h.hostname, h.rtt != null ? `${h.rtt.toFixed(1)} ms` : null, h.geo?.city]
          .filter(Boolean)
          .join(" · ");
        dots.append(d);
      }
      el.append(dots);
      row.append(el);
    });
    asmapRows.append(row);
  }
}

$<HTMLButtonElement>("#asmap-toggle").addEventListener("click", () => {
  const collapsed = asmapRows.hidden;
  asmapRows.hidden = !collapsed;
  $("#asmap-toggle").textContent = collapsed ? "−" : "+";
});

// ---------------------------------------------------------------------------
// 履歴 UI
// ---------------------------------------------------------------------------

function renderHistory() {
  historyBox.hidden = history.length === 0;
  historyList.innerHTML = "";
  for (const rec of history) {
    const li = document.createElement("li");
    li.className = "hist";
    const overlayId = `hist:${rec.id}`;
    if (traces.has(overlayId)) li.classList.add("active");
    const time = document.createElement("span");
    time.className = "hist-time";
    time.textContent = new Date(rec.ts).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const badge = document.createElement("span");
    badge.className = "trace-badge";
    badge.textContent = familyBadge(rec.family);
    const name = document.createElement("span");
    name.className = "hist-name";
    name.textContent = rec.label;
    const count = document.createElement("span");
    count.className = "hist-count";
    count.textContent = `${rec.hops.length}hop`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "hist-del";
    del.textContent = "✕";
    del.title = "履歴から削除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      history = history.filter((r) => r.id !== rec.id);
      persistHistory();
      if (traces.has(overlayId)) removeTrace(overlayId);
      renderHistory();
    });
    li.append(time, badge, name, count, del);
    li.addEventListener("click", () => {
      if (traces.has(overlayId)) {
        removeTrace(overlayId);
      } else {
        addHistoryTrace(rec);
      }
      renderHistory();
    });
    historyList.append(li);
  }
}

// ---------------------------------------------------------------------------
// 地球儀への反映
// ---------------------------------------------------------------------------

function currentChains(): ChainLayer[] {
  return sortedTraces().map((t) => ({
    id: t.id,
    slot: t.slot,
    nodes: chainOf(t),
    legPaths: legPathsFor(t),
  }));
}

function updateGlobe(followId?: string) {
  const chains = currentChains();
  globe.setChains(chains);
  // 各区間の最有力ケーブルを発光表示
  const hi: CableFeature[] = [];
  const seen = new Set<string>();
  for (const t of traces.values()) {
    for (const list of legCableCandidates(t).values()) {
      const best = list[0];
      if (best && !seen.has(best.cable.id)) {
        seen.add(best.cable.id);
        hi.push(...best.cable.features);
      }
    }
  }
  globe.setCableHighlights(hi);
  const runningCount = [...traces.values()].filter((t) => t.status === "running").length;
  for (const t of traces.values()) {
    const len = chains.find((c) => c.id === t.id)?.nodes.length ?? 0;
    if (
      followId === t.id &&
      follow &&
      runningCount === 1 && // 複数同時実行中はカメラの取り合いになるので追従しない
      len > t.lastChainLen
    ) {
      globe.followLatest(t.id);
    }
    t.lastChainLen = len;
  }
}

function flyToHop(t: Trace, hop: Hop) {
  const node = chainOf(t).find((n) => n.hops.some((h) => h.ttl === hop.ttl));
  if (node) void globe.flyToNode(node);
}

function renderAll() {
  renderStatus();
  renderHopPanel();
  renderAsMap();
  renderHistory();
}

// ---------------------------------------------------------------------------
// トレースのライフサイクル
// ---------------------------------------------------------------------------

function removeTrace(id: string) {
  const t = traces.get(id);
  if (!t) return;
  t.handle?.stop();
  traces.delete(id);
  updateGlobe();
  renderAll();
}

function clearTraces() {
  for (const t of traces.values()) t.handle?.stop();
  traces.clear();
  uiMessage = null;
  globe.reset();
  renderAll();
}

function stopAllRunning() {
  for (const t of traces.values()) {
    if (t.status === "running") {
      t.handle?.stop();
      t.handle = null;
      t.status = "stopped";
      t.statusMsg = "中断";
      completeAndSave(t);
    }
  }
  renderAll();
}

/** 完了処理: 足りないジオ情報を補完してから履歴へ保存 */
function completeAndSave(t: Trace) {
  const missing = sortedHops(t)
    .filter((h) => h.ip && (!h.geo || h.geo.status === "fail"))
    .map((h) => h.ip as string);
  const finish = () => {
    // 履歴保存は、enrich 待ちの間に表示から消されたトレースでも行う
    saveHistoryRecord(t);
    if (traces.get(t.id) !== t) return;
    renderAll();
    updateGlobe();
    if (follow && !anyRunning()) globe.fitAll();
  };
  if (missing.length === 0) {
    finish();
    return;
  }
  void enrichIps(missing)
    .then((results) => {
      for (const hop of t.hops.values()) {
        if (!hop.ip) continue;
        const r = results[hop.ip];
        if (!r) continue;
        if (!hop.geo || hop.geo.status === "fail") hop.geo = r.geo;
        hop.hostname = hop.hostname ?? r.hostname ?? undefined;
      }
      finish();
    })
    .catch(() => finish());
}

function addLiveTrace(host: string, family: 4 | 6, proto: "icmp" | "udp") {
  const slot = freeSlot();
  if (slot < 0) return;
  const t: Trace = {
    id: newId(),
    label: host,
    family,
    hops: new Map(),
    status: "running",
    statusMsg: "",
    handle: null,
    lastInfo: null,
    slot,
    ts: Date.now(),
    saved: false,
    lastChainLen: 0,
    useOrigin: true,
  };
  traces.set(t.id, t);
  t.handle = startTrace({ host, v6: family === 6, proto }, (ev) => {
    if (traces.get(t.id) !== t) return; // クリア済みトレースの残イベント
    switch (ev.type) {
      case "cmd":
        t.cmd = ev.cmd;
        renderStatus();
        break;
      case "start":
        t.label = ev.target;
        t.targetIp = ev.targetIp;
        renderAll();
        break;
      case "hop": {
        const hop: Hop = { ttl: ev.ttl, ip: ev.ip, rtt: ev.rtt, note: ev.note };
        if (ev.ip) {
          hop.geo = geoByIp.get(ev.ip);
          hop.hostname = rdnsByIp.get(ev.ip);
        }
        t.hops.set(ev.ttl, hop);
        renderAll();
        updateGlobe(hop.geo?.status === "ok" ? t.id : undefined);
        break;
      }
      case "geo":
        geoByIp.set(ev.ip, ev.geo);
        for (const tr of traces.values()) {
          for (const hop of tr.hops.values()) {
            if (hop.ip === ev.ip) hop.geo = ev.geo;
          }
        }
        renderAll();
        updateGlobe(t.id);
        break;
      case "rdns":
        rdnsByIp.set(ev.ip, ev.hostname);
        for (const tr of traces.values()) {
          for (const hop of tr.hops.values()) {
            if (hop.ip === ev.ip) hop.hostname = ev.hostname;
          }
        }
        renderAll();
        break;
      case "info":
        t.lastInfo = ev.line;
        break;
      case "error":
        t.status = "error";
        t.statusMsg = `エラー: ${ev.message}`;
        t.handle = null;
        completeAndSave(t);
        renderAll();
        break;
      case "done":
        if (ev.code === 0 || ev.code == null) {
          t.status = "done";
          t.statusMsg = "完了";
        } else {
          t.status = "error";
          t.statusMsg = `失敗: ${t.lastInfo ?? `exit ${ev.code}`}`;
        }
        t.handle = null;
        completeAndSave(t);
        renderAll();
        break;
    }
  });
}

function addHistoryTrace(rec: TraceRecord) {
  const slot = freeSlot();
  if (slot < 0) return;
  const t: Trace = {
    id: `hist:${rec.id}`,
    label: rec.label,
    family: rec.family,
    targetIp: rec.targetIp,
    hops: new Map(rec.hops.map((h) => [h.ttl, { ...h }])),
    status: "done",
    statusMsg: "履歴",
    handle: null,
    lastInfo: null,
    slot,
    ts: rec.ts,
    saved: true,
    lastChainLen: 0,
    useOrigin: false,
  };
  traces.set(t.id, t);
  updateGlobe();
  renderAll();
  if (follow) globe.fitAll();
}

// ---------------------------------------------------------------------------
// フォーム
// ---------------------------------------------------------------------------

liveForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (anyRunning()) {
    stopAllRunning();
    return;
  }
  const host = hostInput.value.trim();
  if (!host) return;
  clearTraces();
  const famSel = segValue("seg-family");
  const proto = segValue("seg-proto") as "icmp" | "udp";
  const fams: (4 | 6)[] = famSel === "46" ? [6, 4] : famSel === "6" ? [6] : [4];
  for (const fam of fams) addLiveTrace(host, fam, proto);
  renderAll();
});

pasteForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $<HTMLTextAreaElement>("#paste-text").value;
  const parsed = parseTraceText(text);
  if (parsed.hops.length === 0) {
    uiMessage = "ホップ行を読み取れませんでした";
    renderAll();
    return;
  }
  clearTraces();
  const firstIp = parsed.hops.find((h) => h.ip)?.ip ?? parsed.targetIp ?? "";
  const family: 4 | 6 | 0 = firstIp.includes(":") ? 6 : firstIp ? 4 : 0;
  const t: Trace = {
    id: newId(),
    label: parsed.target ?? "(貼り付け)",
    family,
    targetIp: parsed.targetIp ?? parsed.hops[parsed.hops.length - 1].ip ?? undefined,
    hops: new Map(parsed.hops.map((h) => [h.ttl, h])),
    status: "loading",
    statusMsg: "",
    handle: null,
    lastInfo: null,
    slot: freeSlot(),
    ts: Date.now(),
    saved: false,
    lastChainLen: 0,
    useOrigin: false,
  };
  if (t.slot < 0) return;
  traces.set(t.id, t);
  renderAll();
  const ips = parsed.hops.map((h) => h.ip).filter((ip): ip is string => ip != null);
  void enrichIps(ips)
    .then((results) => {
      if (traces.get(t.id) !== t) return;
      for (const hop of t.hops.values()) {
        if (!hop.ip) continue;
        const r = results[hop.ip];
        if (!r) continue;
        hop.geo = r.geo;
        hop.hostname = hop.hostname ?? r.hostname ?? undefined;
      }
      t.status = "done";
      t.statusMsg = "完了";
      renderAll();
      updateGlobe();
      globe.fitAll();
      saveHistoryRecord(t);
    })
    .catch((err) => {
      if (traces.get(t.id) !== t) return;
      t.status = "error";
      t.statusMsg = `位置情報の取得に失敗: ${err.message}`;
      renderAll();
    });
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

$<HTMLButtonElement>("#fit").addEventListener("click", () => globe.fitAll());

async function boot() {
  renderHistory();
  // 地球儀の初期化 (WASM+タイル) が済むまで実行系ボタンを止める
  const visualizeButton = $<HTMLButtonElement>("#visualize");
  runButton.disabled = true;
  visualizeButton.disabled = true;
  const runLabel = runButton.textContent;
  runButton.textContent = "地球儀を初期化中…";
  await globe.init($("#globe"), createChipRoot());
  runButton.disabled = false;
  visualizeButton.disabled = false;
  runButton.textContent = runLabel;

  // 海底ケーブル: 表示トグル + データ読み込み (失敗しても本体は動く)
  const cablesToggle = $<HTMLInputElement>("#cables-toggle");
  const cablesStatus = $("#cables-status");
  cablesToggle.addEventListener("change", () => globe.setCablesVisible(cablesToggle.checked));
  globe.setCableClickHandler((id) => {
    void fetchCableDetail(id)
      .then((d) => {
        const parts = [`🌊 ${d.name}`];
        if (d.length) parts.push(d.length);
        if (d.rfs) parts.push(`RFS ${d.rfs}`);
        if (d.owners) parts.push(d.owners.length > 48 ? d.owners.slice(0, 47) + "…" : d.owners);
        globe.setCableChipText(parts.join(" · "));
      })
      .catch(() => {});
  });
  // 陸上ファイバ (OFDS): 初回はサーバ側で集約に時間がかかる
  const fiberToggle = $<HTMLInputElement>("#fiber-toggle");
  const fiberStatus = $("#fiber-status");
  fiberToggle.addEventListener("change", () => globe.setFiberVisible(fiberToggle.checked));
  void fetch("/api/fiber")
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const gj = (await r.json()) as { features: unknown[] };
      globe.setFiber(gj);
      fiberStatus.textContent = `${gj.features.length.toLocaleString("ja-JP")} 区間 (OFDS)`;
    })
    .catch((e: unknown) => {
      fiberStatus.textContent = "取得できませんでした";
      console.warn("terrestrial fiber:", e);
    });

  void loadCables()
    .then(({ geojson, cables: list }) => {
      cables = list;
      cableInferCache.clear();
      legPathCache.clear();
      globe.setCables(geojson);
      cablesStatus.textContent = `${list.length} 本`;
      renderAll();
      updateGlobe();
    })
    .catch((e: unknown) => {
      cablesStatus.textContent = "取得できませんでした";
      console.warn("submarine cables:", e);
    });
  globe.setNodeClickHandler((node) => void globe.flyToNode(node));
  globe.onUserGrab(() => {
    if (!follow) return;
    follow = false;
    const cb = statusLine.querySelector<HTMLInputElement>(".follow input");
    if (cb) cb.checked = false;
  });
  // 発信元 (自分のグローバルIP) の位置 — 失敗しても続行
  try {
    const res = await fetch("/api/self");
    const geo = (await res.json()) as Omit<GeoInfo, "status"> & { status: string; query?: string };
    if (geo.status === "success") {
      origin = {
        geo: { ...geo, status: "ok" },
        label: `発信元${geo.city ? ` (${geo.city})` : ""}`,
      };
      // origin 確定より先に描画が済んだトレースへ発信元を反映
      renderAll();
      updateGlobe();
    }
  } catch {
    /* オフラインでも動くように */
  }
}

function createChipRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = "chip-root";
  document.body.appendChild(root);
  return root;
}

void boot().catch((e: unknown) => {
  console.error("初期化に失敗しました:", e);
  (window as unknown as { __bootError?: string }).__bootError =
    e instanceof Error ? (e.stack ?? String(e)) : String(e);
});
