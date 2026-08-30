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

- **IPv4 / IPv6** — `traceroute` / `traceroute6` の切り替え
- **ICMP / UDP** — ICMP (`-I`) 推奨。フレッツ系 IPoE (IPv4 over IPv6) だと
  IPv4 の中間ホップはほぼ応答しないので、IPv6 側のほうが経路がよく見える
- **追従** — 新しいホップにカメラが自動でフライする。ドラッグすると解除

### 貼り付けモード

別マシンで採った出力をそのまま貼り付けて「可視化する」。
`traceroute` / Windows `tracert`(日本語出力含む)/ `mtr --report` をパースできる。

## 見え方のルール

- **実線アーク** — TTL が連続しているホップ間の区間
- **破線アーク** — 位置の分からないホップ (`*` タイムアウト / プライベート・CGN アドレス) を跨いだ区間
- **シアンの点** — 経由地 / **アンバーの点** — 宛先
- 近接ホップ (5km 未満) は 1 つの地点にまとめ、チップに `8–9 Chiyoda City` のように TTL 範囲で表示
- 右パネルには全ホップ (タイムアウト・プライベート含む) を IP / 逆引き / 都市 / ASN / RTT 付きで一覧表示。クリックでその地点へフライ

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
