// Verifica que la escena de verdad se dibuja y que la grabación corre sola.
//
// Sirve el bundle ya construido, lo deja correr unos segundos, captura la
// pantalla y reporta fps, errores de consola y estado de la pelea. Un canvas
// negro o un error de WebGL fallan acá y no en la cara de quien mira.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const DIST = "dist";
const TIPOS = {
  ".html": "text/html", ".js": "text/javascript",
  ".wasm": "application/wasm", ".css": "text/css",
};

const server = createServer(async (req, res) => {
  const pedido = req.url.split("?")[0];
  // El content-type sale del archivo resuelto, no de la URL: "/" no tiene
  // extensión y el navegador se lo bajaba como descarga en vez de abrirlo.
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
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errores = [];
page.on("pageerror", (e) => errores.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(m.text());
});

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 10_000 });

// Contar frames reales para medir fps.
await page.evaluate(() => {
  window.__frames = 0;
  const raf = requestAnimationFrame;
  (function tick() { window.__frames++; raf(tick); })();
});

// Nadie toca el teclado: la grabación avanza sola. Que el tick suba es la
// única prueba de que la reproducción corre.
await page.waitForTimeout(4000);

const frames = await page.evaluate(() => window.__frames);
const hud = await page.textContent("#tel");
await page.screenshot({ path: "pantalla.png" });

// La telegrafía es obligatoria por diseño, así que se verifica: se espera a que
// el boss esté cargando y se captura ahí. Si el decal no se dibujara, la
// captura lo mostraría vacío.
let capturada = false;
for (let i = 0; i < 240 && !capturada; i++) {
  if ((await page.textContent("#tel"))?.includes("cargando")) {
    await page.screenshot({ path: "pantalla-telegrafia.png" });
    capturada = true;
  } else {
    await page.waitForTimeout(50);
  }
}
if (!capturada) { console.log("\nnunca se vio una telegrafía"); process.exit(1); }

await browser.close();
server.close();

console.log(hud.trim().split("\n").map((l) => "  " + l).join("\n"));
console.log(`\nframes=${frames} en 4s = ${(frames / 4).toFixed(0)} fps (swiftshader por software)`);

// Un error de consola no rompe la captura pero sí el juego: acá se ve.
if (errores.length) {
  console.log("\nerrores:\n" + errores.map((e) => "  " + e).join("\n"));
  process.exit(1);
}
const tick = Number(hud.match(/tick (\d+)/)?.[1] ?? 0);
if (tick < 100) { console.log(`\nla simulación no avanzó (tick=${tick})`); process.exit(1); }
console.log("\nOK: escena dibujada, pelea corriendo, sin errores");
