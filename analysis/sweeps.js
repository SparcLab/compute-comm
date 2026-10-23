// Sweeps quoted on the project page under "How sure is this?": BLE keep-alive interval, packet delivery on both links,
// and an fp32 model instead of int8. Same reference settings as reproduce.js; writes sweeps.json. Node.js, no packages.
const fs = require('fs'), path = require('path');
const {PRESETS, EST, BLE, prep, evaluate} = require('./cost_model');
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'model_profiles.json')));
// float vs int8 cost per MAC, per core class (same factors as the page's precFactor)
const pfOf = (core, bits) => bits <= 8 ? 1 : /M0\+|M23/.test(core) ? 20 : /M55|M85/.test(core) ? (bits === 16 ? 1.1 : 2.2) : /M7/.test(core) ? 2.2 : /M4|M33/.test(core) ? 2.7 : 2.2;
function configure(p, o = {}, featBits = 8) {         // reproduce.js configure(), plus the model format
  const S = {inBits: 16, featBits, mode: 'bulk', acc: 'full', align: 'sync',
    m: {pj: p.pj || 0, mhz: p.mhz, ua: p.ua, V: p.V, mpc: p.mpc || (EST[p.est][0]), flash: p.flash, sram: p.sram, pf: pfOf(p.core, featBits)},
    b: {tx: '0', phy: 2, int: 30, pl: 251, ppe: 6, V: p.ble ? (p.id === 'apollo4' ? 3.3 : p.V) : 3, txI: p.ble ? p.ble[0] : 4.6, rxI: p.ble ? p.ble[1] : 4.6, eff: 1, sleepI: p.ble ? 0 : BLE.sleepI},
    w: {mode: 'normal', dr: 5, pl: 255, sm: 'deep', gap: 0, int: 30, eff: 1, tgt: 0.99, wakeE: null},
    sys: {sleep: p.sleep, hm: 'busy', host: 16, link: 8, irq: 20, idle: 30, eta: 1, q: 0, mah: 230, vb: 3}};
  for (const [k, v] of Object.entries(o)) S[k] = typeof v === 'object' ? {...S[k], ...v} : v;
  return prep(S);
}
const rows = (m, S) => m.splits.map((r, k) => { const x = evaluate(r, S, m.period_s); x.taskValid = !(m.id === 'sleepfm' && k === m.splits.length - 1); x.k = k; return x; });
const best = (R, L) => R.filter(r => r.fits && r.taskValid && r['ok' + L]).reduce((a, r) => !a || r['all' + L] < a['all' + L] ? r : a, null);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function sweep(o, featBits = 8) {
  let computeFirstBLE = 0, computeFirstWiR = 0, wirRawLowest = 0; const ratio = [], bleCheaper = [];
  for (const p of PRESETS) { const S = configure(p, o, featBits); for (const m of D.models) {
    const R = rows(m, S), bB = best(R, 'B'), bW = best(R, 'W');
    if (bB && bB.k > 0) computeFirstBLE++; if (bW && bW.k > 0) computeFirstWiR++;
    if (bB && bW) { const r = bB.allB / R[0].allW; ratio.push(r);
      if (bW.k === 0 && r > 1) wirRawLowest++; else if (r <= 1) bleCheaper.push({model: m.id, mcu: p.id, bleOverWiR: +r.toFixed(3)}); } } }
  return {computeFirstBLE, computeFirstWiR, wirRawLowest, pairs: PRESETS.length * D.models.length,
          medianBestBLEoverWiRraw: +median(ratio).toFixed(2), bleCheaper};
}
const out = {
  about: 'Pairs (of 114) where computing first wins over BLE / over Wi-R, pairs where Wi-R raw streaming is the lowest of all options, and the median of best-BLE energy / Wi-R raw energy.',
  bleKeepAlive: {ms30: sweep({}), ms1000: sweep({sys: {idle: 1000}}), ms4000: sweep({sys: {idle: 4000}})},
  packetDelivery: Object.fromEntries([1, 0.99, 0.95, 0.9, 0.8].map(d => [`p${d}`, sweep({b: {eff: d}, w: {eff: d}})])),
  fp32Model: sweep({}, 32),
};
fs.writeFileSync(path.join(__dirname, 'sweeps.json'), JSON.stringify(out, null, 1));
const brief = (k, r) => console.log(k.padEnd(18), `BLE ${r.computeFirstBLE}  Wi-R ${r.computeFirstWiR}  Wi-R raw lowest ${r.wirRawLowest}/${r.pairs}  median ${r.medianBestBLEoverWiRraw}x`);
for (const [k, v] of Object.entries(out.bleKeepAlive)) brief('keep-alive ' + k, v);
for (const [k, v] of Object.entries(out.packetDelivery)) brief('delivery ' + k, v);
brief('fp32', out.fp32Model);
