import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";

// ---------------------------------------------------------------------------
// IP ジオロケーション (ip-api.com batch + キャッシュ + マイクロバッチ)
// ---------------------------------------------------------------------------

export interface GeoInfo {
  status: "ok" | "private" | "fail";
  lat?: number;
  lon?: number;
  city?: string;
  country?: string;
  countryCode?: string;
  isp?: string;
  org?: string;
  as?: string;
  message?: string;
  /** 位置の出どころ。ipmap = RIPE IPmap (遅延実測・逆引き等)、ip-api = 一般IPデータベース */
  source?: "ipmap" | "ip-api";
  geoScore?: number;
  geoEngines?: string[];
  /** 各ソースの候補位置。クライアントが RTT の物理整合性で選び直す */
  candidates?: GeoCandidate[];
}

export interface GeoCandidate {
  source: "ipmap" | "ip-api";
  lat: number;
  lon: number;
  city?: string;
  country?: string;
  countryCode?: string;
  score?: number;
  engines?: string[];
}

/** ip-api + IPmap を合成した最終結果 */
const geoCache = new Map<string, GeoInfo>();
/** ip-api 単体の結果 (AS 情報の供給源) */
const ipApiCache = new Map<string, GeoInfo>();

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    return (
      low === "::1" ||
      low.startsWith("fe8") ||
      low.startsWith("fe9") ||
      low.startsWith("fea") ||
      low.startsWith("feb") ||
      low.startsWith("fc") ||
      low.startsWith("fd") ||
      low.startsWith("2001:db8")
    );
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) || // CGN (100.64.0.0/10)
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// ip-api.com の /batch は 15req/分 制限 (超過で 429 → 1時間 ban もあり得る)。
// 300ms 窓でまとめつつ、前回のリクエストから 4.2 秒空くまでは次のバッチを送らない。
const BATCH_MIN_INTERVAL_MS = 4_200;
let pendingIps = new Map<string, Array<(g: GeoInfo) => void>>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let lastBatchAt = 0;

function lookupIpApi(ip: string): Promise<GeoInfo> {
  const cached = ipApiCache.get(ip);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const list = pendingIps.get(ip) ?? [];
    list.push(resolve);
    pendingIps.set(ip, list);
    if (!batchTimer) {
      const wait = Math.max(300, lastBatchAt + BATCH_MIN_INTERVAL_MS - Date.now());
      batchTimer = setTimeout(flushGeoBatch, wait);
    }
  });
}

async function flushGeoBatch() {
  batchTimer = null;
  lastBatchAt = Date.now();
  const batch = pendingIps;
  pendingIps = new Map();
  const ips = [...batch.keys()];
  if (ips.length === 0) return;
  const results = new Map<string, GeoInfo>();
  try {
    // 無料枠は HTTP のみ。サーバ側から叩くのでブラウザの mixed content 制約は受けない。
    const res = await fetch(
      "http://ip-api.com/batch?fields=status,message,country,countryCode,city,lat,lon,isp,org,as,query",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ips.slice(0, 100)),
      },
    );
    if (!res.ok) throw new Error(`ip-api.com HTTP ${res.status}`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const ip = String(row.query ?? "");
      if (row.status === "success") {
        results.set(ip, {
          status: "ok",
          lat: Number(row.lat),
          lon: Number(row.lon),
          city: (row.city as string) || undefined,
          country: (row.country as string) || undefined,
          countryCode: (row.countryCode as string) || undefined,
          isp: (row.isp as string) || undefined,
          org: (row.org as string) || undefined,
          as: (row.as as string) || undefined,
        });
      } else {
        results.set(ip, { status: "fail", message: String(row.message ?? "") });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const ip of ips) results.set(ip, { status: "fail", message: msg });
  }
  for (const [ip, resolvers] of batch) {
    const g = results.get(ip) ?? { status: "fail" as const, message: "no result" };
    // 失敗はキャッシュしない(あとで再試行できるように)
    if (g.status !== "fail") ipApiCache.set(ip, g);
    for (const r of resolvers) r(g);
  }
}

