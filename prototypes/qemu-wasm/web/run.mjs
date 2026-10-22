// Drives web/index.html in headless Chromium and prints the guest's serial console.
// usage: node run.mjs <arch> [smp] [timeout-seconds]   (env: QS="&verbose=1", PUSH=<file>, PORT)
// Stops at "=== DONE", or 45 s after the guest prints "WATCHDOG".
import fs from "node:fs";
import { chromium } from "playwright-core";

const [arch, smp = "4", timeoutS = "600"] = process.argv.slice(2);
const port = process.env.PORT || "8090";
const exe = process.env.CHROMIUM ||
  `/opt/pw-browsers/${fs.readdirSync("/opt/pw-browsers").find((d) => d.startsWith("chromium-"))}/chrome-linux/chrome`;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[console.${m.type()}]`, m.text()); });
const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1);
await page.goto(`http://127.0.0.1:${port}/index.html?arch=${arch}&smp=${smp}${process.env.QS || ""}`);
let printed = 0, pushed = false, watchdogAt = 0, lastChange = Date.now(), dumped = false;
// With HANGDUMP=<seconds>, a console silent that long is treated as a hang: switch the
// serial mux to the QEMU monitor (Ctrl-A c) and print each vCPU's state.
const hangAfter = Number(process.env.HANGDUMP || 0) * 1000;
async function monitor(cmd) {
  await page.keyboard.type(cmd); await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 3000));
}
while (Date.now() - t0 < timeoutS * 1000) {
  const out = await page.evaluate(() => window.__out);
  if (out.length > printed) { process.stdout.write(out.slice(printed)); printed = out.length; lastChange = Date.now(); }
  if (hangAfter && !dumped && Date.now() - lastChange > hangAfter) {
    dumped = true;
    console.log(`\n[host] no console output for ${hangAfter / 1000} s`);
    console.log("[host] dumping vCPU state");
    await page.click("#terminal");
    await page.keyboard.press("Control+a"); await page.keyboard.press("c");
    await new Promise((r) => setTimeout(r, 1000));
    await monitor("info cpus");
    await monitor("info registers -a");
    for (let c = 0; c < 8; c++) { await monitor(`cpu ${c}`); await monitor("x/6i $pc"); }
    // Then pause every worker (one per QEMU thread) through the DevTools protocol and
    // print its stack; a build linked with --profiling-funcs gives function names.
    const cdp = await browser.newBrowserCDPSession();
    const replies = new Map(); let next = 1;
    cdp.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      const m = JSON.parse(message);
      if (m.id && replies.has(sessionId + ":" + m.id)) replies.get(sessionId + ":" + m.id)(m);
      if (m.method === "Debugger.paused") {
        console.log(`--- thread ${sessionId.slice(0, 6)} stack:`);
        for (const f of m.params.callFrames.slice(0, 25)) console.log("   ", f.functionName || "(anon)", f.url.split("/").pop(), f.location.lineNumber + ":" + f.location.columnNumber);
      }
    });
    const send = (sessionId, method, params = {}) => new Promise((res) => {
      const id = next++; replies.set(sessionId + ":" + id, res);
      cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) });
      setTimeout(() => res({ timeout: true }), 5000);
    });
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "worker")) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: false });
      await send(sessionId, "Debugger.enable");
      const r = await send(sessionId, "Debugger.pause");
      console.log(`--- worker ${t.url.split("/").pop()} session ${sessionId.slice(0, 6)} pause: ${r.timeout ? "no answer (blocked?)" : "ok"}`);
    }
    await new Promise((r) => setTimeout(r, 6000));
    const rest = await page.evaluate(() => window.__out);
    process.stdout.write(rest.slice(printed)); printed = rest.length;
    break;
  }
  if (process.env.PUSH && !pushed && out.includes("waiting for host")) {
    pushed = true;
    const bytes = [...fs.readFileSync(process.env.PUSH)];
    await page.evaluate((b) => { window.__push("prog", b); window.__push("go", [49]); }, bytes);
  }
  if (out.includes("WATCHDOG") && !watchdogAt) watchdogAt = Date.now();
  if (watchdogAt && Date.now() - watchdogAt > 45000) break;
  if (out.includes("=== DONE") || out.includes("init failed")) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`\n[host] ${since()} s`);
await browser.close();
