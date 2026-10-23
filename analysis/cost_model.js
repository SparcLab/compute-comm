// Extracted from the Feature-Map Radio Budget page (feature_map_radio_budget.html, Version 2), 2026-10-16.
// Version 2 applies the BLE/Wi-R revision memo: background energy during compute, MCU sleep during DMA, 11-B LE 2M
// overhead, actual last connection event, completion latency, Wi-R copies for a delivery target, conversion efficiency,
// feasibility flags. The v1 extraction is kept in cost_model_v1.js.
;
const $ = id => document.getElementById(id);

// ---------- radio model (after Ixana's public power calculator, ixana.ai/resources/tools; revised October 2026) ----------
const TXSCALE = { "-20": 3.2 / 4.6, "-10": 3.6 / 4.6, "0": 1, "4": 5.9 / 4.6, "8": 9 / 4.6 };   // Ixana nRF52-class TX current vs power, relative to 0 dBm
// connOH: bytes on air besides the payload at LE 1M (preamble 1 + access address 4 + header 2 + CRC 3), no encryption MIC;
// LE 2M adds a second preamble byte. hdr: L2CAP (4 B) + ATT notification (3 B) headers inside the payload. ifs: inter-frame space (µs).
const BLE = { sleepI: .0019, procI: 3, rampUp: 130, postProc: 100, connOH: 10, ifs: 150, hdr: 7 };
const WIR = { normal: { txIc: .146, txIio: .981, ioV: 2.2 }, lp: { txIc: .194, txIio: .1, ioV: 1.8 }, coreV: 1.1, idleIc: .04, idleIio: 25e-5, dsIc: .0023, dsIio: 25e-5, wakeDeep: 2e3, wakeIdle: 10, settle: 10, oh: 40 };
const llOH = phy => BLE.connOH + (phy === 2 ? 1 : 0);

// One BLE connection event with the wearable (peripheral) sending n packets: ramp-up; n exchanges, each = receive the phone's
// empty packet, 150 µs, transmit header + payload; 150 µs between exchanges and none after the last; post-processing; radio
// sleep for the rest of the interval. pl = payload of each packet, plLast = payload of the last one (B).
// Returns energy (nJ), time to the end of the last packet (µs), and ok = false when the event overruns the interval.
function bleEv(c, n, pl, plLast = pl, intUs = 1e3 * c.int) {
  const o = llOH(c.phy), tb = 8 / c.phy, tRx = o * tb, tTx = ((n - 1) * (o + pl) + o + plLast) * tb, gaps = (2 * n - 1) * BLE.ifs;
  const done = BLE.rampUp + n * tRx + tTx + gaps, rest = intUs - done - BLE.postProc;
  const q = BLE.procI * (BLE.rampUp + gaps + BLE.postProc) + c.rxI * n * tRx + c.txI * tTx + c.sleepI * Math.max(rest, 0);
  return { E: q * c.V, done, ok: rest >= 0 };
}
const blePpe = c => Math.floor((1e3 * c.int - BLE.rampUp - BLE.postProc + BLE.ifs) / ((2 * llOH(c.phy) + c.pl) * 8 / c.phy + 2 * BLE.ifs));   // full exchanges that fit one interval
const bleEmpty = (c, intMs) => bleEv(c, 1, 0, 0, 1e3 * intMs).E;   // keep-alive: one empty exchange per interval (nJ, incl. radio sleep)