// ---------------------------------------------------------------------------
// RIPE IPmap: RIPE Atlas の遅延実測・逆引きホスト名・geofeed 等を組み合わせた
// ルータ向けの位置推定。一般向けIPデータベース (ip-api) はバックボーンの
// ルータを大きく外すことがあるので、IPmap に「worlds (人口ベースの当て推量)」
// 以外の根拠がある場合はそちらを採用する
// ---------------------------------------------------------------------------

interface IpmapLocation {
  lat: number;
  lon: number;
  city?: string;
  country?: string;
  countryCode?: string;
  score: number;
  engines: string[];
  /** worlds 以外のエンジン (latency / crowdsourced / geofeed など) の根拠があるか */
  strong: boolean;
}

const ipmapCache = new Map<string, IpmapLocation | null>();
const IPMAP_MAX_INFLIGHT = 4;
let ipmapInflight = 0;
const ipmapWaiters: Array<() => void> = [];

async function withIpmapSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (ipmapInflight >= IPMAP_MAX_INFLIGHT) {
    await new Promise<void>((r) => ipmapWaiters.push(r));
  }
  ipmapInflight++;
  try {
    return await fn();
  } finally {
    ipmapInflight--;
    ipmapWaiters.shift()?.();
  }
}

async function lookupIpmap(ip: string): Promise<IpmapLocation | null> {
  const cached = ipmapCache.get(ip);
  if (cached !== undefined) return cached;
  return withIpmapSlot(async () => {
    try {
      const res = await fetch(
        `https://ipmap-api.ripe.net/v1/locate/${encodeURIComponent(ip)}/best`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) throw new Error(`ipmap HTTP ${res.status}`);
      const j = (await res.json()) as {
        location?: Record<string, unknown> | null;
        score?: number;
        geofeed?: string;
      };
      const loc = j.location;
      if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") {
        ipmapCache.set(ip, null);
        return null;
      }
      const contributions = (loc.contributions ?? {}) as Record<string, { confirmations?: number } | undefined>;
      const engines = Object.keys(contributions);
      // latency エンジンは他プローブによる確認 (confirmations) が無い単発計測だと
      // 大きく外すことがある (例: 確認0回の 0.2ms 計測で豪州判定) ので根拠に数えない
      const latencyConfirmed = (contributions.latency?.confirmations ?? 0) >= 1;
      const r: IpmapLocation = {
        lat: loc.latitude,
        lon: loc.longitude as number,
        city: (loc.cityName as string) || undefined,
        country: (loc.countryName as string) || undefined,
        countryCode: (loc.countryCodeAlpha2 as string) || undefined,
        score: Number(loc.score ?? j.score ?? 0),
        engines,
        strong:
          latencyConfirmed ||
          engines.some((e) => e !== "worlds" && e !== "latency") ||
          Boolean(j.geofeed),
      };
      ipmapCache.set(ip, r);
      return r;
    } catch {
      return null; // 一時的な失敗はキャッシュしない
    }
  });
}

