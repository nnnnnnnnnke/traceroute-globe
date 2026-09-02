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

export interface Landing {
  id: string;
  name: string; // 例: "Shima, Japan"
  lat: number;
  lng: number;
}

export interface CableInfo {
  id: string;
  name: string;
  color: string;
  label: { lng: number; lat: number };
  /** 着陸点 (landing-point データとの空間結合)。見つからないケーブルはパーツ端点で代用 */
  ends: Landing[];
  landings: Landing[];
  features: CableFeature[];
}

export interface CableCandidate {
  cable: CableInfo;
  landingA: number; // 区間の始点側ホップから最寄り着陸点までの距離 (m)
  landingB: number;
  /** 区間の両端で使うと推定した着陸点 */
  landingNameA: string;
  landingNameB: string;
  score: number;
  /** ケーブル線形に沿った区間長 (m)。線形が辿れない場合は着陸点間の直線距離 */
  pathLen: number;
  /** 線形長から期待される RTT 増分 (ms, 往復 10ms/1000km) */
  expectedMs: number;
  /** 経路が実際に通る部分のケーブル線形 (着陸点→着陸点)。辿れなければ null */
  corePath: LngLat[] | null;
}

export interface CableDetail {
  id: string;
  name: string;
  length?: string;
  rfs?: string;
  owners?: string;
  landing_points?: { name: string; country: string }[];
}