function wirPowers(c) {                      // mW at the rails (V × mA); wake time µs; legacy wake energy = 2 × sleep power × wake time (nJ), an assumption
  const o = WIR[c.mode], d = WIR.coreV, x = o.ioV, idle = WIR.idleIc * d + WIR.idleIio * x;
  const sleep = c.sm === "deep" ? WIR.dsIc * d + WIR.dsIio * x : idle, wake = c.sm === "deep" ? WIR.wakeDeep : WIR.wakeIdle;
  return { tx: o.txIc * d + o.txIio * x, idle, sleep, wake, wakeE: c.wakeE ?? 2 * sleep * wake };
}
// Wi-R has no acknowledgements, so recovery is blind: every packet is sent k times. A packet arrives with 1 − (1 − p)^k and the
// whole feature map of M packets with [1 − (1 − p)^k]^M (independent losses). k = fewest copies that meet the target, at most 10.
function wirCopies(M, p, tgt) {
  const pm = k => p >= 1 ? 1 : Math.exp(M * Math.log1p(-Math.pow(1 - p, k)));
  let k = 1; while (pm(k) < tgt && k < 10) k++;
  return { k, pm: pm(k), ok: pm(k) >= tgt };
}
// One feature map of `bits` over each link: energy (nJ), packets, times (s). Both modes use the same packet exchange;
// "periodic" sends one packet per interval, "bulk" fills each BLE connection event and sends Wi-R packets back to back.
function radio(bits, S) {
  if (bits <= 0) return { B: 0, nb: 0, att: 0, ev: 0, bE: 0, bT: 0, bRes: 0, bWait: 0, okRB: true, whyRB: "", nw: 0, kW: 1, pmW: 1, wE: 0, wT: 0, okRW: true, whyRW: "" };   // nothing sent: no wake-up
  const B = Math.ceil(bits / 8), c = S.b, w = S.w, P = S.wp, iv = c.int / 1e3;
  // BLE: payload − 7 B of data per packet, the last packet carries what is left. BLE acknowledges every packet, so a lost
  // packet is sent again: attempts = packets ÷ delivery. The last event carries only the attempts that are left.
  const app = c.pl - BLE.hdr, nb = Math.ceil(B / app), lastPl = B - (nb - 1) * app + BLE.hdr, att = Math.ceil(nb / c.eff);
  const ppe = S.mode === "bulk" ? S.bb.ppe : 1, ev = Math.ceil(att / ppe), full = bleEv(c, ppe, c.pl), last = bleEv(c, att - (ev - 1) * ppe, c.pl, lastPl);
  const okRB = S.bb.ok && full.ok && last.ok;
  // Wi-R: up to 255 B of data + 40 B header per packet, k copies of each
  const nw = Math.ceil(B / w.pl), cp = wirCopies(nw, w.eff, w.tgt), n = nw * cp.k, air = (n * WIR.oh + cp.k * B) * 8 / w.dr, wu = P.wake + WIR.settle + 6;
  let wE, wT, okI = true;
  if (S.mode === "periodic") {               // each packet: wake, settle, send, sleep until the next interval; impossible if the interval is shorter
    okI = 1e3 * w.int >= wu + 8 * (w.pl + WIR.oh) / w.dr;
    wE = S.acc === "ixana" ? P.tx * air : n * (P.wakeE + P.idle * (WIR.settle + 6)) + P.tx * air + P.sleep * Math.max(0, n * (1e3 * w.int - wu) - air);
    wT = n * w.int / 1e3;
  } else {                                   // one wake-up per burst; gaps only between packets
    wE = P.wakeE + P.idle * (WIR.settle + 6 + (n - 1) * w.gap) + P.tx * air;
    wT = (wu + air + (n - 1) * w.gap) / 1e6;
  }
  return { B, nb, att, ev, bE: (ev - 1) * full.E + last.E, bT: ((ev - 1) * 1e3 * c.int + last.done) / 1e6, bRes: ev * iv,
           bWait: { sync: 0, avg: iv / 2, worst: iv }[S.align] || 0, okRB, whyRB: okRB ? "" : "a connection event does not fit the connection interval",
           nw, kW: cp.k, pmW: cp.pm, wE, wT, okRW: okI && cp.ok,
           whyRW: !okI ? "the packet interval is shorter than wake-up + settle + send" : !cp.ok ? `10 copies of each packet still miss the ${+(w.tgt * 100).toPrecision(4)}% delivery target` : "" };
}
// ---------- wearable MCU ----------
// fp16/fp32: 2.2x slower and costlier than int8 (MLPerf Tiny v1.2, Bosch engine on STM32H7A3: float 0.34 vs int8 0.74 MACs/cycle); int4 has no native Cortex-M support
// float vs int8 cost, per core class. Cortex-M7: 1.9–3.9x on matched MLPerf Tiny benchmarks (STM32H7A3, IC/VWW geomean ≈2.25);
// Cortex-M4 with FPU ≈2.7 (PSoC 6); M33 assumed like M4; M0+/M23 have no FPU (software float, rough estimate); M55/M85 run fp16 natively.
function precFactor(core, bits) {
  if (bits <= 8) return 1;
  if (/M0\+|M23/.test(core)) return 20;
  if (/M55|M85/.test(core)) return bits === 16 ? 1.1 : 2.2;
  if (/M7/.test(core)) return 2.2;
  if (/M4|M33/.test(core)) return 2.7;
  return 2.2;
}
let curCore = "Cortex-M7", curInt = false;     // curInt: the selected MCU has a built-in BLE radio
const mcuE = (macs, S) => (S.m.pj ? macs * S.m.pj * 1e-3 : macs / S.m.mpc * S.m.ua * S.m.V * 1e-3) * S.m.pf;   // nJ  (µA/MHz × V = pJ per cycle)
const mcuT = (macs, S) => macs * S.m.pf / (S.m.mpc * S.m.mhz * 1e6);        // s