/** ip-api (ASN・ISP) と IPmap (位置) を合成する */
async function lookupGeo(ip: string): Promise<GeoInfo> {
  const cached = geoCache.get(ip);
  if (cached) return cached;
  if (isPrivateIp(ip)) {
    const g: GeoInfo = { status: "private" };
    geoCache.set(ip, g);
    return g;
  }
  const [base, ipmap] = await Promise.all([lookupIpApi(ip), lookupIpmap(ip)]);
  const candidates: GeoCandidate[] = [];
  if (ipmap && ipmap.strong) {
    candidates.push({
      source: "ipmap",
      lat: ipmap.lat,
      lon: ipmap.lon,
      city: ipmap.city,
      country: ipmap.country,
      countryCode: ipmap.countryCode,
      score: ipmap.score,
      engines: ipmap.engines,
    });
  }
  if (base.status === "ok" && base.lat != null && base.lon != null) {
    candidates.push({
      source: "ip-api",
      lat: base.lat,
      lon: base.lon,
      city: base.city,
      country: base.country,
      countryCode: base.countryCode,
    });
  }
  if (ipmap && !ipmap.strong && candidates.length === 0) {
    // 根拠の弱い IPmap (人口ベースの当て推量) は最後の手段
    candidates.push({ source: "ipmap", lat: ipmap.lat, lon: ipmap.lon, city: ipmap.city, country: ipmap.country, countryCode: ipmap.countryCode, score: ipmap.score, engines: ipmap.engines });
  }
  let g: GeoInfo;
  const primary = candidates[0];
  if (primary) {
    g = {
      ...base,
      status: "ok",
      message: undefined,
      lat: primary.lat,
      lon: primary.lon,
      city: primary.city ?? base.city,
      country: primary.country ?? base.country,
      countryCode: primary.countryCode ?? base.countryCode,
      source: primary.source,
      geoScore: primary.score,
      geoEngines: primary.engines,
      candidates,
    };
  } else {
    g = base;
  }
  // ip-api が失敗 (レート制限等) の間は合成結果をキャッシュせず、後の再取得で AS 情報を埋められるようにする
  if (g.status !== "fail" && base.status !== "fail") geoCache.set(ip, g);
  return g;
}

// ---------------------------------------------------------------------------
// 逆引き DNS
// ---------------------------------------------------------------------------

const rdnsCache = new Map<string, string | null>();

async function lookupRdns(ip: string): Promise<string | null> {
  if (rdnsCache.has(ip)) return rdnsCache.get(ip)!;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);
    const name = names[0] ?? null;
    rdnsCache.set(ip, name);
    return name;
  } catch {
    rdnsCache.set(ip, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// traceroute 実行 + SSE ストリーム
// ---------------------------------------------------------------------------

const HOST_RE = /^[A-Za-z0-9._:-]{1,255}$/;

function sseSend(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleTrace(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", "http://localhost");
  const host = url.searchParams.get("host") ?? "";
  const v6 = url.searchParams.get("v") === "6";
  const proto = url.searchParams.get("proto") === "udp" ? "udp" : "icmp";
  const maxhops = Math.min(Math.max(Number(url.searchParams.get("maxhops") ?? 30) || 30, 1), 64);
  const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 2) || 2, 1), 5);

  if (!HOST_RE.test(host)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid host" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const cmd = v6 ? "traceroute6" : "traceroute";
  const args = [
    ...(proto === "icmp" ? ["-I"] : []),
    "-n",
    "-q",
    "1",
    "-w",
    String(wait),
    "-m",
    String(maxhops),
    host,
  ];
  sseSend(res, { type: "cmd", cmd: [cmd, ...args].join(" ") });

  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;

  const enrich = (ip: string) => {
    void lookupGeo(ip).then((geo) => {
      if (!closed) sseSend(res, { type: "geo", ip, geo });
    });
    void lookupRdns(ip).then((hostname) => {
      if (!closed && hostname) sseSend(res, { type: "rdns", ip, hostname });
    });
  };

  // 行分割しつつパース。stdout: ホップ行 / stderr: ヘッダ・警告
  const lineBuffers = { out: "", err: "" };
  const onData = (which: "out" | "err") => (chunk: Buffer) => {
    lineBuffers[which] += chunk.toString();
    let idx: number;
    while ((idx = lineBuffers[which].indexOf("\n")) >= 0) {
      const line = lineBuffers[which].slice(0, idx);
      lineBuffers[which] = lineBuffers[which].slice(idx + 1);
      handleLine(which, line);
    }
  };

  const handleLine = (which: "out" | "err", line: string) => {
    if (closed || !line.trim()) return;
    if (which === "err") {
      // 例: traceroute to one.one.one.one (1.0.0.1), 30 hops max, 48 byte packets
      const m = line.match(/^traceroute6? to (\S+) \(([^)]+)\)/);
      if (m) {
        sseSend(res, { type: "start", target: m[1], targetIp: m[2] });
        enrich(m[2]);
      } else {
        sseSend(res, { type: "info", line });
      }
      return;
    }
    // 例: " 8  1.0.0.1  9.153 ms"  /  " 2  *"
    const hm = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!hm) {
      sseSend(res, { type: "info", line });
      return;
    }
    const ttl = Number(hm[1]);
    const rest = hm[2].trim();
    if (rest === "*" || rest === "") {
      sseSend(res, { type: "hop", ttl, ip: null, rtt: null });
      return;
    }
    // IPv6 リンクローカルの %en0 のようなゾーンIDは落として IP として扱う
    const pm = rest.match(/^([0-9a-fA-F.:]+)(?:%[A-Za-z0-9._-]+)?\s+([\d.]+)\s*ms(.*)$/);
    if (pm) {
      const ip = pm[1];
      sseSend(res, { type: "hop", ttl, ip, rtt: Number(pm[2]), note: pm[3].trim() || undefined });
      enrich(ip);
    } else {
      sseSend(res, { type: "info", line });
    }
  };

  child.stdout.on("data", onData("out"));
  child.stderr.on("data", onData("err"));
  child.on("error", (e) => {
    if (!closed) sseSend(res, { type: "error", message: e.message });
  });
  child.on("close", (code) => {
    // geo のマイクロバッチ(300ms)と逆引きが吐き終わるまで少し待ってから閉じる
    setTimeout(() => {
      if (!closed) {
        sseSend(res, { type: "done", code });
        closed = true;
        res.end();
      }
    }, 1500);
  });
  req.on("close", () => {
    closed = true;
    child.kill("SIGTERM");
  });
}

