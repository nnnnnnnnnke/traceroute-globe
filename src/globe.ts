import ThreeView, { Color, vector3ToGeodetic } from "@navaramap/three";
import type {
  CylinderMeshDesc,
  GlowGlobeMeshDesc,
  SelectiveBloomEffectDesc,
} from "@navaramap/three-default-descs";
import { Vector3 } from "three";
import {
  DefaultPlugin,
  type DefaultDescriptions,
} from "@navaramap/three-default-plugin";
import {
  OverlayPlugin,
  TileJsonPlugin,
  moveOverlayElement,
} from "@navaramap/three-plugins";

import type { GeoInfo, Hop } from "./types";

const EARTH_R = 6_371_000; // m

// ---------------------------------------------------------------------------
// 経路チェーン (地理位置が分かったホップを地点単位にまとめたもの)
// ---------------------------------------------------------------------------

export interface ChainNode {
  key: string;
  lat: number;
  lng: number;
  hops: Hop[];
  isOrigin: boolean;
  isDest: boolean;
  city?: string;
  country?: string;
  countryCode?: string;
}

export interface OriginInfo {
  geo: GeoInfo;
  label: string; // 例: "発信元 (OCN)"
}

/** 地球儀に重ねる1本の経路 */
export interface ChainLayer {
  id: string;
  slot: number; // TRACE_COLORS のインデックス
  nodes: ChainNode[];
  /** 区間 (`${a.key}>${b.key}`) ごとの線形の上書き。海底ケーブルの実際の
   *  敷設ルートに沿わせるときに使う。無い区間は大円で描く */
  legPaths?: Map<string, [number, number][]>;
}

export function haversine(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** ホップ列を「近接地点ごとのノード列」へ畳み込む (5km未満は同一地点扱い) */
export function buildChain(
  hops: Hop[],
  origin: OriginInfo | null,
  targetIp: string | undefined,
): ChainNode[] {
  const nodes: ChainNode[] = [];
  if (origin?.geo.status === "ok" && origin.geo.lat != null && origin.geo.lon != null) {
    nodes.push({
      key: "origin",
      lat: origin.geo.lat,
      lng: origin.geo.lon,
      hops: [],
      isOrigin: true,
      isDest: false,
      city: origin.geo.city,
      country: origin.geo.country,
      countryCode: origin.geo.countryCode,
    });
  }
  for (const hop of hops) {
    const g = hop.geo;
    if (!g || g.status !== "ok" || g.lat == null || g.lon == null) continue;
    const last = nodes[nodes.length - 1];
    if (last && haversine(last.lat, last.lng, g.lat, g.lon) < 5_000) {
      last.hops.push(hop);
      if (last.isOrigin && !last.city) {
        last.city = g.city;
        last.country = g.country;
        last.countryCode = g.countryCode;
      }
      if (targetIp && hop.ip === targetIp) last.isDest = true;
      continue;
    }
    nodes.push({
      key: `${g.lat.toFixed(3)},${g.lon.toFixed(3)}`,
      lat: g.lat,
      lng: g.lon,
      hops: [hop],
      isOrigin: false,
      isDest: targetIp != null && hop.ip === targetIp,
      city: g.city,
      country: g.country,
      countryCode: g.countryCode,
    });
  }
  return nodes;
}

/** チェーンの測地距離合計 (m)。判明している地点間のみなので実経路の下限 */
export function chainDistance(nodes: ChainNode[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < nodes.length; i++) {
    sum += haversine(nodes[i].lat, nodes[i].lng, nodes[i + 1].lat, nodes[i + 1].lng);
  }
  return sum;
}

/** ノード間のTTLが連続していなければ「位置不明ホップを跨いだ区間」= 破線 */
function isGapLeg(from: ChainNode, to: ChainNode): boolean {
  const a = from.hops[from.hops.length - 1]?.ttl;
  const b = to.hops[0]?.ttl;
  if (a == null || b == null) return true; // origin など
  return b - a > 1;
}

export function nodeLabel(node: ChainNode): string {
  if (node.isOrigin && node.hops.length === 0) return "発信元";
  const first = node.hops[0]?.ttl;
  const last = node.hops[node.hops.length - 1]?.ttl;
  const range = first === last ? `${first}` : `${first}–${last}`;
  const place = node.city || node.country || node.hops[0]?.ip || "?";
  return `${range} ${place}`;
}

/** 大円に沿って2点間をサンプリングした [lng, lat] 列 (地表トラック描画用) */
export function greatCirclePoints(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  lenMeters: number,
  samples?: number,
): [number, number][] {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const toVec = (lat: number, lng: number): [number, number, number] => [
    Math.cos(lat * rad) * Math.cos(lng * rad),
    Math.cos(lat * rad) * Math.sin(lng * rad),
    Math.sin(lat * rad),
  ];
  const va = toVec(a.lat, a.lng);
  const vb = toVec(b.lat, b.lng);
  const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const n = samples ?? Math.min(128, Math.max(2, Math.round(lenMeters / 50_000)));
  const points: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let x: number, y: number, z: number;
    if (omega < 1e-9) {
      [x, y, z] = va;
    } else {
      const s = Math.sin(omega);
      const w1 = Math.sin((1 - t) * omega) / s;
      const w2 = Math.sin(t * omega) / s;
      x = w1 * va[0] + w2 * vb[0];
      y = w1 * va[1] + w2 * vb[1];
      z = w1 * va[2] + w2 * vb[2];
    }
    points.push([Math.atan2(y, x) * deg, Math.asin(z / Math.hypot(x, y, z)) * deg]);
  }
  return points;
}

