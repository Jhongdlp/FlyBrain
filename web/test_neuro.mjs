import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const DIST = "dist";
const TIPOS = {
  ".html": "text/html", ".js": "text/javascript",
  ".wasm": "application/wasm", ".css": "text/css",
  ".bin": "application/octet-stream", ".act": "application/octet-stream",
  ".ojo": "application/octet-stream", ".mp3": "audio/mpeg",
};

const server = createServer(async (req, res) => {
  const pedido = req.url.split("?")[0];
  const ruta = pedido === "/" ? "index.html" : pedido;
  try {
    const cuerpo = await readFile(join(DIST, ruta));
    res.writeHead(200, { "content-type": TIPOS[extname(ruta)] ?? "application/octet-stream" });
    res.end(cuerpo);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://localhost:${port}/?modo=neuro`;

console.log(`Starting headless browser for Neuro-Lab test on ${url}...`);

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });

const errores = [];
page.on("pageerror", (e) => {
  console.error("PAGE ERROR:", e);
  errores.push(String(e));
});
page.on("console", (m) => {
  if (m.type() === "error") {
    if (m.text().includes("Failed to load resource") || m.text().includes("404")) return;
    console.error("CONSOLE ERROR:", m.text());
    errores.push(m.text());
  }
});

await page.goto(url, { waitUntil: "load", timeout: 30_000 });
await page.waitForSelector("#cerebro canvas", { timeout: 30_000 });
await page.waitForSelector("#juego canvas", { timeout: 30_000 });
await page.waitForTimeout(1500);

// Screenshot 1: Initial Neuro-Lab interface
await page.screenshot({ path: "pantalla-neuro-inicio.png" });
console.log("Captured pantalla-neuro-inicio.png");

// Start the sequencer by clicking the start button
console.log("Triggering start on sequencer...");
await page.click("#btnPlayNeuro");
await page.waitForTimeout(2000);

// Capture running sequencer with pulses
await page.screenshot({ path: "pantalla-neuro-secuenciador.png" });
console.log("Captured pantalla-neuro-secuenciador.png");

// Test switching to Split 50/50 view
console.log("Testing split 50/50 view...");
await page.click("#btnVistaDual");
await page.waitForTimeout(1000);
await page.screenshot({ path: "pantalla-neuro-split.png" });
console.log("Captured pantalla-neuro-split.png");

// Switch back to sidebar view
await page.click("#btnVistaNormal");
await page.waitForTimeout(500);

// Test pressing manual triggers: key 4 (WINGS) and key 5 (MDN)
console.log("Triggering manual channels [4] and [5]...");
await page.keyboard.press("4");
await page.keyboard.press("5");
await page.waitForTimeout(800);
await page.screenshot({ path: "pantalla-neuro-manual.png" });
console.log("Captured pantalla-neuro-manual.png");

await browser.close();
server.close();

console.log("All Neuro-Lab tests completed! Total errors:", errores.length);
if (errores.length > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