// ---------- formatting ----------
const fE = nj => nj <= 0 ? "0" : nj >= 1e9 ? (nj / 1e9).toPrecision(3) + " J" : nj >= 1e6 ? (nj / 1e6).toPrecision(3) + " mJ" : nj >= 1e3 ? (nj / 1e3).toPrecision(3) + " µJ" : nj.toPrecision(3) + " nJ";
const fT = s => s <= 0 ? "0" : s >= 3600 ? (s / 3600).toPrecision(3) + " h" : s >= 60 ? (s / 60).toPrecision(3) + " min" : s >= 1 ? s.toPrecision(3) + " s" : s >= 1e-3 ? (s * 1e3).toPrecision(3) + " ms" : (s * 1e6).toPrecision(3) + " µs";
const fB = bits => { const B = bits / 8; return B >= 1048576 ? (B / 1048576).toPrecision(3) + " MB" : B >= 1024 ? (B / 1024).toPrecision(3) + " KB" : Math.round(B) + " B"; };
const fN = n => n >= 1e9 ? (n / 1e9).toPrecision(3) + " G" : n >= 1e6 ? (n / 1e6).toPrecision(3) + " M" : n >= 1e3 ? (n / 1e3).toPrecision(3) + " K" : String(n);
const fR = kbps => kbps >= 1000 ? (kbps / 1000).toPrecision(3) + " Mbps" : kbps.toPrecision(3) + " kbps";
const fP = w => w <= 0 ? "0" : w >= 1e-3 ? (w * 1e3).toPrecision(3) + " mW" : w >= 1e-6 ? (w * 1e6).toPrecision(3) + " µW" : (w * 1e9).toPrecision(3) + " nW";
const fH = h => !isFinite(h) ? "∞" : h >= 24 * 365 ? (h / 24 / 365).toPrecision(3) + " years" : h >= 48 ? (h / 24).toPrecision(3) + " days" : h >= 1 ? h.toPrecision(3) + " h" : (h * 60).toPrecision(3) + " min";
const f2 = v => v >= 100 ? String(Math.round(v)) : v.toPrecision(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));


// ---------- MCU presets (datasheet numbers; MACs/cycle and pJ/MAC measured by MLPerf Tiny where available) ----------
const EST = { m0: [0.1, "estimate: Cortex-M0+/M23 class (MLPerf Tiny M0+ 0.06–0.13)"], m4: [0.6, "estimate: Cortex-M4 class (best MLPerf Tiny M4 stacks ≈ 0.6)"],
  m33: [0.69, "estimate: Cortex-M33 class (STM32U5/U3 measured 0.69)"], m55: [1.5, "rough estimate: Cortex-M55 + Helium (no MLPerf Tiny result; M85 measured 1.2–3.1)"] };