// ---------------------------------------------------------------------------
// 貼り付けモード用: IP リストをまとめてジオロケーション + 逆引き
// ---------------------------------------------------------------------------

async function handleEnrich(req: IncomingMessage, res: ServerResponse) {
  let ips: string[] = [];
  try {
    // 送信中の切断 (aborted) でも reject が漏れて dev サーバごと落ちないように
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (Array.isArray(body.ips)) ips = body.ips.filter((x: unknown) => typeof x === "string");
  } catch {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid body" }));
    }
    return;
  }
  ips = [...new Set(ips)].slice(0, 100);
  const entries = await Promise.all(
    ips.map(async (ip) => {
      const [geo, hostname] = await Promise.all([lookupGeo(ip), lookupRdns(ip)]);
      return [ip, { geo, hostname }] as const;
    }),
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ results: Object.fromEntries(entries) }));
}

// ---------------------------------------------------------------------------
// 発信元 (このマシンのグローバルIP) のジオロケーション
// ---------------------------------------------------------------------------

let selfCache: { at: number; body: string } | null = null;

async function handleSelf(_req: IncomingMessage, res: ServerResponse) {
  if (selfCache && Date.now() - selfCache.at < 10 * 60 * 1000) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(selfCache.body);
    return;
  }
  try {
    const r = await fetch(
      "http://ip-api.com/json?fields=status,message,country,countryCode,city,lat,lon,isp,org,as,query",
    );
    const data = await r.json();
    const body = JSON.stringify(data);
    if (data?.status === "success") selfCache = { at: Date.now(), body };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "fail", message: e instanceof Error ? e.message : String(e) }));
  }
}

// ---------------------------------------------------------------------------
// 海底ケーブルデータ (TeleGeography Submarine Cable Map) のプロキシ
// ブラウザから直接は CORS で取れないため、サーバ側で取得してキャッシュする
// ---------------------------------------------------------------------------

const CABLE_API = "https://www.submarinecablemap.com/api/v3";
const cableCache = new Map<string, { at: number; body: string }>();
const CABLE_TTL_MS = 24 * 60 * 60 * 1000;

