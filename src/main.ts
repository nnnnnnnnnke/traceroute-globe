import { Globe, buildChain, flagEmoji, type OriginInfo } from "./globe";
import { parseTraceText } from "./parse";
import { enrichIps, startTrace, type TraceHandle } from "./tracer";
import type { GeoInfo, Hop } from "./types";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

const hops = new Map<number, Hop>();
const geoByIp = new Map<string, GeoInfo>();
const rdnsByIp = new Map<string, string>();
let target = "";
let targetIp: string | undefined;
let origin: OriginInfo | null = null;
let handle: TraceHandle | null = null;
let running = false;
let follow = true;
let lastChainLen = 0;
let traceGen = 0; // 古い非同期処理 (enrich 等) が新しいトレースを上書きしないための世代番号
let lastInfo: string | null = null; // traceroute の stderr 最終行 (エラー表示用)

const globe = new Globe();
if (import.meta.env.DEV) {
  (window as unknown as { __globe: Globe }).__globe = globe;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const hostInput = $<HTMLInputElement>("#host");
const runButton = $<HTMLButtonElement>("#run");
const statusBox = $<HTMLElement>("#status");
const statusLine = $<HTMLElement>("#status-line");
const cmdLine = $<HTMLElement>("#cmd-line");
const hopsPanel = $<HTMLElement>("#hops");
const hopsTitle = $<HTMLElement>("#hops-title");
const hopList = $<HTMLOListElement>("#hop-list");

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

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function setStatus(text: string, cmd?: string) {
  statusBox.hidden = false;
  statusLine.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = running ? "dot dot-run" : "dot";
  statusLine.append(dot, document.createTextNode(" " + text));
  const label = document.createElement("label");
  label.className = "follow";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = follow;
  cb.addEventListener("change", () => (follow = cb.checked));
  label.append(cb, document.createTextNode("追従"));
  statusLine.append(label);
  if (cmd !== undefined) cmdLine.textContent = cmd;
}

function geoText(geo: GeoInfo | undefined): string {
  if (!geo) return "位置情報 取得中…";
  if (geo.status === "private") return "プライベート / CGN アドレス";
  if (geo.status === "fail") return "位置情報なし";
  const place = [geo.city, geo.country].filter(Boolean).join(", ");
  const asn = geo.as ? ` · ${geo.as.split(" ")[0]}` : "";
  return `${flagEmoji(geo.countryCode)} ${place}${asn}`;
}

function renderList() {
  hopsPanel.hidden = hops.size === 0;
  hopsTitle.textContent = target
    ? `${target}${targetIp && targetIp !== target ? ` (${targetIp})` : ""}`
    : "経路";
  hopList.innerHTML = "";
  const sorted = [...hops.values()].sort((a, b) => a.ttl - b.ttl);
  for (const hop of sorted) {
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
      metaLine.textContent = [geoText(hop.ip ? hop.geo : { status: "fail" }), rtt]
        .filter(Boolean)
        .join(" · ");
      main.append(ipLine, metaLine);
      if (hop.geo?.status === "ok") {
        li.classList.add("clickable");
        li.addEventListener("click", () => flyToHop(hop));
      } else {
        li.classList.add("nogeo");
      }
    }
    if (hop.ip != null && targetIp != null && hop.ip === targetIp) li.classList.add("dest");
    li.append(ttl, main);
    hopList.append(li);
  }
}

function currentChain() {
  const sorted = [...hops.values()].sort((a, b) => a.ttl - b.ttl);
  return buildChain(sorted, origin, targetIp);
}

function updateGlobe(followNew: boolean) {
  const chain = currentChain();
  globe.setChain(chain);
  if (followNew && follow && chain.length > lastChainLen) {
    globe.followLatest();
  }
  lastChainLen = chain.length;
}

function flyToHop(hop: Hop) {
  const node = currentChain().find((n) => n.hops.includes(hop) || n.hops.some((h) => h.ttl === hop.ttl));
  if (node) void globe.flyToNode(node);
}

// ---------------------------------------------------------------------------
// ライブトレース
// ---------------------------------------------------------------------------

function resetTrace(newTarget: string) {
  traceGen++;
  hops.clear();
  target = newTarget;
  targetIp = undefined;
  lastInfo = null;
  lastChainLen = 0;
  globe.reset();
  renderList();
}

/** 実行中のライブトレースを止める (貼り付けモードへの切り替え時など) */
function stopLive() {
  if (!running) return;
  handle?.stop();
  handle = null;
  running = false;
  runButton.textContent = "トレース開始";
  runButton.classList.remove("danger");
}

liveForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (running) {
    handle?.stop();
    finishTrace("中断しました");
    return;
  }
  const host = hostInput.value.trim();
  if (!host) return;
  resetTrace(host);
  running = true;
  runButton.textContent = "停止";
  runButton.classList.add("danger");
  setStatus(`${host} をトレース中…`, "");
  handle = startTrace(
    { host, v6: segValue("seg-family") === "6", proto: segValue("seg-proto") as "icmp" | "udp" },
    (ev) => {
      switch (ev.type) {
        case "cmd":
          setStatus(`${host} をトレース中…`, ev.cmd);
          break;
        case "start":
          target = ev.target;
          targetIp = ev.targetIp;
          renderList();
          break;
        case "hop": {
          const hop: Hop = { ttl: ev.ttl, ip: ev.ip, rtt: ev.rtt, note: ev.note };
          if (ev.ip) {
            hop.geo = geoByIp.get(ev.ip);
            hop.hostname = rdnsByIp.get(ev.ip);
          }
          hops.set(ev.ttl, hop);
          renderList();
          updateGlobe(hop.geo?.status === "ok");
          break;
        }
        case "geo":
          geoByIp.set(ev.ip, ev.geo);
          for (const hop of hops.values()) {
            if (hop.ip === ev.ip) hop.geo = ev.geo;
          }
          renderList();
          updateGlobe(true);
          break;
        case "rdns":
          rdnsByIp.set(ev.ip, ev.hostname);
          for (const hop of hops.values()) {
            if (hop.ip === ev.ip) hop.hostname = ev.hostname;
          }
          renderList();
          break;
        case "info":
          lastInfo = ev.line;
          break;
        case "error":
          finishTrace(`エラー: ${ev.message}`);
          break;
        case "done":
          finishTrace(
            ev.code === 0 || ev.code == null
              ? "完了"
              : `traceroute が失敗しました: ${lastInfo ?? `exit ${ev.code}`}`,
          );
          break;
      }
    },
  );
});

function finishTrace(message: string) {
  running = false;
  handle = null;
  runButton.textContent = "トレース開始";
  runButton.classList.remove("danger");
  setStatus(message);
  updateGlobe(false);
  if (follow && lastChainLen > 1) globe.fitAll();
  // SSE クローズまでに間に合わなかった / レートリミットで fail になったジオ情報を補完
  const missing = [...hops.values()]
    .filter((h) => h.ip && (!h.geo || h.geo.status === "fail"))
    .map((h) => h.ip as string);
  if (missing.length === 0) return;
  const gen = traceGen;
  void enrichIps(missing)
    .then((results) => {
      if (gen !== traceGen) return; // すでに次のトレースが始まっている
      for (const hop of hops.values()) {
        if (!hop.ip) continue;
        const r = results[hop.ip];
        if (!r) continue;
        if (!hop.geo || hop.geo.status === "fail") hop.geo = r.geo;
        hop.hostname = hop.hostname ?? r.hostname ?? undefined;
      }
      renderList();
      updateGlobe(false);
      if (follow && currentChain().length > 1) globe.fitAll();
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// 貼り付けモード
// ---------------------------------------------------------------------------

pasteForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $<HTMLTextAreaElement>("#paste-text").value;
  const parsed = parseTraceText(text);
  if (parsed.hops.length === 0) {
    setStatus("ホップ行を読み取れませんでした");
    return;
  }
  stopLive(); // 実行中のライブトレースのイベントが混ざらないように
  resetTrace(parsed.target ?? "(貼り付け)");
  targetIp = parsed.targetIp ?? parsed.hops[parsed.hops.length - 1].ip ?? undefined;
  for (const hop of parsed.hops) hops.set(hop.ttl, hop);
  renderList();
  setStatus(`${parsed.hops.length} ホップを読み込み、位置情報を取得中…`);
  const ips = parsed.hops.map((h) => h.ip).filter((ip): ip is string => ip != null);
  const gen = traceGen;
  void enrichIps(ips)
    .then((results) => {
      if (gen !== traceGen) return; // すでに次のトレースが始まっている
      for (const hop of hops.values()) {
        if (!hop.ip) continue;
        const r = results[hop.ip];
        if (!r) continue;
        hop.geo = r.geo;
        hop.hostname = hop.hostname ?? r.hostname ?? undefined;
      }
      setStatus("完了");
      renderList();
      updateGlobe(false);
      globe.fitAll();
    })
    .catch((err) => {
      if (gen === traceGen) setStatus(`位置情報の取得に失敗: ${err.message}`);
    });
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

$<HTMLButtonElement>("#fit").addEventListener("click", () => globe.fitAll());

async function boot() {
  await globe.init($("#globe"), createChipRoot());
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

void boot();
