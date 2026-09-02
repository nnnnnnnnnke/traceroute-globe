import { haversine } from "./globe";

/** TeleGeography cable-geo.json の1フィーチャ (ケーブル1本が複数フィーチャに分かれることもある) */
export interface CableFeature {
  type: "Feature";
  properties: {
    id: string; // 例: "jupiter"
    name: string; // 例: "JUPITER"
    color: string;
    feature_id: string; // 例: "jupiter-0"
    coordinates: [number, number]; // ラベル位置 [lng, lat]
  };
  geometry: { type: "MultiLineString"; coordinates: [number, number][][] };
}

export interface CableCollection {
  type: "FeatureCollection";
  features: CableFeature[];
}

export interface CableInfo {
  id: string;
  name: string;
  color: string;
  label: { lng: number; lat: number };
  /** 各ラインパーツの始点・終点 (= 着陸点かブランチ点) */
  ends: { lat: number; lng: number }[];
  features: CableFeature[];
}

export interface CableCandidate {
  cable: CableInfo;
  landingA: number; // 区間の始点側ホップから最寄り着陸点までの距離 (m)
  landingB: number;
  score: number;
  /** ケーブル線形に沿った区間長 (m)。線形が辿れない場合は着陸点間の直線距離 */
  pathLen: number;
  /** 線形長から期待される RTT 増分 (ms, 往復 10ms/1000km) */
  expectedMs: number;
}

export interface CableDetail {
  id: string;
  name: string;
  length?: string;
  rfs?: string;
  owners?: string;
  landing_points?: { name: string; country: string }[];
}

export async function loadCables(): Promise<{ geojson: CableCollection; cables: CableInfo[] }> {
  const res = await fetch("/api/cables");
  if (!res.ok) throw new Error(`cables: HTTP ${res.status}`);
  const geojson = (await res.json()) as CableCollection;
  const byId = new Map<string, CableInfo>();
  for (const f of geojson.features) {
    const p = f.properties;
    let c = byId.get(p.id);
    if (!c) {
      c = {
        id: p.id,
        name: p.name,
        color: p.color,
        label: { lng: p.coordinates[0], lat: p.coordinates[1] },
        ends: [],
        features: [],
      };
      byId.set(p.id, c);
    }
    c.features.push(f);
    for (const part of f.geometry.coordinates) {
      if (part.length === 0) continue;
      const s = part[0];
      const e = part[part.length - 1];
      c.ends.push({ lng: s[0], lat: s[1] }, { lng: e[0], lat: e[1] });
    }
  }
  return { geojson, cables: [...byId.values()] };
}

export async function fetchCableDetail(id: string): Promise<CableDetail> {
  const res = await fetch(`/api/cables/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`cable detail: HTTP ${res.status}`);
  return (await res.json()) as CableDetail;
}

// ---------------------------------------------------------------------------
// ケーブル線形に沿った経路: ケーブルのパーツ (LineString) を端点でつないだ
// グラフとみなし、区間の両端に最も近い端点同士を最短経路で結ぶ
// ---------------------------------------------------------------------------

type LngLat = [number, number];

interface CableGraph {
  nodes: { lat: number; lng: number }[];
  edges: { a: number; b: number; coords: LngLat[]; len: number }[];
  adj: Map<number, number[]>;
}

const graphCache = new WeakMap<CableInfo, CableGraph>();

function cableGraph(cable: CableInfo): CableGraph {
  const cached = graphCache.get(cable);
  if (cached) return cached;
  const nodes: CableGraph["nodes"] = [];
  const edges: CableGraph["edges"] = [];
  const adj = new Map<number, number[]>();
  const index = new Map<string, number>();
  // 端点は約1kmで丸めて同一視する (分岐点で共有される座標のわずかな差を吸収)
  const nodeFor = (c: LngLat) => {
    const key = `${c[0].toFixed(2)},${c[1].toFixed(2)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = nodes.length;
      nodes.push({ lng: c[0], lat: c[1] });
      index.set(key, i);
    }
    return i;
  };
  for (const f of cable.features) {
    for (const part of f.geometry.coordinates) {
      if (part.length < 2) continue;
      const a = nodeFor(part[0]);
      const b = nodeFor(part[part.length - 1]);
      let len = 0;
      for (let i = 1; i < part.length; i++) {
        len += haversine(part[i - 1][1], part[i - 1][0], part[i][1], part[i][0]);
      }
      const idx = edges.length;
      edges.push({ a, b, coords: part, len });
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(idx);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(idx);
    }
  }
  const g = { nodes, edges, adj };
  graphCache.set(cable, g);
  return g;
}

/**
 * ケーブル上で、from に最も近い端点から to に最も近い端点までの線形を返す。
 * つながっていない (別系統のパーツ) 場合は null。
 */
