// Usage: node tools/shot.mjs <url> <out.png> [waitExpr] [timeoutMs] [--size=1280x720] [--eval=<js>]
// Serves nothing: expects a dev/preview server already running. Prints console messages and page errors.
import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
const [url, out, waitExpr = "window.__ready === true", timeout = "60000", ...rest] = process.argv.slice(2);
const size = (rest.find((a) => a.startsWith("--size=")) ?? "--size=1280x720").slice(7).split("x").map(Number);
const evalJs = rest.find((a) => a.startsWith("--eval="))?.slice(7);
const args = (process.env.CHROME_ARGS ?? "--ignore-gpu-blocklist").split(" ").filter(Boolean);
const browser = await chromium.launch({ headless: true, args });
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
const logs = [];
page.on("console", (m) => { const t = m.text(); if (!/GPU stall|swiftshader|Download the React/i.test(t)) logs.push(`[${m.type()}] ${t}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "load" });
try { await page.waitForFunction(waitExpr, null, { timeout: Number(timeout) }); } catch (e) { logs.push("[shot] wait timeout: " + waitExpr); }
if (evalJs) { const r = await page.evaluate(evalJs); logs.push("[eval] " + JSON.stringify(r)); await page.waitForTimeout(300); }
await page.screenshot({ path: out });
console.log(logs.slice(-40).join("\n"));
await browser.close();
