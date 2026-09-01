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

export interface Hop {
  ttl: number;
  ip: string | null; // null = タイムアウト (*)
  rtt: number | null; // ms
  note?: string;
  hostname?: string | null;
  geo?: GeoInfo;
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
