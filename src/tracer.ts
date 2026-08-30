import type { TraceEvent } from "./types";

export interface TraceOptions {
  host: string;
  v6: boolean;
  proto: "icmp" | "udp";
  maxhops?: number;
}

export interface TraceHandle {
  stop: () => void;
}

export function startTrace(
  opts: TraceOptions,
  onEvent: (ev: TraceEvent) => void,
): TraceHandle {
  const params = new URLSearchParams({
    host: opts.host,
    v: opts.v6 ? "6" : "4",
    proto: opts.proto,
    maxhops: String(opts.maxhops ?? 30),
  });
  const es = new EventSource(`/api/trace?${params}`);
  es.onmessage = (e) => {
    let ev: TraceEvent;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    onEvent(ev);
    if (ev.type === "done" || ev.type === "error") es.close();
  };
  es.onerror = () => {
    // done 後の close はここにも来るので、開いている場合のみエラー扱い
    if (es.readyState !== EventSource.CLOSED) {
      es.close();
      onEvent({ type: "error", message: "サーバとの接続が切れました" });
    }
  };
  return { stop: () => es.close() };
}

export async function enrichIps(
  ips: string[],
): Promise<Record<string, { geo: import("./types").GeoInfo; hostname: string | null }>> {
  const res = await fetch("/api/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ips }),
  });
  if (!res.ok) throw new Error(`enrich failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.results ?? {};
}