interface LandingCollection {
  type: "FeatureCollection";
  features: Array<{
    properties: { id: string; name: string };
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
}

/** 着陸点をケーブル線の頂点にこの距離以内で結び付ける (データ上はほぼ同一座標) */
const LANDING_SNAP_M = 3_000;

export async function loadCables(): Promise<{ geojson: CableCollection; cables: CableInfo[] }> {
  const [res, lres] = await Promise.all([fetch("/api/cables"), fetch("/api/cables/landing")]);
  if (!res.ok) throw new Error(`cables: HTTP ${res.status}`);
  const geojson = (await res.json()) as CableCollection;
  // 着陸点は無くても動く (パーツ端点で代用) が、リング型ケーブルの着陸点は
  // 線の途中の頂点なので、これが無いと PC-1 のようなケーブルが候補にならない
  const landings: Landing[] = [];
  if (lres.ok) {
    const lgj = (await lres.json()) as LandingCollection;
    for (const f of lgj.features ?? []) {
      landings.push({
        id: f.properties.id,
        name: f.properties.name,
        lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      });
    }
  }
  // 0.05° 格子で着陸点を索引し、各ケーブルの頂点から近い着陸点を集める
  const grid = new Map<string, Landing[]>();
  const gkey = (lng: number, lat: number) => `${Math.round(lng * 20)},${Math.round(lat * 20)}`;
  for (const l of landings) {
    const k = gkey(l.lng, l.lat);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(l);
  }
  const landingsNear = (vertices: LngLat[]): Landing[] => {
    const found = new Map<string, { l: Landing; d: number }>();
    for (const v of vertices) {
      const x = Math.round(v[0] * 20);
      const y = Math.round(v[1] * 20);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const l of grid.get(`${x + dx},${y + dy}`) ?? []) {
            const d = haversine(v[1], v[0], l.lat, l.lng);
            if (d > LANDING_SNAP_M) continue;
            const prev = found.get(l.id);
            if (!prev || d < prev.d) found.set(l.id, { l, d });
          }
        }
      }
    }
    return [...found.values()].map((x) => x.l);
  };

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
        landings: [],
        features: [],
      };
      byId.set(p.id, c);
    }
    c.features.push(f);
  }
  for (const c of byId.values()) {
    const vertices = c.features.flatMap((f) => f.geometry.coordinates.flat());
    c.landings = landingsNear(vertices);
    if (c.landings.length > 0) {
      c.ends = c.landings;
    } else {
      for (const f of c.features) {
        for (const part of f.geometry.coordinates) {
          if (part.length === 0) continue;
          const s = part[0];
          const e = part[part.length - 1];
          c.ends.push(
            { id: `${c.id}:s`, name: c.name, lng: s[0], lat: s[1] },
            { id: `${c.id}:e`, name: c.name, lng: e[0], lat: e[1] },
          );
        }
      }
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

/** 座標を約1km格子のキーにする。±180° は同じ節点とみなす (日付変更線で分割されたパーツを繋ぐ) */
function gridKey(lng: number, lat: number): string {
  let x = Math.round(lng * 100);
  if (x <= -18000) x = 18000;
  return `${x},${Math.round(lat * 100)}`;
}

function cableGraph(cable: CableInfo): CableGraph {
  const cached = graphCache.get(cable);
  if (cached) return cached;
  const nodes: CableGraph["nodes"] = [];
  const edges: CableGraph["edges"] = [];
  const adj = new Map<number, number[]>();
  const index = new Map<string, number>();

  // 節点は格子キー + 隣接 8 セル (≈1〜2km) で同一視する。分岐ケーブルの端点が
  // 幹線の途中の頂点にわずかにずれて接続している (T 字) ケースを吸収するため
  const lookup = (lng: number, lat: number): number | undefined => {
    const x = Math.round(lng * 100);
    const y = Math.round(lat * 100);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const i = index.get(gridKey((x + dx) / 100, (y + dy) / 100));
        if (i !== undefined) return i;
      }
    }
    return undefined;
  };
  const nodeFor = (c: LngLat) => {
    let i = lookup(c[0], c[1]);
    if (i === undefined) {
      i = nodes.length;
      nodes.push({ lng: c[0], lat: c[1] });
    }
    index.set(gridKey(c[0], c[1]), i);
    return i;
  };

  const parts: LngLat[][] = [];
  for (const f of cable.features) {
    for (const part of f.geometry.coordinates) {
      if (part.length >= 2) parts.push(part);
    }
  }
  // 着陸点を、ケーブル線上の最寄り頂点にスナップして節点登録する。リング型の
  // ケーブル (PC-1 など) は着陸点が線の途中にあり、ここで登録しないと分割されない
  for (const l of cable.landings) {
    let bestV: LngLat | null = null;
    let bestD = LANDING_SNAP_M;
    for (const part of parts) {
      for (const v of part) {
        const d = haversine(l.lat, l.lng, v[1], v[0]);
        if (d < bestD) {
          bestD = d;
          bestV = v;
        }
      }
    }
    if (bestV) nodeFor(bestV);
  }
  // 全パーツの端点も節点として登録
  for (const part of parts) {
    nodeFor(part[0]);
    nodeFor(part[part.length - 1]);
  }
  // 幹線の途中に他パーツの端点が乗っていれば、そこでパーツを分割してエッジ化
  const addEdge = (coords: LngLat[]) => {
    if (coords.length < 2) return;
    const a = nodeFor(coords[0]);
    const b = nodeFor(coords[coords.length - 1]);
    if (a === b && coords.length < 3) return;
    let len = 0;
    for (let i = 1; i < coords.length; i++) {
      len += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    const idx = edges.length;
    edges.push({ a, b, coords, len });
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(idx);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(idx);
  };
  for (const part of parts) {
    let start = 0;
    for (let i = 1; i < part.length - 1; i++) {
      if (lookup(part[i][0], part[i][1]) !== undefined) {
        addEdge(part.slice(start, i + 1));
        start = i;
      }
    }
    addEdge(part.slice(start));
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
  // 同一国内の区間は陸上伝送とみなす (シアトル→LA のような長い国内区間が
  // 太平洋ケーブルに吸い寄せられるのを防ぐ。本土〜離島は今後の課題)
  if (a.countryCode && a.countryCode === b.countryCode) return [];

  const out: CableCandidate[] = [];
  for (const c of cables) {
    let bestA = Infinity;
    let bestB = Infinity;
    let endA: Landing | null = null;
    let endB: Landing | null = null;
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
    let path = cablePath(c, a, b);
    // ケーブルのグラフ最短路が別の分岐を大回りする (直線の 1.6 倍超) なら、
    // その線形は「この区間の経路」ではないので使わない
    if (path && pathLength(path) > legLen * 1.6) path = null;
    const pathLen = (path ? pathLength(path) : span) + bestA + bestB;
    // 光ファイバの往復 ≈ 10ms / 1000km
    const expectedMs = pathLen / 100_000;
    let score = bestA + bestB + Math.abs(span - legLen) * 0.3;
    // RTT 差が測れていれば「線形長から期待される増分」との差を加える。ただし RTT は
    // キューイングや非対称経路で ±20ms は普通に揺れるので、10ms の余裕を引いた上で
    // 1ms ≈ 30km の弱い重みにとどめる (着陸点の近さのほうが強い根拠)
    if (rttDeltaMs != null && rttDeltaMs > 0) {
      score += Math.max(0, Math.abs(rttDeltaMs - expectedMs) - 10) * 30_000;
    }
    out.push({
      cable: c,
      landingA: bestA,
      landingB: bestB,
      landingNameA: endA.name,
      landingNameB: endB.name,
      score,
      pathLen,
      expectedMs,
      corePath: path,
    });
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
