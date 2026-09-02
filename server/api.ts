import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
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
      const contributions = (loc.contributions ?? {}) as Record<string, unknown>;
      const engines = Object.keys(contributions);
      const r: IpmapLocation = {
        lat: loc.latitude,
        lon: loc.longitude as number,
        city: (loc.cityName as string) || undefined,
        country: (loc.countryName as string) || undefined,
        countryCode: (loc.countryCodeAlpha2 as string) || undefined,
        score: Number(loc.score ?? j.score ?? 0),
        engines,
        strong: engines.some((e) => e !== "worlds") || Boolean(j.geofeed),
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
  let g: GeoInfo;
  if (ipmap && (ipmap.strong || base.status !== "ok")) {
    g = {
      ...base,
      status: "ok",
      message: undefined,
      lat: ipmap.lat,
      lon: ipmap.lon,
      city: ipmap.city ?? base.city,
      country: ipmap.country ?? base.country,
      countryCode: ipmap.countryCode ?? base.countryCode,
      source: "ipmap",
      geoScore: ipmap.score,
      geoEngines: ipmap.engines,
    };
  } else if (base.status === "ok") {
    g = { ...base, source: "ip-api" };
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
  const m = path.match(/^\/api\/cables\/([^/]+)$/);
  if (m && CABLE_ID_RE.test(m[1])) {
    void proxyCableJson(`cable/${m[1]}.json`, res);
    return true;
  }
  return false;
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
        next();
      });
    },
  };
}