const PRESETS = [
  { id: "h7a3", sleep: 32, sleepSrc: "Stop mode, full RAM retained",  name: "STM32H7A3ZI", core: "Cortex-M7", mhz: 280, ua: 120, V: 3.3, mpc: 1.00, mpcSrc: "measured: MLPerf Tiny v1.4, STEdgeAI 4.0", pj: 478, flash: 2, sram: 1, src: "ST DS13195: 120 µA/MHz Run, SMPS, 3.3 V, 25 °C (…Q part). SRAM = 1 MB AXI block (1.4 MB total)." },
  { id: "u585", sleep: 8.95, sleepSrc: "Stop 2, full SRAM",  name: "STM32U585", core: "Cortex-M33", mhz: 160, ua: 19.5, V: 3.3, mpc: 0.69, mpcSrc: "measured on STM32U575 (same core): MLPerf Tiny v1.3, X-CUBE-AI 10.2", pj: 213, flash: 2, sram: 0.77, src: "ST DS13086: 19.5 µA/MHz @ 3.3 V (feature page; regulator not confirmed). MLPerf energy measured at 1.8 V." },
  { id: "u385", sleep: 2.2, sleepSrc: "Stop 3, full SRAM",  name: "STM32U385", core: "Cortex-M33", mhz: 96, ua: 16, V: 3.3, mpc: 0.69, mpcSrc: "measured: MLPerf Tiny v1.4, STEdgeAI 4.0", pj: 81, flash: 1, sram: 0.25, src: "ST datasheet: 16 µA/MHz CoreMark, SMPS, 96 MHz, 3.3 V. MLPerf energy measured at 1.8 V." },
  { id: "l4r5", sleep: 2.8, sleepSrc: "Stop 2 + RTC",  name: "STM32L4R5 (L4+)", core: "Cortex-M4F", mhz: 120, ua: 43, V: 3.3, mpc: 0.61, mpcSrc: "measured: MLPerf Tiny v1.4, STEdgeAI 4.0", pj: 440, flash: 2, sram: 0.625, src: "ST DS12023: 43 µA/MHz with SMPS variant (110 µA/MHz LDO). MLPerf energy at 3 V." },
  { id: "l476", sleep: 1.4, sleepSrc: "Stop 2 + RTC",  name: "STM32L476", core: "Cortex-M4F", mhz: 80, ua: 100, V: 3.3, est: "m4", flash: 1, sram: 0.125, src: "ST DS10198: 100 µA/MHz Run, LDO (no SMPS on this part)." },
  { id: "wba52", sleep: 0.9, sleepSrc: "Standby, 64 KB SRAM", ble: [5.2, 4.4],  name: "STM32WBA52 (BLE)", core: "Cortex-M33", mhz: 100, ua: 23, V: 3.3, est: "m33", flash: 1, sram: 0.125, src: "ST DS14127: 23 µA/MHz Run @ 3.3 V (feature page). Built-in BLE 5.4: TX 5.2 mA / RX 4.4 mA." },
  { id: "n52840", sleep: 3.16, sleepSrc: "System ON, full RAM + RTC", ble: [6.4, 6.26],  name: "nRF52840 (BLE)", core: "Cortex-M4F", mhz: 64, ua: 52, V: 3.0, est: "m4", flash: 1, sram: 0.25, src: "Nordic PS: 52 µA/MHz CoreMark from flash, DC/DC 3 V." },
  { id: "n5340", sleep: 1.3, sleepSrc: "System ON (full-RAM figure not published)", ble: [3.4, 2.7],  name: "nRF5340 app core (BLE)", core: "Cortex-M33", mhz: 128, ua: 60.8, V: 3.0, mpc: 0.28, mpcSrc: "measured: MLPerf Tiny v1.1, microTVM + CMSIS-NN (an older stack; optimized stacks reach ~0.69 on M33)", flash: 1, sram: 0.5, src: "Nordic PS: 66 CoreMark/mA at 128 MHz → ≈60.8 µA/MHz (calculated), DC/DC 3 V." },
  { id: "n54l15", sleep: 2.9, sleepSrc: "System ON, 256 KB RAM", ble: [4.8, 3.4],  name: "nRF54L15 (BLE)", core: "Cortex-M33", mhz: 128, ua: 20, V: 3.0, est: "m33", flash: 1.5, sram: 0.25, src: "Nordic Developer Academy: 20 µA/MHz CoreMark from NVM @128 MHz, 3 V (not the datasheet table)." },
  { id: "apollo3", sleep: 4.1, sleepSrc: "Deep Sleep, 384 KB retained", ble: [4.3, 3.2],  name: "Ambiq Apollo3 Blue (BLE)", core: "Cortex-M4F", mhz: 48, ua: 10.3, V: 3.3, est: "m4", flash: 1, sram: 0.375, src: "Ambiq DS-A3 Table 1203: 10.3 µA/MHz CoreMark @48 MHz, 3.3 V, buck (6 µA/MHz is the while-loop figure)." },
  { id: "apollo4", sleep: 13.6, sleepSrc: "Deep Sleep 2, 8 KB, at 1.9 V", ble: [5.2, 5.9],  name: "Ambiq Apollo4 Blue Plus (BLE)", core: "Cortex-M4F", mhz: 96, ua: 15.4, V: 1.9, est: "m4", flash: 2, sram: 2.75, src: "Ambiq datasheet Table 34: 15.4–17.2 µA/MHz CoreMark @96 MHz, 1.9 V, buck." },
  { id: "apollo510", sleep: 13.2, sleepSrc: "Deep Sleep, 160 KB, at 1.8 V",  name: "Ambiq Apollo510", core: "Cortex-M55", mhz: 250, ua: 26, V: 1.8, est: "m55", flash: 4, sram: 3.75, src: "Ambiq DS-A510 Table 39: 46.8 µW/MHz CoreMark @250 MHz, 1.8 V (≈26 µA/MHz)." },
  { id: "mg24", sleep: 2.9, sleepSrc: "EM2, full 256 KB", ble: [5.0, 4.4],  name: "SiLabs EFR32MG24 / BG24 (BLE, MVP)", core: "Cortex-M33 + MVP", mhz: 78, ua: 49.1, V: 3.0, mpc: 1.04, mpcSrc: "measured: MLPerf Tiny v1.0, TFLM + MVP accelerator", pj: 134, flash: 1.5, sram: 0.25, src: "SiLabs datasheet Table 4.5: 49.1 µA/MHz CoreMark @78 MHz, 3.0 V, DC-DC. MLPerf energy at 1.8 V." },
  { id: "bg22", sleep: 1.4, sleepSrc: "EM2, 32 KB", ble: [4.1, 3.6],  name: "SiLabs EFR32BG22 (BLE)", core: "Cortex-M33", mhz: 76.8, ua: 37, V: 3.0, est: "m33", flash: 0.5, sram: 0.03125, src: "SiLabs datasheet Table 4.5: 37 µA/MHz CoreMark @76.8 MHz, 3.0 V, DC-DC. Only 32 KB SRAM." },
  { id: "cc2340", sleep: 0.71, sleepSrc: "Standby, full RAM", ble: [5.1, 5.3],  name: "TI CC2340R5 (BLE)", core: "Cortex-M0+", mhz: 48, ua: 53, V: 3.0, est: "m0", flash: 0.5, sram: 0.0625, src: "TI SWRS272F §7.9: 53 µA/MHz CoreMark @48 MHz, 3.0 V, DC/DC." },
  { id: "cc2652", sleep: 0.94, sleepSrc: "Standby, 80 KB", ble: [7.0, 6.9],  name: "TI CC2652R (BLE)", core: "Cortex-M4F", mhz: 48, ua: 71, V: 3.0, est: "m4", flash: 0.344, sram: 0.078, src: "TI SWRS207J §8.5: 3.39 mA CoreMark @48 MHz, 3.0 V, DC/DC (71 µA/MHz)." },
  { id: "ra8m1", sleep: 900, sleepSrc: "Software Standby with all SRAM ≈0.9 mA",  name: "Renesas RA8M1", core: "Cortex-M85", mhz: 480, ua: 318, V: 3.3, mpc: 1.94, mpcSrc: "measured on RA8D1 (same M85 core): MLPerf Tiny v1.2, TFLM + CMSIS", flash: 2, sram: 1, src: "Renesas RA8M1 datasheet Table 2.19: 318 µA/MHz CoreMark, IDD (core supply) @480 MHz." },
  { id: "mcxn947", sleep: 5.2, sleepSrc: "Power Down, 512 KB",  name: "NXP MCX N947 (CPU only)", core: "Cortex-M33", mhz: 150, ua: 57, V: 3.3, est: "m33", flash: 2, sram: 0.5, src: "NXP datasheet Table 20: 9.19 mA while(1) @150 MHz, DCDC 3.3 V (≈57 µA/MHz). Its eIQ Neutron NPU is not modelled here." },
  { id: "alifb1", sleep: 0.45, sleepSrc: "STOP, 64 KB", ble: [2.0, 1.5],  name: "Alif Balletto B1 (BLE, CPU only)", core: "Cortex-M55", mhz: 160, ua: 22, V: 3.3, est: "m55", flash: 1.9, sram: 2, src: "Alif product page: 22 µA/MHz @ 3.3 V (workload not stated). Its Ethos-U55 NPU is not modelled here." },
];
let presetPj = null;
function applyPreset(id) {
  const p = PRESETS.find(x => x.id === id); if (!p) return;
  const mpc = p.mpc ?? EST[p.est][0];
  $("mHz").value = p.mhz; $("mUa").value = p.ua; $("mV").value = p.V; $("mMpc").value = mpc; $("mFlash").value = p.flash; $("mSram").value = p.sram;
  presetPj = p.pj || null; curCore = p.core; curInt = !!p.ble;
  $("sSleep").value = p.sleep;
  if (p.ble) { $("bTxI").value = p.ble[0]; $("bRxI").value = p.ble[1]; $("bV").value = p.id === "apollo4" ? 3.3 : p.V; $("bSrc").innerHTML = `BLE currents come from <b>${esc(p.name)}'s built-in radio</b> (datasheet values for transmit at 0 dBm and receive). A separate radio's sleep current is not added, because the chip's sleep current covers it. Radio timing and processing come from Ixana's nRF52-class model.`; }
  else { $("bTxI").value = 4.6; $("bRxI").value = 4.6; $("bV").value = 3.0; $("bSrc").innerHTML = `${esc(p.name)} has no radio, so BLE uses a separate <b>nRF52-class chip</b> (Ixana's values: 4.6 mA to transmit at 0 dBm, 4.6 mA to receive).`; }
  $("mName").textContent = p.name;
  $("mMeasF").hidden = !presetPj;
  $("mMeasTxt").innerHTML = presetPj ? `Use the measured <b>${presetPj} pJ per MAC</b> (MLPerf Tiny benchmark, whole chip including memory) instead of run current × voltage ÷ MACs per cycle` : "";
  $("mSrc").innerHTML = `<b>Sources.</b> Core: ${esc(p.core)}. Datasheet: ${esc(p.src)} MACs per cycle (${mpc}): ${esc(p.mpcSrc || EST[p.est][1])}. Sleep current (${p.sleep} µA): ${esc(p.sleepSrc)}.`;
}

