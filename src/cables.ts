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
    const score = bestA + bestB + Math.abs(span - legLen) * 0.3;
    out.push({ cable: c, landingA: bestA, landingB: bestB, score });
  }
  out.sort((x, y) => x.score - y.score);
  return out.slice(0, 3);
}
