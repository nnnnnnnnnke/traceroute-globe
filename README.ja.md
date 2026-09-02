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
- **崩れにくいルータ位置推定** — 各ホップを一般向け IP データベース (ip-api)
  と [RIPE IPmap](https://ipmap.ripe.net/) (RIPE Atlas の遅延実測・IXP・
  geofeed・クラウドソース) の両方で引き、クライアント側で実測 RTT と物理的に
  整合する候補を選びます (光ファイバ中の光速 ≈ RTT 1ms あたり 100km。発信元
  との距離と、隣接ホップとの RTT 差の両方で検証)。どの候補も説明できない
  ホップは ⚠ 付きで地図から除外
- **海底ケーブル** — 世界中の海底ケーブル (TeleGeography のデータ、約700
  システム) を経路の下に描画。ケーブルをクリックすると名前・長さ・RFS 年・
  所有者を表示
- **陸上ファイバ** — Open Fibre Data Standard の公開データ (22 カ国) に
  収録された長距離ファイバ経路を別レイヤーとして表示 (トグル可)。データの
  無い陸上区間は、長距離ファイバが道路・鉄道沿いに敷設されることが多い
  ことを踏まえて道路網 (OSRM) に沿って近似し、`🛣` 付きで「推定」と明示
- **どのケーブルを通っているか** — 大陸間の区間ごとに、通っている可能性の
  高いケーブルを推定 (両端ホップの近くに着陸点を持ち、その区間を跨ぎ、線形
  の長さが実測の RTT 増分と整合するケーブル)。ホップ一覧に候補を列挙し、
  最有力のものを地球儀上で発光表示、経路線もそのケーブルの敷設ルートに
  沿わせます。traceroute では物理層は分からないので、あくまで「推定」です
- **ズーム対応** — 俯瞰は NASA Black Marble、寄ると OSM ベースの詳細ダーク
  マップ (ストリートレベル) へ高度連動でクロスフェード。経路はタイルと同じ
  パイプラインで地表に描くので、どのズームでも線とマーカーが正確に繋がります

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
| 実線 | TTL が連続しているホップ間の区間 (大円に沿った地表トラック) |
| 破線 | 位置不明ホップ (`*` タイムアウト、プライベート/CGN) を跨いだ区間 |
| 色 | トレースごとの色スロット: シアン → オレンジ → バイオレット → グリーン |
| 大きい点 | 宛先 |
| 青い細線の網 | 世界の海底ケーブル (左パネルのトグルで表示/非表示) |
| 琥珀色の細線 | OFDS 公開データの陸上ファイバ経路 (トグル可) |
| 発光する青緑のケーブル | 大陸間区間で推定されたケーブル (ホップ一覧の `🌊`)。経路線はその線形に沿う |
| 道路沿いの経路線 | 道路網で近似した陸上区間 (ホップ一覧の `🛣`) |

近接ホップ (5km 未満) は 1 地点にまとめ、`8–9 Chiyoda City` のように TTL
範囲で表示します。右パネルには全ホップ (IP / 逆引き / 都市 / ASN / RTT) が
並び、クリックでその地点へフライします。IP ジオロケーションは良くても
都市レベルの精度で、特に anycast 宛先では実際と違う場所に出ることがあります。

## 仕組み

```
ブラウザ (Vite + TypeScript + @navaramap/three)
  ├─ GET /api/trace    traceroute を spawn し、ホップ+ジオ+逆引きを SSE 配信
  ├─ POST /api/enrich  貼り付けモード用の一括ジオロケーション+逆引き
  ├─ GET /api/self     発信元 (自分のグローバル IP) の位置
  ├─ GET /api/cables   TeleGeography のケーブル GeoJSON / 詳細のプロキシ+キャッシュ
  ├─ GET /api/fiber    OFDS の陸上ファイバ区間を取得・間引き・統合して配信
  └─ GET /api/route    2点間の道路ルート (OSRM デモサーバ、直列化して呼び出し)
サーバ側 (server/api.ts, Vite 開発サーバのミドルウェア)
  ├─ ジオロケーション: ip-api.com /batch (ASN。15req/分制限に合わせてスロットル)
  │  + RIPE IPmap を IP ごとに (位置。4並列)、どちらもキャッシュ。候補を
  │  すべてクライアントへ渡し、RTT との整合で選び直す
  └─ 陸上ファイバ: OFDS の GeoJSON 27 ファイル (約22MB) を Douglas–Peucker で
     1MB 未満に間引き、ディスクに1週間キャッシュ
```

Navara 側は、高度連動でクロスフェードする Black Marble + OSM ダークスタイル、
clampToGround の GeoJSON ポリラインによる経路とケーブル (経路と推定ケーブル
には selective bloom)、GeoJSON ポイントのホップ、`OverlayPlugin` で毎フレーム
投影する DOM チップ (カメラ高度から地平線距離を計算して裏側は非表示) という
構成です。

ケーブル推定 (`src/cables.ts`): 600km 以上かつ国境を跨ぐ (国内なら 1,500km
以上) 区間を対象に、両端のホップからそれぞれ 350km 以内に線の端点 (着陸点) を
持ち、その 2 端点が区間を跨ぐだけ離れているケーブルを候補とし、着陸点までの
距離と区間長との差で順位付けします。

ローカルツールです。開発サーバはページから要求されたホストに対して
`traceroute` を実行するので、localhost の外に公開しないでください。

## 注意

- ip-api.com の無料枠は非商用限定・HTTP のみ (サーバ側から呼び出し)・レート
  制限あり。制限は考慮済みですが、多用すると一時的に「位置情報なし」に
  なることがあります
- 海底ケーブルのデータは TeleGeography の Submarine Cable Map 公開 API から
  実行時に取得します (このリポジトリには同梱しません)。開発サーバが 24 時間
  キャッシュし、クレジットは地図のアトリビューションに表示します
- `docs/screenshot-*.png` は `node scripts/capture-screenshots.mjs` で再生成
  できます (Chrome と起動中の開発サーバが必要)

## クレジット

- 地図エンジン: [Navara](https://github.com/eukarya-inc/navara) (MIT / Apache-2.0)
- タイル: [Re:Earth Papers](https://papers.reearth.land/attribution) — NASA
  Earth Observatory "Earth at Night 2016" (パブリックドメイン) と OSM ベースの
  ダークスタイル (© OpenStreetMap contributors)
- IP ジオロケーション: [ip-api.com](https://ip-api.com)
- 海底ケーブルの経路と詳細: [TeleGeography Submarine Cable Map](https://www.submarinecablemap.com/)
- ルータ位置推定: [RIPE IPmap](https://ipmap.ripe.net/) (RIPE NCC)
- 陸上ファイバ: [OFDS public data](https://github.com/Open-Telecoms-Data/OFDS-public-data) (Open Telecoms Data)
- 陸上区間の道路ルーティング: [OSRM](http://project-osrm.org/) デモサーバ, © OpenStreetMap contributors

## ライセンス

[MIT](LICENSE)