// ---------- state ----------
let cur = 0, view = "split", current = null;
const cuts = {};
function num(id, lo, hi, dflt) { const v = parseFloat($(id).value); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
function settings() {
  const S = {
    inBits: +$("inBits").value, featBits: +$("featBits").value, mode: $("mode").value, acc: $("acc").value,
    m: { pj: (presetPj && $("mMeas").checked) ? presetPj : 0, mhz: num("mHz", 1, 2000, 280), ua: num("mUa", 1, 1e4, 120), V: num("mV", 1, 5, 3.3), mpc: num("mMpc", .01, 64, 1), flash: num("mFlash", 0, 1e4, 2), sram: num("mSram", 0, 1e4, 1), pf: precFactor(curCore, +$("featBits").value) },
    b: { tx: $("bTx").value, phy: +$("bPhy").value, int: num("bInt", 7.5, 4000, 30), pl: Math.round(num("bPl", 8, 251, 251)), ppe: Math.round(num("bPpe", 1, 100, 6)), V: num("bV", 1, 5, 3),
         txI: num("bTxI", .1, 100, 4.6) * TXSCALE[$("bTx").value], rxI: num("bRxI", .1, 100, 4.6), eff: num("bEff", 1, 100, 100) / 100 },
    w: { mode: $("wMode").value, dr: +$("wDr").value, pl: Math.round(num("wPl", 1, 255, 255)), sm: $("wSm").value, gap: num("wGap", 0, 1e6, 0), int: num("wInt", 1, 1e4, 30), eff: num("wEff", 1, 100, 100) / 100 },
    sys: { sleep: num("sSleep", 0, 1e5, 32), hm: $("sHm").value, host: num("sHost", 1, 2000, 16), link: num("sLink", .1, 1e3, 8), irq: num("sIrq", 0, 1e5, 20),
           idle: num("sIdle", 7.5, 4000, 30), eta: num("sEta", 1, 100, 85) / 100, q: num("sQ", 0, 1e4, 0), mah: num("sMah", 1, 1e6, 230), vb: num("sVb", 1, 20, 3) },
  };
  S.align = $("bAlign").value; S.b.sleepI = curInt ? 0 : BLE.sleepI;    // a built-in radio's sleep is already in the chip's sleep current
  S.w.tgt = num("wTgt", 1, 99.9999, 99) / 100;
  const wk = parseFloat($("wWake").value); S.w.wakeE = isFinite(wk) && wk >= 0 ? wk : null;
  return prep(S);
}
function prep(S) {                           // quantities that depend only on the settings
  const n = blePpe(S.b);
  S.bb = { ppe: Math.max(1, Math.min(S.b.ppe, n)), ok: n >= 1 };
  S.wp = wirPowers(S.w); S.bKA = bleEmpty(S.b, S.sys.idle);
  return S;
}

// MCU time awake (s) while a link sends n packets carrying `bytes`: the whole transfer (busy); a wake-up per packet plus the time
// to move the data over the MCU-to-radio link (svc); a wake-up per packet while DMA moves the data (dma)
const hostAwake = (S, span, n, bytes) => S.sys.hm === "busy" ? span : n * S.sys.irq / 1e6 + (S.sys.hm === "svc" ? 8 * bytes / (S.sys.link * 1e6) : 0);

function evaluate(r, S, per) {               // r: {ein, ef, macs, params, act}; energies in nJ per inference period `per` (s)
  const bits = r.ein * S.inBits + r.ef * S.featBits;
  const rad = radio(bits, S);
  const cE = mcuE(r.macs, S), cT = mcuT(r.macs, S);
  const wB = (r.params || 0) * S.featBits / 8, aB = (r.act || 0) * S.featBits / 8;
  const flashOk = wB <= S.m.flash * 1048576, sramOk = aB <= S.m.sram * 1048576;
  // Every component is accounted for over the whole period. MCU: compute, then the transfer (awake or asleep per the host
  // setting), asleep for the rest. BLE radio: the transfer's connection events (incl. their sleep), then keep-alive events for all
  // other time, compute included (long-run average). Wi-R: the transfer, then sleep for all other time, compute included.
  const runP = S.m.ua * S.sys.host * S.m.V * 1e3, sleepP = S.sys.sleep * S.m.V * 1e3;    // nJ per second (µA × V = µW)
  const host = (span, n, bytes) => { const t = n ? hostAwake(S, span, n, bytes) : 0; return { E: runP * Math.min(t, span) + sleepP * Math.max(span - t, 0), ok: t <= span }; };
  const hb = host(rad.bT, rad.att, rad.B / S.b.eff), hw = host(rad.wT, rad.nw * rad.kW, rad.B * rad.kW);
  const latB = cT + rad.bWait + rad.bT, latW = cT + rad.wT;
  const kaB = Math.max(0, per - rad.bRes) * 1e3 / S.sys.idle * S.bKA, kaW = S.wp.sleep * Math.max(0, per - rad.wT) * 1e6;
  const slB = sleepP * Math.max(0, per - cT - rad.bT), slW = sleepP * Math.max(0, per - cT - rad.wT);
  const railB = cE + rad.bE + hb.E + kaB + slB, railW = cE + rad.wE + hw.E + kaW + slW;
  // energy at the battery: the regulator's efficiency applied once to everything at the chip supplies, plus its quiescent draw
  const bat = e => e / S.sys.eta + S.sys.q * S.sys.vb * 1e3 * per, allB = bat(railB), allW = bat(railW);
  const late = `latency is longer than the ${fT(per)} between inferences`, slowH = "the MCU cannot feed the radio fast enough over its link";
  const whyB = [rad.whyRB, !hb.ok && slowH, latB > per ? late : cT + rad.bWait + rad.bRes > per && "the last reserved connection interval runs into the next inference"].filter(Boolean).join("; ");
  const whyW = [rad.whyRW, !hw.ok && slowH, latW > per && late].filter(Boolean).join("; ");
  const life = e => (S.sys.mah * 3.6 * S.sys.vb) / (e * 1e-9 / per) / 3600;   // hours on the battery
  return { ...r, bits, ...rad, cE, cT, wB, aB, flashOk, sramOk, fits: flashOk && sramOk,
           totB: cE + rad.bE, totW: cE + rad.wE, latB, latW, okB: !whyB, okW: !whyW, whyB, whyW,
           hB: hb.E, hW: hw.E, kaB, kaW, slB, slW, railB, railW, cvB: allB - railB, cvW: allW - railW, allB, allW,
           pB: allB * 1e-9 / per, pW: allW * 1e-9 / per, lifeB: life(allB), lifeW: life(allW) };
}


module.exports = { PRESETS, EST, BLE, WIR, prep, bleEv, blePpe, bleEmpty, wirPowers, wirCopies, radio, evaluate, mcuE, mcuT };
