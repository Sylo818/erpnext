// Contact sheet: node tools/labsheet.mjs spec.json out.png
// spec: { url, size:[w,h], tile:[w,h], cols, init: "js", frames:[{ pre:"js", steps:n, cam:[alpha,beta,r,tx,ty,tz], label }] }
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs";
const [specPath, out] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const size = spec.size ?? [640, 400];
const tile = spec.tile ?? size;
const cols = spec.cols ?? 4;
const browser = await chromium.launch({ headless: true, args: (process.env.CHROME_ARGS ?? "--ignore-gpu-blocklist").split(" ").filter(Boolean) });
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
const logs = [];
page.on("console", (m) => { const t = m.text(); if (m.type() === "error" || /\[sheet\]/.test(t)) logs.push(t); });
page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
await page.goto(spec.url ?? "http://127.0.0.1:5173/?lab=1&auto=0", { waitUntil: "load" });
await page.waitForFunction("window.__ready === true", null, { timeout: 90000 });
if (spec.init) await page.evaluate(spec.init);
const shots = [];
for (const fr of spec.frames) {
  const r = await page.evaluate(`(()=>{ const lab = window.__lab; ${fr.pre ?? ""}; lab.step(${fr.steps ?? 0}); ${fr.cam ? `lab.camera(${fr.cam.join(",")});` : ""} const url = lab.capture(); return { url, info: ${fr.info ?? "null"} }; })()`);
  shots.push({ ...r, label: fr.label ?? "" });
}
const rows = Math.ceil(shots.length / cols);
const dataUrl = await page.evaluate(async ({ shots, tile, cols, rows }) => {
  const c = document.createElement("canvas");
  c.width = tile[0] * cols; c.height = tile[1] * rows;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < shots.length; i++) {
    const img = new Image(); img.src = shots[i].url; await img.decode();
    const x = (i % cols) * tile[0], y = Math.floor(i / cols) * tile[1];
    g.drawImage(img, x, y, tile[0], tile[1]);
    g.fillStyle = "rgba(0,0,0,0.6)"; g.fillRect(x, y, tile[0], 18);
    g.fillStyle = "#fff"; g.font = "12px monospace"; g.fillText(shots[i].label + (shots[i].info ? " " + JSON.stringify(shots[i].info) : ""), x + 4, y + 13);
  }
  return c.toDataURL("image/png");
}, { shots, tile, cols, rows });
fs.writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
console.log(logs.join("\n"));
await browser.close();
