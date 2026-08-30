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
}

const geoCache = new Map<string, GeoInfo>();

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

// ip-api.com は 45req/分 制限があるので、300ms 窓でまとめて batch API に投げる
let pendingIps = new Map<string, Array<(g: GeoInfo) => void>>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function lookupGeo(ip: string): Promise<GeoInfo> {
  const cached = geoCache.get(ip);
  if (cached) return Promise.resolve(cached);
  if (isPrivateIp(ip)) {
    const g: GeoInfo = { status: "private" };
    geoCache.set(ip, g);
    return Promise.resolve(g);
  }
  return new Promise((resolve) => {
    const list = pendingIps.get(ip) ?? [];
    list.push(resolve);
    pendingIps.set(ip, list);
    if (!batchTimer) batchTimer = setTimeout(flushGeoBatch, 300);
  });
}

async function flushGeoBatch() {
  batchTimer = null;
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
    if (g.status !== "fail") geoCache.set(ip, g);
    for (const r of resolvers) r(g);
  }
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
    const pm = rest.match(/^([0-9a-fA-F.:]+)\s+([\d.]+)\s*ms(.*)$/);
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
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let ips: string[] = [];
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (Array.isArray(body.ips)) ips = body.ips.filter((x: unknown) => typeof x === "string");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid body" }));
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
        next();
      });
    },
  };
}
