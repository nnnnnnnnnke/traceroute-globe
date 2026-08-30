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

export type TraceEvent =
  | { type: "cmd"; cmd: string }
  | { type: "start"; target: string; targetIp: string }
  | { type: "hop"; ttl: number; ip: string | null; rtt: number | null; note?: string }
  | { type: "geo"; ip: string; geo: GeoInfo }
  | { type: "rdns"; ip: string; hostname: string }
  | { type: "info"; line: string }
  | { type: "error"; message: string }
  | { type: "done"; code: number | null };