export function cablePath(
  cable: CableInfo,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): LngLat[] | null {
  const g = cableGraph(cable);
  if (g.nodes.length < 2) return null;
  let sA = -1;
  let sB = -1;
  let dA = Infinity;
  let dB = Infinity;
  g.nodes.forEach((n, i) => {
    const da = haversine(from.lat, from.lng, n.lat, n.lng);
    if (da < dA) {
      dA = da;
      sA = i;
    }
    const db = haversine(to.lat, to.lng, n.lat, n.lng);
    if (db < dB) {
      dB = db;
      sB = i;
    }
  });
  if (sA < 0 || sB < 0 || sA === sB) return null;

  // Dijkstra (ノード数は多くても数百なので単純実装で十分)
  const dist = new Array<number>(g.nodes.length).fill(Infinity);
  const prevEdge = new Array<number>(g.nodes.length).fill(-1);
  const done = new Array<boolean>(g.nodes.length).fill(false);
  dist[sA] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < dist.length; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0 || u === sB) break;
    done[u] = true;
    for (const ei of g.adj.get(u) ?? []) {
      const e = g.edges[ei];
      const v = e.a === u ? e.b : e.a;
      if (dist[u] + e.len < dist[v]) {
        dist[v] = dist[u] + e.len;
        prevEdge[v] = ei;
      }
    }
  }
  if (!Number.isFinite(dist[sB])) return null;

  // 逆順にエッジを辿り、向きを揃えて座標列を連結
  const chain: number[] = [];
  for (let v = sB; v !== sA; ) {
    const ei = prevEdge[v];
    if (ei < 0) return null;
    chain.push(ei);
    const e = g.edges[ei];
    v = e.a === v ? e.b : e.a;
  }
  chain.reverse();
  const out: LngLat[] = [];
  let cur = sA;
  for (const ei of chain) {
    const e = g.edges[ei];
    const coords = e.a === cur ? e.coords : [...e.coords].reverse();
    for (let i = out.length === 0 ? 0 : 1; i < coords.length; i++) out.push(coords[i]);
    cur = e.a === cur ? e.b : e.a;
  }
  return out.length >= 2 ? out : null;
}

/** ホップの位置から着陸点までこの距離以内なら「その近くで陸揚げ」とみなす */
const LANDING_RADIUS_M = 350_000;
/** これより短い区間は海底ケーブル推定の対象外 (都市間の陸上伝送とみなす) */
const MIN_LEG_M = 600_000;

/**
 * 区間 a→b が通っている可能性の高い海底ケーブルを推定する。
 * traceroute からは物理経路は分からないので、「両端のホップの近くに着陸点を持ち、
 * その着陸点同士が区間と同程度に離れているケーブル」を候補として距離で順位付けする。
 */
export function inferCables(
  a: { lat: number; lng: number; countryCode?: string },
  b: { lat: number; lng: number; countryCode?: string },
  cables: CableInfo[],
  /** 区間の両端ホップの RTT 差 (ms)。あれば線形長との整合で順位付けに使う */
  rttDeltaMs?: number | null,
): CableCandidate[] {
  const legLen = haversine(a.lat, a.lng, b.lat, b.lng);
  if (legLen < MIN_LEG_M) return [];
  // 同一国内の区間は 1,500km 未満なら陸上伝送とみなす (本土〜離島などは対象に残す)
  if (a.countryCode && a.countryCode === b.countryCode && legLen < 1_500_000) return [];

  const out: CableCandidate[] = [];
  for (const c of cables) {
    let bestA = Infinity;
    let bestB = Infinity;
    let endA: { lat: number; lng: number } | null = null;
    let endB: { lat: number; lng: number } | null = null;
    for (const e of c.ends) {
      const da = haversine(a.lat, a.lng, e.lat, e.lng);
      if (da < bestA) {
        bestA = da;
        endA = e;
      }
      const db = haversine(b.lat, b.lng, e.lat, e.lng);
      if (db < bestB) {
        bestB = db;
        endB = e;
      }
    }
    if (!endA || !endB || bestA > LANDING_RADIUS_M || bestB > LANDING_RADIUS_M) continue;
    // 片側にしか着陸していない (同じ岸の2点が近いだけ) ケーブルを除外
    const span = haversine(endA.lat, endA.lng, endB.lat, endB.lng);
    if (span < legLen * 0.4) continue;
    // 線形が辿れればその長さ、無理なら着陸点間の直線 + 陸上スタブ
    const path = cablePath(c, a, b);
    const pathLen = (path ? pathLength(path) : span) + bestA + bestB;
    // 光ファイバの往復 ≈ 10ms / 1000km
    const expectedMs = pathLen / 100_000;
    let score = bestA + bestB + Math.abs(span - legLen) * 0.3;
    // RTT 差が測れていれば「線形長から期待される増分」との差を距離換算 (1ms ≈ 100km) で加える
    if (rttDeltaMs != null && rttDeltaMs > 0) {
      score += Math.abs(rttDeltaMs - expectedMs) * 100_000;
    }
    out.push({ cable: c, landingA: bestA, landingB: bestB, score, pathLen, expectedMs });
  }
  out.sort((x, y) => x.score - y.score);
  return out.slice(0, 3);
}

function pathLength(coords: LngLat[]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return len;
}
