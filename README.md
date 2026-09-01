# Traceroute Globe

traceroute の経由結果を [Navara](https://navara.world/)(オープンソースの 3D 地球儀マップエンジン)で可視化するローカルツール。
夜の地球 (NASA Black Marble) の上に、ホップ間の経路を発光するアークで描く。

## 使い方

```sh
npm install
npm run dev
```

ブラウザで http://localhost:5173 (Vite の表示ポート) を開く。

### 実行モード

ホスト名 / IP を入れて「トレース開始」。Vite の開発サーバが macOS の
`traceroute` / `traceroute6` を実行し、結果を SSE でストリームして、
ホップが見つかるたびに地球儀へリアルタイムに追加される。

- **IPv4 / IPv6 / 両方** — `traceroute` / `traceroute6` の切り替え。
  **「両方」は同時に2本実行して色分け描画** (デュアルスタック経路比較)。
  フレッツ系 IPoE だと v4 と v6 で経路がまったく違うのが一目で見える
- **ICMP / UDP** — ICMP (`-I`) 推奨。IPoE の IPv4 は中間ホップがほぼ応答しない
- **追従** — 新しいホップにカメラが自動でフライする。ドラッグすると解除
- **プリセット** — funet / he.net / routeviews / fau / aarnet / wide のワンタップ入力

### 貼り付けモード

別マシンで採った出力をそのまま貼り付けて「可視化する」。
`traceroute` / Windows `tracert`(日本語出力含む)/ `mtr --report` をパースできる。

### 履歴

完了したトレースは localStorage に保存され (最大20件)、左パネルの履歴を
クリックすると現在の表示に**重ね描き**できる (最大4本、色スロット自動割当)。
時間帯や回線を変えて同じ宛先を比較する用途を想定。

## 表示

- **ズーム** — 俯瞰では NASA Black Marble (夜の光)、寄ると OSM ベースの
  詳細ダークマップ (maxzoom 22) へ高度連動でクロスフェード。ホップの行や
  チップをクリックすると詳細が見える高度 (約550km) までフライする
- **地球儀** — 実線アーク = TTL 連続区間 / 破線アーク = 位置不明ホップ
  (`*` やプライベート・CGN) を跨いだ区間。トレースごとに色分け
  (シアン → オレンジ → バイオレット → グリーン)、宛先は大きい点。
  実線区間には流れるパケットパルス
- **右パネル** — トレースごとのセクションに全ホップ (IP / 逆引き / 都市 /
  ASN / RTT)。クリックでその地点へフライ。ヘッダには経路統計:
  `経路 ≥ 19,535 km · 光理論 ≥ 195.3 ms · 実測 275.0 ms (効率 71%)`
  (判明地点間の測地距離と、光ファイバ中の光速 ≈ 200,000 km/s による往復理論値)
- **AS パス** (画面下) — ホップを AS 単位でグルーピングした線形図。
  `AS4713 OCN → ✕ → AS2914 NTT → AS2603 NORDUnet → AS1741 FUNET` のように
  経路の AS 遷移が読める。AS ブロックのクリックで bgp.tools が開く
- 近接ホップ (5km 未満) は 1 地点にまとめ、チップに `8–9 Chiyoda City` の
  ように TTL 範囲で表示

## 仕組み

```
ブラウザ (Vite + TypeScript + @navaramap/three)
  ├─ GET /api/trace   … traceroute を spawn し SSE でホップ+ジオ情報+逆引きを配信
  ├─ POST /api/enrich … 貼り付けモード用の一括ジオロケーション+逆引き
  └─ GET /api/self    … 発信元 (自分のグローバル IP) の位置
サーバ側 (server/api.ts, Vite プラグインの configureServer ミドルウェア)
  └─ ジオロケーションは ip-api.com の batch API (45req/分制限のため 300ms 窓でまとめ、キャッシュ)
```

Navara 側の主な構成 (src/globe.ts):

- ベースマップ: Black Marble 2016 (Re:Earth Papers の TileJSON)
- `GlowGlobeMeshDesc` で大気のリムグロー、`SelectiveBloomEffectDesc` でアークとポイントを発光
- アークは `ArclineMeshDesc` の config 配列 (1 区間 = 1 config で実線/破線を切り替え)
- ホップのラベルは `OverlayPlugin` で毎フレーム投影する DOM チップ
  (カメラ高度から地平線距離を計算して、地球の裏に回った地点は非表示)

## 注意

- ip-api.com の無料枠は非商用限定・HTTP のみ (サーバ側から叩くのでブラウザには影響しない)
- ジオロケーションは目安。とくに anycast (1.1.1.1 など) は実際と違う場所に出ることがある
- ArcLine は約 2km 未満の区間を描画できないため、近接地点はまとめている

## クレジット

- 地図エンジン: [Navara](https://github.com/eukarya-inc/navara) (MIT / Apache-2.0)
- タイル: [Re:Earth Papers](https://papers.reearth.land/attribution) — NASA Earth Observatory "Earth at Night 2016" (public domain)
- IP ジオロケーション: [ip-api.com](https://ip-api.com)