async function proxyCableJson(path: string, res: ServerResponse) {
  const cached = cableCache.get(path);
  if (cached && Date.now() - cached.at < CABLE_TTL_MS) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=3600" });
    res.end(cached.body);
    return;
  }
  try {
    const r = await fetch(`${CABLE_API}/${path}`);
    if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
    const body = await r.text();
    cableCache.set(path, { at: Date.now(), body });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=3600" });
    res.end(body);
  } catch (e) {
    // 取得失敗時は期限切れキャッシュがあればそれを返す
    if (cached) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(cached.body);
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}

const CABLE_ID_RE = /^[a-z0-9-]{1,80}$/;

function handleCables(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/api/cables") {
    void proxyCableJson("cable/cable-geo.json", res);
    return true;
  }
  if (path === "/api/cables/landing") {
    void proxyCableJson("landing-point/landing-point-geo.json", res);
    return true;
  }
  const m = path.match(/^\/api\/cables\/([^/]+)$/);
  if (m && CABLE_ID_RE.test(m[1])) {
    void proxyCableJson(`cable/${m[1]}.json`, res);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 陸上ファイバ (Open Fibre Data Standard 公開データ) の集約プロキシ
// 27 ファイル・約22MB あるので、サーバ側で取得→間引き→1つの GeoJSON にまとめ、
// メモリとディスク (node_modules/.cache) にキャッシュする
// ---------------------------------------------------------------------------

const OFDS_REPO = "Open-Telecoms-Data/OFDS-public-data";
const FIBER_CACHE_FILE = path.join(
  process.cwd(),
  "node_modules/.cache/traceroute-globe/terrestrial-fiber.json",
);
const FIBER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let fiberMemory: string | null = null;
let fiberBuilding: Promise<string> | null = null;

type LngLat = [number, number];

/** Douglas–Peucker (反復版)。tol は度 (0.004° ≈ 400m) */
function simplifyLine(coords: LngLat[], tol: number): LngLat[] {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = coords[s];
    const [x2, y2] = coords[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const norm = Math.hypot(dx, dy);
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = coords[i];
      const d =
        norm === 0
          ? Math.hypot(px - x1, py - y1)
          : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1);
}

async function buildTerrestrialFiber(): Promise<string> {
  const treeRes = await fetch(`https://api.github.com/repos/${OFDS_REPO}/git/trees/HEAD?recursive=1`, {
    headers: { "User-Agent": "traceroute-globe" },
  });
  if (!treeRes.ok) throw new Error(`GitHub tree HTTP ${treeRes.status}`);
  const tree = (await treeRes.json()) as { tree: { path: string }[] };
  const files = tree.tree.filter((t) => /ofds-spans.*\.geojson$/i.test(t.path));
  const features: object[] = [];
  const worker = async (file: { path: string }) => {
    const [country, operator] = file.path.split("/");
    const res = await fetch(`https://raw.githubusercontent.com/${OFDS_REPO}/HEAD/${file.path}`);
    if (!res.ok) return;
    const gj = (await res.json()) as { features?: Array<{ properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }> };
    for (const f of gj.features ?? []) {
      const g = f.geometry;
      if (!g) continue;
      let lines: LngLat[][];
      if (g.type === "LineString") lines = [g.coordinates as LngLat[]];
      else if (g.type === "MultiLineString") lines = g.coordinates as LngLat[][];
      else continue;
      const simplified = lines
        .map((line) =>
          simplifyLine(
            line.map((c) => [Math.round(c[0] * 1e4) / 1e4, Math.round(c[1] * 1e4) / 1e4] as LngLat),
            0.004,
          ),
        )
        .filter((line) => line.length >= 2);
      if (simplified.length === 0) continue;
      features.push({
        type: "Feature",
        properties: {
          name: String(f.properties?.name ?? ""),
          operator: operator.replace(/_/g, " "),
          country: country.replace(/_/g, " "),
          source: "OFDS",
        },
        geometry:
          simplified.length === 1
            ? { type: "LineString", coordinates: simplified[0] }
            : { type: "MultiLineString", coordinates: simplified },
      });
    }
  };
  // 4 並列で取得
  const queue = [...files];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          await worker(f);
        } catch (e) {
          console.warn("[fiber] failed:", f.path, e instanceof Error ? e.message : e);
        }
      }
    }),
  );
  const body = JSON.stringify({ type: "FeatureCollection", features });
  try {
    await fs.mkdir(path.dirname(FIBER_CACHE_FILE), { recursive: true });
    await fs.writeFile(FIBER_CACHE_FILE, body);
  } catch {
    /* ディスクキャッシュは任意 */
  }
  return body;
}

