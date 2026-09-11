// Una pelea grabada → video .mp4, cuadro por cuadro.
//
// En tiempo real no sirve: con WebGL por software el navegador dibuja ~8
// cuadros por segundo y el video sale a saltos. Acá el reloj del navegador lo
// maneja Playwright: cada cuadro avanza exactamente 1/FPS s de juego, se
// captura, y va directo a ffmpeg por un pipe. El resultado es a velocidad real
// y fluido, tarde lo que tarde en generarse.
//
//   node video.mjs espinal            # con el servidor de ./scripts/dev.sh
//   node video.mjs mosca 30 mosca.mp4 # nombre, cuadros por segundo, salida
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const [pelea = "espinal", fps = "30", salida = `${pelea}.mp4`] = process.argv.slice(2);
const FPS = Number(fps);
const URL = process.env.URL ?? `http://localhost:5173/?pelea=${pelea}`;

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errores = [];
page.on("pageerror", (e) => errores.push(String(e)));

await page.clock.install({ time: 0 });
await page.goto(URL, { waitUntil: "networkidle" });
// Sin esperar: con el reloj congelado, el HUD aparece recién cuando el reloj
// avanza, y `textContent` se quedaría esperándolo.
const leer = () => page.evaluate(() => document.querySelector("#tel")?.textContent ?? "");
// Hasta que la grabación (y el panel del cerebro) terminen de cargar, el reloj
// avanza de a un cuadro sin capturar.
for (let i = 0; i < 600 && !/tick \d+ \/ \d+/.test(await leer()); i++) {
  await page.clock.runFor(1000 / FPS);
}
const total = Number((await leer()).match(/tick \d+ \/ (\d+)/)?.[1] ?? 0);
if (!total) throw new Error(`la grabación ${pelea} no cargó: ${errores.join("; ")}`);

const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS),
  "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", salida], { stdio: ["pipe", "inherit", "inherit"] });

// La captura va por CDP y no por `page.screenshot`, que espera un
// requestAnimationFrame de la página: con el reloj falso ese cuadro no llega y
// se colgaba a los 18 cuadros.
const cdp = await page.context().newCDPSession(page);
let tick = 0, cuadros = 0;
const t0 = Date.now();
while (tick < total) {
  await page.clock.runFor(1000 / FPS);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  const jpg = Buffer.from(data, "base64");
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  tick = Number((await leer()).match(/tick (\d+)/)?.[1] ?? tick);
  if (++cuadros % 150 === 0) {
    console.log(`  tick ${tick} / ${total} · ${((Date.now() - t0) / cuadros).toFixed(0)} ms por cuadro`);
  }
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log(`${salida}: ${cuadros} cuadros a ${FPS} fps = ${(cuadros / FPS).toFixed(0)} s de pelea`);
if (errores.length) console.log("errores:\n  " + errores.join("\n  "));
