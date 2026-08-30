import ThreeView, { Color, type LatLng } from "@navaramap/three";
import type {
  ArclineMeshDesc,
  GlowGlobeMeshDesc,
  SelectiveBloomEffectDesc,
} from "@navaramap/three-default-descs";
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

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
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

export function flagEmoji(countryCode?: string): string {
  if (!countryCode || !/^[A-Z]{2}$/i.test(countryCode)) return "";
  return String.fromCodePoint(
    ...[...countryCode.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// ---------------------------------------------------------------------------
// Globe 本体
// ---------------------------------------------------------------------------

const ARC_SRC = "#8be2ff";
const ARC_TGT = "#0091ff";
const POINT_COLOR = "#c9ecff";
const DEST_COLOR = "#ffc247";

interface DescHandle {
  update(u: object): void;
  delete(): void;
}

export class Globe {
  private view!: ThreeView<DefaultDescriptions>;
  private overlay!: OverlayPlugin;
  private bloomId!: string;
  private arcs: DescHandle | null = null;
  private arcCount = 0;
  private arcShapeKey = "";
  private pointSource: { update(u: object): void } | null = null;
  private destSource: { update(u: object): void } | null = null;
  private chipRoot!: HTMLElement;
  private chips = new Map<string, HTMLElement>();
  private nodes: ChainNode[] = [];
  private dashOffset = 0;
  private onNodeClick: ((node: ChainNode) => void) | null = null;

  async init(container: HTMLElement, chipRoot: HTMLElement): Promise<void> {
    this.chipRoot = chipRoot;
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

    // 夜の地球 (NASA Black Marble) + 大気のフレネルグロー
    const basemap = await tilejson.addSource({
      type: "raster-tile",
      url: "https://papers.reearth.land/blackmarble/tilejson.json",
    });
    view.addLayer({ type: "raster", source: basemap });

    view.addMesh<GlowGlobeMeshDesc>({
      glowGlobe: {
        radiusScale: 1.08,
        coefficient: 0.35,
        exponent: 6,
        glowColor: new Color().setHex(0x4aa8ff),
        opacity: 0.9,
      },
    });

    const bloom = view.addEffect<SelectiveBloomEffectDesc>({
      selectiveBloom: { strength: 1.0, radius: 0.5, threshold: 0 },
    });
    this.bloomId = bloom.id;

    // ホップ地点のポイント (経由地: シアン / 宛先: アンバー)
    this.pointSource = view.addSource({ type: "geojson", data: emptyFC() });
    view.addLayer({
      type: "vector",
      source: this.pointSource as never,
      point: {
        color: new Color().setStyle(POINT_COLOR),
        size: 9,
        sizeInMeters: false,
        declutter: false,
        effectIds: [this.bloomId],
        emissiveIntensity: 0.35,
      },
    });
    this.destSource = view.addSource({ type: "geojson", data: emptyFC() });
    view.addLayer({
      type: "vector",
      source: this.destSource as never,
      point: {
        color: new Color().setStyle(DEST_COLOR),
        size: 13,
        sizeInMeters: false,
        declutter: false,
        effectIds: [this.bloomId],
        emissiveIntensity: 0.5,
      },
    });

    // アークの流線アニメーション
    view.on("preUpdate", () => {
      if (!this.arcs || this.arcCount === 0) return;
      this.dashOffset -= 4000;
      const offs = Array.from({ length: this.arcCount }, () => ({
        dashOffset: this.dashOffset,
      }));
      this.arcs.update({ arcLines: offs });
    });

    // DOMチップの毎フレーム再配置 (地平線の裏に回った地点は隠す)
    this.overlay.onUpdate(({ projected }) => {
      const camH = this.view.camera.positionGeographic.height;
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
    });

    view.attribution?.add([
      {
        attributionHtml: `IP Geolocation by <a href="https://ip-api.com">ip-api.com</a>`,
      },
    ]);
  }

  setNodeClickHandler(fn: (node: ChainNode) => void): void {
    this.onNodeClick = fn;
  }

  /** 状態全体を反映 (追加のたびに呼ぶ。差分は内部で処理) */
  setChain(nodes: ChainNode[]): void {
    this.nodes = nodes;

    // --- アーク ---
    const legs: { a: ChainNode; b: ChainNode; dashed: boolean; len: number }[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const len = haversine(a.lat, a.lng, b.lat, b.lng);
      if (len < 2_500) continue; // ArcLine の精度下限 (~2km) 未満は描かない
      legs.push({ a, b, dashed: isGapLeg(a, b), len });
    }
    const shapeKey = legs
      .map((l) => `${l.a.key}>${l.b.key}:${l.dashed ? "d" : "s"}`)
      .join("|");
    if (shapeKey !== this.arcShapeKey) {
      this.arcShapeKey = shapeKey;
      this.arcs?.delete();
      this.arcs = null;
      this.arcCount = legs.length;
      if (legs.length > 0) {
        const configs = legs.map((l) => ({
          geometry: [
            { lng: l.a.lng, lat: l.a.lat },
            { lng: l.b.lng, lat: l.b.lat },
          ] satisfies LatLng[],
          srcColor: new Color().setStyle(ARC_SRC),
          tgtColor: new Color().setStyle(ARC_TGT),
          thickness: l.dashed ? 1.2 : 1.7,
          segments: 96,
          arcHeightScale: 0.35,
          gradation: 0.35,
          dashed: l.dashed,
          dashSize: Math.max(l.len / 14, 30_000),
          gapSize: Math.max(l.len / 28, 15_000),
          dashOffset: this.dashOffset,
        }));
        this.arcs = this.view.addMesh<ArclineMeshDesc>({
          effectIds: [this.bloomId],
          emissiveColor: new Color().setStyle(ARC_TGT),
          emissiveIntensity: 0.45,
          arcLines: configs,
        }) as unknown as DescHandle;
      }
    }

    // --- ポイント ---
    const wayFeatures = nodes
      .filter((n) => !n.isDest)
      .map((n) => pointFeature(n.lng, n.lat));
    const destFeatures = nodes.filter((n) => n.isDest).map((n) => pointFeature(n.lng, n.lat));
    this.pointSource?.update({ type: "geojson", data: fc(wayFeatures) });
    this.destSource?.update({ type: "geojson", data: fc(destFeatures) });

    // --- チップ ---
    const wanted = new Set(nodes.map((n) => n.key));
    for (const [id, el] of this.chips) {
      if (!wanted.has(id)) {
        el.remove();
        this.chips.delete(id);
      }
    }
    for (const node of nodes) {
      let el = this.chips.get(node.key);
      if (!el) {
        const btn = document.createElement("button");
        btn.type = "button";
        el = btn;
        el.className = "chip";
        el.addEventListener("click", () => this.onNodeClick?.(node));
        this.chipRoot.appendChild(el);
        this.chips.set(node.key, el);
      }
      el.classList.toggle("chip-dest", node.isDest);
      el.classList.toggle("chip-origin", node.isOrigin);
      const flag = flagEmoji(node.countryCode);
      el.textContent = `${nodeLabel(node)}${flag ? " " + flag : ""}`;
    }
    this.overlay.setPositions(nodes.map((n) => ({ id: n.key, lng: n.lng, lat: n.lat, alt: 0 })));
  }

  reset(): void {
    this.setChain([]);
  }

  async flyToNode(node: ChainNode, distance = 2_200_000): Promise<void> {
    await this.view.flyTo(
      { lng: node.lng, lat: node.lat, distance, heading: 0, pitch: -68, roll: 0 },
      { duration: 1600 },
    );
  }

  /** 新しいホップに追従: 直前の区間が見える距離でフライ */
  followLatest(): void {
    const n = this.nodes.length;
    if (n === 0) return;
    const node = this.nodes[n - 1];
    let distance = 1_800_000;
    if (n >= 2) {
      const prev = this.nodes[n - 2];
      distance = Math.min(Math.max(haversine(prev.lat, prev.lng, node.lat, node.lng) * 1.9, 900_000), 11_000_000);
    }
    void this.view.flyTo(
      { lng: node.lng, lat: node.lat, distance, heading: 0, pitch: -75, roll: 0 },
      { duration: 1400 },
    );
  }

  /** 経路全体が収まるように俯瞰 */
  fitAll(): void {
    if (this.nodes.length === 0) return;
    if (this.nodes.length === 1) {
      void this.flyToNode(this.nodes[0]);
      return;
    }
    const ref = this.nodes[0].lng;
    const norm = (lng: number) => ref + ((((lng - ref + 540) % 360) + 360) % 360) - 180;
    const lats = this.nodes.map((n) => n.lat);
    const lngs = this.nodes.map((n) => norm(n.lng));
    let cLat = lats.reduce((s, v) => s + v, 0) / lats.length;
    let cLng = lngs.reduce((s, v) => s + v, 0) / lngs.length;
    cLng = ((((cLng + 540) % 360) + 360) % 360) - 180;
    let maxDist = 0;
    for (const n of this.nodes) {
      maxDist = Math.max(maxDist, haversine(cLat, cLng, n.lat, n.lng));
    }
    const height = Math.min(Math.max(maxDist * 2.4, 900_000), 22_000_000);
    void this.view.flyTo(
      { lng: cLng, lat: cLat, height, heading: 0, pitch: -90, roll: 0 },
      { duration: 1800 },
    );
  }

  /** ユーザーがドラッグを始めたら呼び出し元へ通知 (追従OFF用) */
  onUserGrab(fn: () => void): void {
    this.view.canvas.addEventListener("pointerdown", fn);
  }
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