async function handleFiber(_req: IncomingMessage, res: ServerResponse) {
  try {
    if (!fiberMemory) {
      try {
        const st = await fs.stat(FIBER_CACHE_FILE);
        if (Date.now() - st.mtimeMs < FIBER_TTL_MS) {
          fiberMemory = await fs.readFile(FIBER_CACHE_FILE, "utf8");
        }
      } catch {
        /* キャッシュ無し */
      }
    }
    if (!fiberMemory) {
      fiberBuilding ??= buildTerrestrialFiber().finally(() => (fiberBuilding = null));
      fiberMemory = await fiberBuilding;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=3600" });
    res.end(fiberMemory);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}

// ---------------------------------------------------------------------------
// 道路ルーティング (OSRM 公開デモ) のプロキシ: 陸上区間の「道路沿い」推定線に使う。
// デモサーバは軽い利用しか想定されていないので、直列 + 間隔を空けて呼ぶ
// ---------------------------------------------------------------------------

const routeCache = new Map<string, string>();
let routeChain: Promise<void> = Promise.resolve();
const ROUTE_MIN_INTERVAL_MS = 400;

function parseLngLat(s: string | null): LngLat | null {
  if (!s) return null;
  const m = s.split(",").map(Number);
  if (m.length !== 2 || !m.every(Number.isFinite)) return null;
  if (Math.abs(m[0]) > 180 || Math.abs(m[1]) > 90) return null;
  return [m[0], m[1]];
}

function handleRoute(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", "http://localhost");
  const from = parseLngLat(url.searchParams.get("from"));
  const to = parseLngLat(url.searchParams.get("to"));
  if (!from || !to) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "from/to must be lng,lat" }));
    return;
  }
  const key = `${from[0].toFixed(3)},${from[1].toFixed(3)}>${to[0].toFixed(3)},${to[1].toFixed(3)}`;
  const cached = routeCache.get(key);
  if (cached) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(cached);
    return;
  }
  routeChain = routeChain.then(async () => {
    try {
      const r = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=simplified&geometries=geojson`,
        {
          headers: { "User-Agent": "traceroute-globe (local dev tool)" },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const j = (await r.json()) as {
        code?: string;
        routes?: Array<{ distance: number; geometry: { coordinates: LngLat[] } }>;
      };
      const route = j.code === "Ok" ? j.routes?.[0] : undefined;
      const body = JSON.stringify(
        route
          ? { code: "Ok", distance: route.distance, coordinates: route.geometry.coordinates }
          : { code: j.code ?? "Error", distance: null, coordinates: null },
      );
      routeCache.set(key, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    await new Promise((r) => setTimeout(r, ROUTE_MIN_INTERVAL_MS));
  });
}

// ---------------------------------------------------------------------------
// Vite プラグイン
// ---------------------------------------------------------------------------

export function tracerouteApi(): Plugin {
  return {
    name: "traceroute-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (path === "/api/trace" && req.method === "GET") return handleTrace(req, res);
        if (path === "/api/enrich" && req.method === "POST") return void handleEnrich(req, res);
        if (path === "/api/self" && req.method === "GET") return void handleSelf(req, res);
        if (req.method === "GET" && handleCables(req, res)) return;
        if (path === "/api/fiber" && req.method === "GET") return void handleFiber(req, res);
        if (path === "/api/route" && req.method === "GET") return handleRoute(req, res);
        next();
      });
    },
  };
}
