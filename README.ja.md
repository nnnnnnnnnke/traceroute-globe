# Traceroute Globe

**[English README is here](README.md)**

traceroute の経路を、[Navara](https://navara.world/)(Rust/WASM + Three.js 製の
オープンソース 3D マップエンジン)による夜の 3D 地球儀上に可視化するツール。

ライブ実行でホップが見つかるたびに経路が地球上に伸びていき、IPv4 / IPv6 の
経路を並べて比較したり、AS 単位のパスをひと目で読んだりできます。

![ftp.funet.fi へのデュアルスタック比較 — IPv6 (オレンジ) はNORDUnet経由で北極回り、IPv4 (シアン) はArelion経由で米国横断](docs/screenshot-hero.png)

## 機能

- **実行モード** — ローカルの開発サーバが `traceroute` / `traceroute6`
  (ICMP / UDP) を実行し、SSE でストリーム。各ホップをジオロケーション+
  逆引きして、追従カメラ付きでリアルタイムに描画
- **デュアルスタック比較** — 「両方」を選ぶと IPv4 / IPv6 を同時にトレースし
  色分け描画。フレッツ系 IPoE などでは 2 つの経路がまったく違うのが一目で
  分かります
- **AS パス** — ホップを AS 単位でグルーピングした線形図
  (`AS2914 NTT → AS1299 Arelion → AS2603 NORDUnet → AS1741 FUNET`)。
  各ブロックは [bgp.tools](https://bgp.tools) へリンク
- **経路統計** — 測地距離、光ファイバ中の光速 (≈ 200,000 km/s) による往復
  理論下限、実測 RTT と経路効率%
- **貼り付けモード** — 別マシンで採った `traceroute` / Windows `tracert`
  (英語・日本語) / `mtr --report` の出力をそのまま貼り付けて可視化
- **履歴オーバーレイ** — 完了したトレースを localStorage に保存 (最大20件)。
  クリックで最大 4 本まで色分けして重ね描き
- **ズーム対応** — 俯瞰は NASA Black Marble、寄ると OSM ベースの詳細ダーク
  マップ (ストリートレベル) へ高度連動でクロスフェード。地表トラックと
  ホップマーカーが正確に接続された状態で見えます

![サンフランシスコ・ベイエリアへズームイン — San Jose / Palo Alto のホップが地表トラックでストリートレベルまで正確に接続](docs/screenshot-detail.png)

## 使い方

```sh
npm install
npm run dev
```

Vite が表示する URL (例: http://localhost:5173) を開く。

- **実行モード**は macOS 前提 (システムの `traceroute` / `traceroute6` を
  spawn します)。ICMP 推奨。IPoE / DS-Lite 系の回線では IPv4 の中間ホップは
  ほぼ応答しないため、IPv6 のほうが経路がよく見えます
- **貼り付けモード**はどの環境でも動きます。手元にデータがなければ
  [docs/demo-v6.txt](docs/demo-v6.txt) / [docs/demo-v4.txt](docs/demo-v4.txt)
  (ftp.funet.fi への実トレースから公開ホップのみ抜き出したもの) をどうぞ

## 表示の読み方

| 要素 | 意味 |
| --- | --- |
| 実線アーク | TTL が連続しているホップ間の区間 |
| 破線アーク | 位置不明ホップ (`*` タイムアウト、プライベート/CGN) を跨いだ区間 |
| 細い地表線 | 大円に沿った正確なグラウンドトラック (ズームインするとアークから引き継ぐ) |
| 色 | トレースごとの色スロット: シアン → オレンジ → バイオレット → グリーン |
| 大きい点 | 宛先 |
| 白いパルス | 実線区間を流れる演出用のパケットパルス |

近接ホップ (5km 未満) は 1 地点にまとめ、`8–9 Chiyoda City` のように TTL
範囲で表示します。右パネルには全ホップ (IP / 逆引き / 都市 / ASN / RTT) が
並び、クリックでその地点へフライします。IP ジオロケーションは良くても
都市レベルの精度で、特に anycast 宛先では実際と違う場所に出ることがあります。

## 仕組み

```
ブラウザ (Vite + TypeScript + @navaramap/three)
  ├─ GET /api/trace    traceroute を spawn し、ホップ+ジオ+逆引きを SSE 配信
  ├─ POST /api/enrich  貼り付けモード用の一括ジオロケーション+逆引き
  └─ GET /api/self     発信元 (自分のグローバル IP) の位置
サーバ側 (server/api.ts, Vite 開発サーバのミドルウェア)
  └─ ジオロケーションは ip-api.com /batch (15req/分制限に合わせて
     スロットル+マイクロバッチ+キャッシュ)
```

Navara 側は、高度連動でクロスフェードする Black Marble + OSM ダークスタイル、
selective bloom 付き `ArclineMeshDesc` のアーク、clampToGround の GeoJSON
トラック/ポイント、`OverlayPlugin` で毎フレーム投影する DOM チップ (カメラ
高度から地平線距離を計算して裏側は非表示) という構成です。

ローカルツールです。開発サーバはページから要求されたホストに対して
`traceroute` を実行するので、localhost の外に公開しないでください。

## 注意

- ip-api.com の無料枠は非商用限定・HTTP のみ (サーバ側から呼び出し)・レート
  制限あり。制限は考慮済みですが、多用すると一時的に「位置情報なし」に
  なることがあります
- アークはワールド座標で描画されるため、ストリートレベルまで寄るとベース
  マップと数 km ずれることがあります (上流 ArcLine の精度特性)。そのため
  高度約 400km 以下ではアークをフェードアウトし、正確な地表トラックに
  引き継ぎます
- `docs/screenshot-*.png` は `node scripts/capture-screenshots.mjs` で再生成
  できます (Chrome と起動中の開発サーバが必要)

## クレジット

- 地図エンジン: [Navara](https://github.com/eukarya-inc/navara) (MIT / Apache-2.0)
- タイル: [Re:Earth Papers](https://papers.reearth.land/attribution) — NASA
  Earth Observatory "Earth at Night 2016" (パブリックドメイン) と OSM ベースの
  ダークスタイル (© OpenStreetMap contributors)
- IP ジオロケーション: [ip-api.com](https://ip-api.com)

## ライセンス

[MIT](LICENSE)
