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
  /** 位置の出どころ。hostname = 逆引きホスト名の地名コード、ipmap = RIPE IPmap、ip-api = 一般IPデータベース */
  source?: "hostname" | "ipmap" | "ip-api";
  geoScore?: number;
  geoEngines?: string[];
  /** 各ソースの候補位置。RTT の物理整合性で選び直す */
  candidates?: GeoCandidate[];
}

export interface GeoCandidate {
  source: "hostname" | "ipmap" | "ip-api";
  lat: number;
  lon: number;
  city?: string;
  country?: string;
  countryCode?: string;
  score?: number;
  engines?: string[];
}

export interface Hop {
  ttl: number;
  ip: string | null; // null = タイムアウト (*)
  rtt: number | null; // ms
  note?: string;
  hostname?: string | null;
  geo?: GeoInfo;
  /** 推定位置が RTT (光速制約) と矛盾するため地図から除外している */
  geoSuspect?: boolean;
}

export interface TraceMeta {
  target: string;
  targetIp?: string;
  cmd?: string;
}

/** 履歴保存用のトレース1回分のスナップショット */
export interface TraceRecord {
  id: string;
  label: string;
  family: 4 | 6 | 0; // 0 = 貼り付け等で不明
  targetIp?: string;
  ts: number; // epoch ms
  hops: Hop[];
}

export type TraceEvent =
  | { type: "cmd"; cmd: string }
  | { type: "start"; target: string; targetIp: string }
  | { type: "hop"; ttl: number; ip: string | null; rtt: number | null; note?: string }
  | { type: "geo"; ip: string; geo: GeoInfo }
  | { type: "rdns"; ip: string; hostname: string }
  | { type: "info"; line: string }
  | { type: "error"; message: string }
  | { type: "done"; code: number | null };
