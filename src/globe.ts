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

/** 地球儀に重ねる1本の経路 */
export interface ChainLayer {
  id: string;
  slot: number; // TRACE_COLORS のインデックス
  nodes: ChainNode[];
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

interface DescHandle {
  update(u: object): void;
  delete(): void;
}

interface SourceHandle {
  update(u: object): void;
}

export class Globe {
  private view!: ThreeView<DefaultDescriptions>;
  private overlay!: OverlayPlugin;
  private bloomId!: string;
  private arcs: DescHandle | null = null;
  private arcCount = 0;
  private arcShapeKey = "";
  private pulse: DescHandle | null = null;
  private pulseCount = 0;
  private waySources: SourceHandle[] = [];
  private destSources: SourceHandle[] = [];
  private chipRoot!: HTMLElement;
  private chips = new Map<string, HTMLElement>();
  private chains: ChainLayer[] = [];
  private dashOffset = 0;
  private pulseOffset = 0;
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

    // 色スロットごとのホップ地点ポイント (経由地 + 宛先)
    for (const c of TRACE_COLORS) {
      const way = view.addSource({ type: "geojson", data: emptyFC() });
      view.addLayer({
        type: "vector",
        source: way,
        point: {
          color: new Color().setStyle(c.point),
          size: 9,
          sizeInMeters: false,
          declutter: false,
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
          effectIds: [this.bloomId],
          emissiveIntensity: 0.55,
        },
      });
      this.destSources.push(dest);
    }

    // アークの流線 + パケットパルスのアニメーション
    view.on("preUpdate", () => {
      this.dashOffset -= 4000;
      this.pulseOffset -= 18_000;
      if (this.arcs && this.arcCount > 0) {
        this.arcs.update({
          arcLines: Array.from({ length: this.arcCount }, () => ({
            dashOffset: this.dashOffset,
          })),
        });
      }
      if (this.pulse && this.pulseCount > 0) {
        this.pulse.update({
          arcLines: Array.from({ length: this.pulseCount }, () => ({
            dashOffset: this.pulseOffset,
          })),
        });
      }
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

    // --- アーク (全チェーン分をひとつの Descriptor にまとめる) ---
    interface Leg {
      a: ChainNode;
      b: ChainNode;
      dashed: boolean;
      len: number;
      slot: number;
    }
    const legs: Leg[] = [];
    for (const chain of chains) {
      const { nodes, slot } = chain;
      for (let i = 0; i + 1 < nodes.length; i++) {
        const a = nodes[i];
        const b = nodes[i + 1];
        const len = haversine(a.lat, a.lng, b.lat, b.lng);
        if (len < 2_500) continue; // ArcLine の精度下限 (~2km) 未満は描かない
        legs.push({ a, b, dashed: isGapLeg(a, b), len, slot });
      }
    }
    const shapeKey = legs
      .map((l) => `${l.slot}:${l.a.key}>${l.b.key}:${l.dashed ? "d" : "s"}`)
      .join("|");
    if (shapeKey !== this.arcShapeKey) {
      this.arcShapeKey = shapeKey;
      this.arcs?.delete();
      this.arcs = null;
      this.pulse?.delete();
      this.pulse = null;
      this.arcCount = legs.length;
      if (legs.length > 0) {
        const configs = legs.map((l) => ({
          geometry: [
            { lng: l.a.lng, lat: l.a.lat },
            { lng: l.b.lng, lat: l.b.lat },
          ] satisfies LatLng[],
          srcColor: new Color().setStyle(TRACE_COLORS[l.slot].arcSrc),
          tgtColor: new Color().setStyle(TRACE_COLORS[l.slot].arcTgt),
          thickness: l.dashed ? 1.2 : 1.7,
          segments: 96,
          arcHeightScale: 0.35,
          gradation: 0.35,
          dashed: l.dashed,
          // 区間長に比例させる (絶対値の下限を大きくすると短い区間がダッシュ1周期に
          // 収まってしまい、dashOffset アニメーションで丸ごと明滅する)
          dashSize: Math.max(l.len / 14, 2_500),
          gapSize: Math.max(l.len / 28, 1_250),
          dashOffset: this.dashOffset,
        }));
        this.arcs = this.view.addMesh<ArclineMeshDesc>({
          effectIds: [this.bloomId],
          emissiveIntensity: 0.45,
          arcLines: configs,
        }) as unknown as DescHandle;

        // パケットパルス: 実線区間の上を明るい短ダッシュが1つ流れる
        const pulseLegs = legs.filter((l) => !l.dashed);
        this.pulseCount = pulseLegs.length;
        if (pulseLegs.length > 0) {
          this.pulse = this.view.addMesh<ArclineMeshDesc>({
            effectIds: [this.bloomId],
            emissiveColor: new Color().setStyle("#ffffff"),
            emissiveIntensity: 0.9,
            arcLines: pulseLegs.map((l) => ({
              geometry: [
                { lng: l.a.lng, lat: l.a.lat },
                { lng: l.b.lng, lat: l.b.lat },
              ] satisfies LatLng[],
              srcColor: new Color().setStyle("#ffffff"),
              tgtColor: new Color().setStyle("#ffffff"),
              thickness: 2.6,
              segments: 96,
              arcHeightScale: 0.35,
              dashed: true,
              dashSize: Math.max(l.len * 0.045, 1_500),
              gapSize: l.len * 0.955,
              dashOffset: this.pulseOffset,
            })),
          }) as unknown as DescHandle;
        }
      } else {
        this.pulseCount = 0;
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
    this.overlay.setPositions(
      [...wanted.entries()].map(([id, { node }]) => ({
        id,
        lng: node.lng,
        lat: node.lat,
        alt: 0,
      })),
    );
  }

  reset(): void {
    this.setChains([]);
  }

  /** 非表示タブでは rAF が止まりアニメーションが進まないので即時ジャンプにする */
  private flyDuration(ms: number): number {
    return document.visibilityState === "hidden" ? 0 : ms;
  }

  async flyToNode(node: ChainNode, distance = 2_200_000): Promise<void> {
    if (!this.ready) return;
    await this.view.flyTo(
      { lng: node.lng, lat: node.lat, distance, heading: 0, pitch: -68, roll: 0 },
      { duration: this.flyDuration(1600) },
    );
  }

  /** 指定チェーンの最新ホップに追従: 直前の区間が見える距離でフライ */
  followLatest(chainId: string): void {
    if (!this.ready) return;
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
    void this.view.flyTo(
      { lng: node.lng, lat: node.lat, distance, heading: 0, pitch: -75, roll: 0 },
      { duration: this.flyDuration(1400) },
    );
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
