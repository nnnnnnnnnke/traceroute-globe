// README 用スクリーンショットを自動生成する。
// 前提: `npm run dev` が起動していること (APP_URL で上書き可)。
//   node scripts/capture-screenshots.mjs
// デモデータは docs/demo-*.txt (公開バックボーンのホップのみ)。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL ?? "http://localhost:5199";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const docs = (p) => fileURLToPath(new URL(`../docs/${p}`, import.meta.url));
const v6Text = await readFile(docs("demo-v6.txt"), "utf8");
const v4Text = await readFile(docs("demo-v4.txt"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.__globe && globalThis.__globe.ready === true, {
    timeout: 120_000,
  });

  const paste = async (text) => {
    await page.click("#tab-paste");
    await page.$eval("#paste-text", (el, t) => (el.value = t), text);
    await page.click("#visualize");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".trace-status")].some(
          (s) => s.textContent === "完了",
        ),
      { timeout: 60_000 },
    );
  };

  await paste(v6Text);
  await paste(v4Text);
  // 1本目 (IPv6) を履歴から重ね描きして2色比較の絵にする
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("#history-list .hist")].find(
      (x) => !x.classList.contains("active") && x.textContent.includes("IPv6"),
    );
    row?.click();
  });
  await sleep(3_000);
  await page.click("#fit");
  await sleep(10_000); // フライ + タイル読み込み

  await page.screenshot({ path: docs("screenshot-hero.png") });
  console.log("saved docs/screenshot-hero.png");

  // 近距離: ベイエリアの地表トラック + 詳細マップ
  await page.evaluate(() => {
    void globalThis.__globe.view.flyTo(
      { lng: -121.95, lat: 37.4, distance: 130_000, heading: 0, pitch: -70, roll: 0 },
      { duration: 1200 },
    );
  });
  await sleep(12_000);
  await page.screenshot({ path: docs("screenshot-detail.png") });
  console.log("saved docs/screenshot-detail.png");
} finally {
  await browser.close();
}