/** 折れ線を距離 step ごとに再サンプリングする (等間隔の点列にしてダッシュ化しやすくする) */
function resamplePolyline(coords: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [coords[0]];
  let cum = 0;
  let nextAt = step;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const segLen = haversine(a[1], a[0], b[1], b[0]);
    while (segLen > 0 && nextAt <= cum + segLen) {
      const t = (nextAt - cum) / segLen;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      nextAt += step;
    }
    cum += segLen;
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/** 等間隔の点列を、区間長に応じたダッシュ/ギャップで線分列に分割する */
function chunkDashes(
  pts: [number, number][],
  step: number,
  lenMeters: number,
): [number, number][][] {
  const dash = Math.min(Math.max(lenMeters / 25, 20_000), 120_000);
  const gap = dash / 2;
  const parts: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (let i = 0; i < pts.length; i++) {
    const on = (i * step) % (dash + gap) < dash;
    if (on) {
      (cur ??= []).push(pts[i]);
    } else if (cur) {
      if (cur.length >= 2) parts.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) parts.push(cur);
  return parts;
}

function dashStepFor(lenMeters: number): number {
  const dash = Math.min(Math.max(lenMeters / 25, 20_000), 120_000);
  return Math.max(2_000, Math.min(dash / 4, 10_000));
}

/** 破線風の地表トラック: 大円を細かくサンプリングし、ダッシュ部分だけを線分列にする */
function dashedTrackParts(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  lenMeters: number,
): [number, number][][] {
  const step = dashStepFor(lenMeters);
  const n = Math.min(4_000, Math.ceil(lenMeters / step));
  return chunkDashes(greatCirclePoints(a, b, lenMeters, n), lenMeters / n, lenMeters);
}

/** 任意の折れ線 (ケーブル線形など) に沿った破線風トラック */
function dashedAlongPath(path: [number, number][], lenMeters: number): [number, number][][] {
  const step = dashStepFor(lenMeters);
  return chunkDashes(resamplePolyline(path, step), step, lenMeters);
}

/** 折れ線の長さ (m) */
export function pathLength(coords: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return len;
}

export function flagEmoji(countryCode?: string): string {
  if (!countryCode || !/^[A-Z]{2}$/i.test(countryCode)) return "";
  return String.fromCodePoint(
    ...[...countryCode.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// ---------------------------------------------------------------------------
// トレースの色スロット (最大4本を同時表示)
// ---------------------------------------------------------------------------

export const TRACE_COLORS = [
  { name: "cyan", ui: "#38bdf8", arcSrc: "#8be2ff", arcTgt: "#0091ff", point: "#c9ecff", dest: "#4fd6ff" },
  { name: "orange", ui: "#fb923c", arcSrc: "#ffd9a8", arcTgt: "#ff8c1a", point: "#ffe3bf", dest: "#ffb054" },
  { name: "violet", ui: "#a78bfa", arcSrc: "#ddd1ff", arcTgt: "#8b5cf6", point: "#e6ddff", dest: "#b18cff" },
  { name: "green", ui: "#34d399", arcSrc: "#b8f5d9", arcTgt: "#10b981", point: "#ccf7e4", dest: "#4ade80" },
] as const;

export const MAX_TRACES = TRACE_COLORS.length;

// ---------------------------------------------------------------------------
// Globe 本体
// ---------------------------------------------------------------------------

interface SourceHandle {
  update(u: object): void;
}

interface LayerHandle {
  id: string;
  update(u: object): void;
}

const CABLE_COLOR = "#2b5f8a";
const CABLE_HI_COLOR = "#7ff3e6";

export class Globe {
  private view!: ThreeView<DefaultDescriptions>;
  private overlay!: OverlayPlugin;
  private bloomId!: string;
  private trackShapeKey = "";
  private waySources: SourceHandle[] = [];
  private destSources: SourceHandle[] = [];
  private trackSources: SourceHandle[] = [];
  private gapSources: SourceHandle[] = [];
  private cableSource: SourceHandle | null = null;
  private cableLayer: LayerHandle | null = null;
  private cableHiSource: SourceHandle | null = null;
  private cablesVisible = true;
  private cableChip: HTMLElement | null = null;
  private cableChipPos: { lat: number; lng: number } | null = null;
  private pickedCable: { id: string; name: string } | null = null;
  private onCableClick: ((id: string, name: string) => void) | null = null;
  private chipPositions: { id: string; lng: number; lat: number; alt: number }[] = [];
  private chipRoot!: HTMLElement;
  private chips = new Map<string, HTMLElement>();
  private chains: ChainLayer[] = [];
  private onNodeClick: ((node: ChainNode) => void) | null = null;
  private ready = false;
  private pendingChains: ChainLayer[] | null = null;

  async init(container: HTMLElement, chipRoot: HTMLElement): Promise<void> {
    this.chipRoot = chipRoot;
    // 非表示タブ等で viewport が 0×0 のまま初期化すると ThreeView が throw するため、
    // コンテナが実サイズを持つまで待つ
    await waitForSize(container);
    const view = new ThreeView<DefaultDescriptions>({ container });
    this.view = view;

    const defaultPlugin = new DefaultPlugin();
    view.addPlugin(defaultPlugin);
    const tilejson = new TileJsonPlugin();
    view.addPlugin(tilejson);
    this.overlay = new OverlayPlugin({ maxDistance: 30_000_000 });
    view.addPlugin(this.overlay);

    await view.init();
    view.animation = true;

    view.setCamera({
      lng: 139.7,
      lat: 35.6,
      height: 9_000_000,
      heading: 0,
      pitch: -90,
      roll: 0,
    });

    // タイルの無い領域 (Black Marble は ±85° まで。極冠など) が明るい既定色で
    // 出ないように、地球のベース色を夜景に合わせた暗色にする
    view.globe.color = new Color().setStyle("#050a12");

    // 夜の地球 (NASA Black Marble) + 大気のフレネルグロー
    const basemap = await tilejson.addSource({
      type: "raster-tile",
      url: "https://papers.reearth.land/blackmarble/tilejson.json",
    });
    view.addLayer({ type: "raster", source: basemap });

    // 近距離用の詳細ダークマップ (OSMベース, maxzoom 22)。Black Marble は
    // maxzoom 8 (約500m/px) しかないため、高度に応じてこちらへクロスフェード
    const detailSource = await tilejson.addSource({
      type: "raster-tile",
      url: "https://papers.reearth.land/styles/papers-dark/tilejson.json",
    });
    const detailLayer = view.addLayer({
      type: "raster",
      source: detailSource,
      raster: { opacity: 0 },
    });

    const glow = view.addMesh<GlowGlobeMeshDesc>({
      glowGlobe: {
        radiusScale: 1.08,
        coefficient: 0.35,
        exponent: 6,
        glowColor: new Color().setHex(0x4aa8ff),
        opacity: 0.9,
      },
    });

    // 高度連動: 下がるほど詳細マップを濃く、大気グローを薄く
    const DETAIL_FULL = 250_000; // これ以下で詳細マップ100%
    const DETAIL_START = 1_400_000; // これ以上で Black Marble のみ
    let lastDetailOp = -1;
    let lastGlowOp = -1;
    const applyLod = () => {
      let h: number;
      try {
        // カメラの WASM コアは view.init() 直後はまだ未接続のことがあり、
        // その間 positionGeographic は throw する (次の move イベントで再試行)
        h = this.view.camera.positionGeographic.height;
      } catch {
        return;
      }
      const t = Math.min(1, Math.max(0, (DETAIL_START - h) / (DETAIL_START - DETAIL_FULL)));
      const detailOp = Math.round(t * 20) / 20;
      if (detailOp !== lastDetailOp) {
        lastDetailOp = detailOp;
        detailLayer.update({
          type: "raster",
          source: detailSource,
          raster: { opacity: detailOp },
        });
      }
      const glowOp = Math.round((0.9 - t * 0.75) * 20) / 20;
      if (glowOp !== lastGlowOp) {
        lastGlowOp = glowOp;
        glow.update({ glowGlobe: { opacity: glowOp } });
      }
    };
    view.camera.on("move", applyLod);
    applyLod();

    // メルカトルタイルは ±85.05° まで。極に開いた穴からグロー殻 (高度約510km)
    // の内側が見えてしまう。薄い円盤だと斜めからの視線が上を通り抜けるため、
    // グロー殻の高さまで届く暗い「栓」で塞ぐ
    for (const lat of [90, -90]) {
      view.addMesh<CylinderMeshDesc>({
        geodetic: { lat, lng: 0, height: 250_000 },
        cylinders: {
          radiusTop: 1,
          radiusBottom: 1,
          radialSegments: 48,
          // Black Marble の北極域の色調に寄せて悪目立ちしないように
          color: new Color().setStyle("#101827"),
          children: [{ radius: 650_000, height: 530_000 }],
        },
      });
    }

    const bloom = view.addEffect<SelectiveBloomEffectDesc>({
      selectiveBloom: { strength: 1.0, radius: 0.5, threshold: 0 },
    });
    this.bloomId = bloom.id;

    // 海底ケーブル (TeleGeography)。経路より下に描くため先に追加する。
    // 全体は控えめな色、推定で経路が通る候補は別レイヤーで発光させる
    const cableSource = view.addSource({ type: "geojson", data: emptyLineFC(), tiled: true });
    this.cableSource = cableSource;
    this.cableLayer = view.addLayer({
      type: "vector",
      source: cableSource,
      polyline: { color: new Color().setStyle(CABLE_COLOR), width: 1, clampToGround: true },
    });
    const cableHiSource = view.addSource({ type: "geojson", data: emptyLineFC() });
    this.cableHiSource = cableHiSource;
    view.addLayer({
      type: "vector",
      source: cableHiSource,
      polyline: {
        color: new Color().setStyle(CABLE_HI_COLOR),
        width: 2.5,
        clampToGround: true,
        effectIds: [this.bloomId],
      },
    });

    // 色スロットごとの経路線 + ホップ地点ポイント (経由地 + 宛先)。
    // 線はタイルと同じ描画パイプラインを通る clampToGround のポリラインなので、
    // どのズームでも地点と正確に繋がる (ワールド座標のアークは近距離でずれる)
    for (const c of TRACE_COLORS) {
      const track = view.addSource({ type: "geojson", data: emptyLineFC() });
      view.addLayer({
        type: "vector",
        source: track,
        polyline: {
          color: new Color().setStyle(c.arcTgt),
          width: 2.4,
          clampToGround: true,
          effectIds: [this.bloomId],
        },
      });
      this.trackSources.push(track);
      // 位置不明ホップを跨ぐ区間: 破線風 (ダッシュごとの線分列)、細く控えめに
      const gap = view.addSource({ type: "geojson", data: emptyLineFC() });
      view.addLayer({
        type: "vector",
        source: gap,
        polyline: {
          color: new Color().setStyle(c.arcSrc),
          width: 1.5,
          clampToGround: true,
        },
      });
      this.gapSources.push(gap);

      const way = view.addSource({ type: "geojson", data: emptyFC() });
      view.addLayer({
        type: "vector",
        source: way,
        point: {
          color: new Color().setStyle(c.point),
          size: 9,
          sizeInMeters: false,
          declutter: false,
          clampToGround: true,
          offsetDepth: true,
          effectIds: [this.bloomId],
          emissiveIntensity: 0.35,
        },
      });
      this.waySources.push(way);
      const dest = view.addSource({ type: "geojson", data: emptyFC() });
      view.addLayer({
        type: "vector",
        source: dest,
        point: {
          color: new Color().setStyle(c.dest),
          size: 13,
          sizeInMeters: false,
          declutter: false,
          clampToGround: true,
          offsetDepth: true,
          effectIds: [this.bloomId],
          emissiveIntensity: 0.55,
        },
      });
      this.destSources.push(dest);
    }

    // 海底ケーブルのクリック: featureClick で拾ったフィーチャを、続く click で
    // 座標付きで確定する (ドラッグ終わりのクリックは無視)
    view.on("featureClick", (info) => {
      this.pickedCable =
        info && info.layerId === this.cableLayer?.id && info.properties
          ? { id: String(info.properties.id), name: String(info.properties.name) }
          : null;
    });
    let downX = 0;
    let downY = 0;
    view.on("mousedown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    view.on("click", (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
      const picked = this.pickedCable;
      this.pickedCable = null;
      if (!picked) {
        this.hideCableChip();
        return;
      }
      const { lat, lng } = vector3ToGeodetic(new Vector3(e.map.x, e.map.y, e.map.z));
      this.showCableChip(`🌊 ${picked.name}`, { lat, lng });
      this.onCableClick?.(picked.id, picked.name);
    });

    // DOMチップの毎フレーム再配置 (地平線の裏に回った地点は隠す)
    this.overlay.onUpdate(({ projected }) => {
      let camH: number;
      try {
        camH = this.view.camera.positionGeographic.height;
      } catch {
        return; // カメラコア未接続の間はスキップ
      }
      const horizon = Math.sqrt((EARTH_R + camH) ** 2 - EARTH_R ** 2) * 1.01;
      for (const [id, el] of this.chips) {
        const pos = projected.get(id);
        if (pos && pos.distance < horizon) {
          el.style.display = "";
          el.style.opacity = String(Math.min(1, Math.max(0.35, 1.6 - pos.distance / 12_000_000)));
          moveOverlayElement(el, pos.x, pos.y);
        } else {
          el.style.display = "none";
        }
      }
      if (this.cableChip) {
        const pos = projected.get("cable-pick");
        if (pos && pos.distance < horizon) {
          this.cableChip.style.display = "";
          moveOverlayElement(this.cableChip, pos.x, pos.y);
        } else {
          this.cableChip.style.display = "none";
        }
      }
    });

    view.attribution?.add([
      {
        attributionHtml: `IP Geolocation by <a href="https://ip-api.com">ip-api.com</a>`,
      },
      {
        attributionHtml: `Submarine cables © <a href="https://www.submarinecablemap.com/">TeleGeography</a>`,
      },
    ]);

    // 初期化前に届いていた経路を反映
    this.ready = true;
    if (this.pendingChains) {
      const pending = this.pendingChains;
      this.pendingChains = null;
      this.setChains(pending);
    }
  }

  setNodeClickHandler(fn: (node: ChainNode) => void): void {
    this.onNodeClick = fn;
  }

  /** 表示する経路の集合をまとめて反映 (差分は内部で処理) */
  setChains(chains: ChainLayer[]): void {
    this.chains = chains;
    if (!this.ready) {
      // init 完了前 (初期化には数秒かかる) は反映を保留する
      this.pendingChains = chains;
      return;
    }

    // --- 経路線 (地表トラック、スロット別。実線 / 破線風で分ける) ---
    interface Leg {
      a: ChainNode;
      b: ChainNode;
      dashed: boolean;
      len: number;
      slot: number;
      /** ケーブル線形などで上書きされた線形 (無ければ大円) */
      path?: [number, number][];
    }
    const legs: Leg[] = [];
    for (const chain of chains) {
      const { nodes, slot } = chain;
      for (let i = 0; i + 1 < nodes.length; i++) {
        const a = nodes[i];
        const b = nodes[i + 1];
        const len = haversine(a.lat, a.lng, b.lat, b.lng);
        if (len < 500) continue;
        const path = chain.legPaths?.get(`${a.key}>${b.key}`);
        legs.push({ a, b, dashed: isGapLeg(a, b), len, slot, path });
      }
    }
    const shapeKey = legs
      .map((l) => `${l.slot}:${l.a.key}>${l.b.key}:${l.dashed ? "d" : "s"}${l.path ? "c" : "g"}`)
      .join("|");
    if (shapeKey !== this.trackShapeKey) {
      this.trackShapeKey = shapeKey;
      const solidBySlot = new Map<number, ReturnType<typeof lineFeature>[]>();
      const gapBySlot = new Map<number, ReturnType<typeof lineFeature>[]>();
      for (const l of legs) {
        if (l.dashed) {
          const list = gapBySlot.get(l.slot) ?? [];
          const parts = l.path
            ? dashedAlongPath(l.path, pathLength(l.path))
            : dashedTrackParts(l.a, l.b, l.len);
          for (const part of parts) list.push(lineFeature(part));
          gapBySlot.set(l.slot, list);
        } else {
          const list = solidBySlot.get(l.slot) ?? [];
          list.push(lineFeature(l.path ?? greatCirclePoints(l.a, l.b, l.len)));
          solidBySlot.set(l.slot, list);
        }
      }
      for (let slot = 0; slot < TRACE_COLORS.length; slot++) {
        this.trackSources[slot]?.update({
          type: "geojson",
          data: lineFC(solidBySlot.get(slot) ?? []),
        });
        this.gapSources[slot]?.update({
          type: "geojson",
          data: lineFC(gapBySlot.get(slot) ?? []),
        });
      }
    }

    // --- ポイント (スロット別) ---
    const waysBySlot = new Map<number, ReturnType<typeof pointFeature>[]>();
    const destsBySlot = new Map<number, ReturnType<typeof pointFeature>[]>();
    for (const chain of chains) {
      for (const n of chain.nodes) {
        const bag = n.isDest ? destsBySlot : waysBySlot;
        const list = bag.get(chain.slot) ?? [];
        list.push(pointFeature(n.lng, n.lat));
        bag.set(chain.slot, list);
      }
    }
    for (let slot = 0; slot < TRACE_COLORS.length; slot++) {
      this.waySources[slot]?.update({ type: "geojson", data: fc(waysBySlot.get(slot) ?? []) });
      this.destSources[slot]?.update({ type: "geojson", data: fc(destsBySlot.get(slot) ?? []) });
    }

    // --- チップ ---
    const wanted = new Map<string, { node: ChainNode; slot: number }>();
    for (const chain of chains) {
      for (const n of chain.nodes) {
        wanted.set(`${chain.id}:${n.key}`, { node: n, slot: chain.slot });
      }
    }
    for (const [id, el] of this.chips) {
      if (!wanted.has(id)) {
        el.remove();
        this.chips.delete(id);
      }
    }
    for (const [id, { node, slot }] of wanted) {
      let el = this.chips.get(id);
      if (!el) {
        const btn = document.createElement("button");
        btn.type = "button";
        el = btn;
        el.className = "chip";
        this.chipRoot.appendChild(el);
        this.chips.set(id, el);
      }
      // ノードは更新のたびに作り直されるので、クリック時に最新を引けるよう毎回貼り替える
      (el as HTMLButtonElement).onclick = () => this.onNodeClick?.(node);
      el.classList.toggle("chip-dest", node.isDest);
      el.classList.toggle("chip-origin", node.isOrigin);
      for (let s = 0; s < TRACE_COLORS.length; s++) {
        el.classList.toggle(`chip-slot-${s}`, s === slot);
      }
      // 複数トレースで同じ都市に重なったとき用に、スロットごとに縦へずらす
      el.style.translate = `10px ${-26 - slot * 22}px`;
      const flag = flagEmoji(node.countryCode);
      el.textContent = `${nodeLabel(node)}${flag ? " " + flag : ""}`;
    }
    this.chipPositions = [...wanted.entries()].map(([id, { node }]) => ({
      id,
      lng: node.lng,
      lat: node.lat,
      alt: 0,
    }));
    this.syncOverlay();
  }

  reset(): void {
    this.setChains([]);
  }

  private syncOverlay(): void {
    const positions = [...this.chipPositions];
    if (this.cableChipPos) {
      positions.push({ id: "cable-pick", lng: this.cableChipPos.lng, lat: this.cableChipPos.lat, alt: 0 });
    }
    this.overlay.setPositions(positions);
  }

  // ---- 海底ケーブル ----

  setCableClickHandler(fn: (id: string, name: string) => void): void {
    this.onCableClick = fn;
  }

  /** TeleGeography の cable-geo.json (FeatureCollection) をそのまま渡す */
  setCables(geojson: object): void {
    this.cableSource?.update({ type: "geojson", data: geojson, tiled: true });
  }

  setCablesVisible(visible: boolean): void {
    this.cablesVisible = visible;
    this.cableLayer?.update({
      type: "vector",
      source: this.cableSource,
      polyline: {
        color: new Color().setStyle(CABLE_COLOR),
        width: 1,
        clampToGround: true,
        show: this.cablesVisible,
      },
    });
  }

  /** 経路が通ると推定したケーブルのフィーチャを発光表示する */
  setCableHighlights(features: object[]): void {
    this.cableHiSource?.update({
      type: "geojson",
      data: { type: "FeatureCollection", features },
    });
  }

  flyToCable(cable: { label: { lat: number; lng: number } }): void {
    if (!this.ready) return;
    void this.view.flyTo(
      { lng: cable.label.lng, lat: cable.label.lat, height: 3_500_000, heading: 0, pitch: -90, roll: 0 },
      { duration: this.flyDuration(1600) },
    );
  }

  private showCableChip(text: string, pos: { lat: number; lng: number }): void {
    if (!this.cableChip) {
      const el = document.createElement("div");
      el.className = "chip chip-cable";
      this.chipRoot.appendChild(el);
      this.cableChip = el;
    }
    this.cableChip.textContent = text;
    this.cableChipPos = pos;
    this.syncOverlay();
  }

  setCableChipText(text: string): void {
    if (this.cableChip) this.cableChip.textContent = text;
  }

  hideCableChip(): void {
    if (!this.cableChip) return;
    this.cableChip.remove();
    this.cableChip = null;
    this.cableChipPos = null;
    if (this.ready) this.syncOverlay();
  }

  /** 非表示タブでは rAF が止まりアニメーションが進まないので即時ジャンプにする */
  private flyDuration(ms: number): number {
    return document.visibilityState === "hidden" ? 0 : ms;
  }

  /** 地点クリック時のフライ。詳細マップが出る高度まで寄る */
  async flyToNode(node: ChainNode, distance = 550_000): Promise<void> {
    if (!this.ready) return;
    await this.view.flyTo(
      { lng: node.lng, lat: node.lat, distance, heading: 0, pitch: -68, roll: 0 },
      { duration: this.flyDuration(1600) },
    );
  }

  /** 指定チェーンの最新ホップに追従: 直前の区間が見える距離でフライ。
   *  ホップ到着のたびにカメラが揺れないよう、フライ中+短い休止の間は
   *  次の追従を発火しない (完了後に届いたホップは次回の追従で追いつく) */
  private followBusy = false;

  followLatest(chainId: string): void {
    if (!this.ready || this.followBusy) return;
    const nodes = this.chains.find((c) => c.id === chainId)?.nodes ?? [];
    const n = nodes.length;
    if (n === 0) return;
    const node = nodes[n - 1];
    let distance = 1_800_000;
    if (n >= 2) {
      const prev = nodes[n - 2];
      // 下限はグロー殻 (半径1.08倍 ≈ 高度510km) に入り込まない距離にする
      distance = Math.min(
        Math.max(haversine(prev.lat, prev.lng, node.lat, node.lng) * 1.9, 1_400_000),
        11_000_000,
      );
    }
    this.followBusy = true;
    void this.view
      .flyTo(
        { lng: node.lng, lat: node.lat, distance, heading: 0, pitch: -75, roll: 0 },
        { duration: this.flyDuration(2_000), easing: "cubicInOut" },
      )
      .finally(() => {
        // フライ完了後も1秒は静止させる
        setTimeout(() => {
          this.followBusy = false;
        }, 1_000);
      });
  }

  /** 表示中の全経路が収まるように俯瞰 */
  fitAll(): void {
    if (!this.ready) return;
    const nodes = this.chains.flatMap((c) => c.nodes);
    if (nodes.length === 0) return;
    if (nodes.length === 1) {
      void this.flyToNode(nodes[0]);
      return;
    }
    const ref = nodes[0].lng;
    const norm = (lng: number) => ref + ((((lng - ref + 540) % 360) + 360) % 360) - 180;
    const lats = nodes.map((n) => n.lat);
    const lngs = nodes.map((n) => norm(n.lng));
    let cLat = lats.reduce((s, v) => s + v, 0) / lats.length;
    let cLng = lngs.reduce((s, v) => s + v, 0) / lngs.length;
    cLng = ((((cLng + 540) % 360) + 360) % 360) - 180;
    let maxDist = 0;
    for (const n of nodes) {
      maxDist = Math.max(maxDist, haversine(cLat, cLng, n.lat, n.lng));
    }
    // 下限はグロー殻 (高度510km) より十分外側に取る
    const height = Math.min(Math.max(maxDist * 2.4, 1_600_000), 22_000_000);
    void this.view.flyTo(
      { lng: cLng, lat: cLat, height, heading: 0, pitch: -90, roll: 0 },
      { duration: this.flyDuration(1800) },
    );
  }

  /** ユーザーがドラッグを始めたら呼び出し元へ通知 (追従OFF用) */
  onUserGrab(fn: () => void): void {
    this.view.canvas.addEventListener("pointerdown", fn);
  }
}

function waitForSize(el: HTMLElement): Promise<void> {
  if (el.offsetWidth > 0 && el.offsetHeight > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        ro.disconnect();
        resolve();
      }
    });
    ro.observe(el);
  });
}

function pointFeature(lng: number, lat: number) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Point" as const, coordinates: [lng, lat] },
  };
}

function fc(features: ReturnType<typeof pointFeature>[]) {
  return { type: "FeatureCollection" as const, features };
}

function emptyFC() {
  return fc([]);
}

function lineFeature(coords: [number, number][]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: coords },
  };
}

function lineFC(features: ReturnType<typeof lineFeature>[]) {
  return { type: "FeatureCollection" as const, features };
}

function emptyLineFC() {
  return lineFC([]);
}
