"""Robustness of the placement results to model error, and anchoring of the compute model to MLPerf Tiny.

Reads results.json (per-cut energies at the reference BLE setting) and mlperf_tiny_computed.csv, next to this file or two folders up (published
MLPerf Tiny measurements), writes robustness.json, and prints the numbers quoted in the paper.

Error model. For each model-MCU pair and candidate cut k, node energy on link r is split into compute and the rest:
    E_k,r = f * C_k e_MAC + g_r * O_k,r
f scales the MCU's compute energy (per MCU); g_r scales everything the link causes (per link). Feasibility (memory,
task validity, deadline) is held at the reference values. f = g = 1 reproduces the reference placement.
"""
import csv, json, math, random
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = json.loads((HERE / 'results.json').read_text())
N = R['numbers']
PJ = {k: v['pj'] for k, v in N['pj'].items()}
MEAS = {k for k, v in N['pj'].items() if v['measured']}
MODELS = [m['id'] for m in R['profiles']]
MCUS = [p['id'] for p in R['presets']]
PRESET = {p['id']: p for p in R['presets']}
MIB = 1048576

cuts = {}
for c in R['cuts']:
    cuts.setdefault((c['model'], c['mcu']), []).append(c)

def choose(mid, pid, f=1.0, gB=1.0, gW=1.0):
    """Optimal cut index per link under scaled compute and link energy."""
    out = {}
    for L, g, ok in (('B', gB, 'okB'), ('W', gW, 'okW')):
        best = None
        for c in cuts[(mid, pid)]:
            if not (c['fits'] and c['taskValid'] and c[ok]): continue
            e = f * c['cE'] + g * (c['all' + L] - c['cE'])
            if best is None or e < best[0]: best = (e, c['k'], c['short'])
        out[L] = best
    return out

def reversal(o):
    return o['B'] and o['W'] and o['B'][1] > 0 and o['W'][1] == 0

def state(f_of=lambda p: 1.0, gB=1.0, gW=1.0):
    rev, wir_cut = set(), set()
    for mid in MODELS:
        for pid in MCUS:
            o = choose(mid, pid, f_of(pid), gB, gW)
            if reversal(o): rev.add(f'{mid}/{pid}')
            if o['W'] and o['W'][1] > 0: wir_cut.add(f'{mid}/{pid}')
    return rev, wir_cut

def bisect(pred, lo, hi, it=50):
    """Largest x in [lo, hi] (log scale) with pred(x) True, assuming pred is True at lo and monotone."""
    for _ in range(it):
        mid = math.sqrt(lo * hi)
        lo, hi = (mid, hi) if pred(mid) else (lo, mid)
    return lo

out = {}
# ---------- 0. reference reproduces the paper ----------
rev0, wcut0 = state()
assert len(rev0) == N['ref30']['reversals'] and not wcut0, (len(rev0), wcut0)
out['reference'] = {'reversals': sorted(rev0), 'wir_cut_pairs': len(wcut0)}

# ---------- 1. per-reversal margins (one factor at a time) ----------
margins = {}
for key in sorted(rev0):
    mid, pid = key.split('/')
    up = bisect(lambda f: reversal(choose(mid, pid, f=f)), 1.0, 100.0)          # compute costlier than modelled
    down = 1 / bisect(lambda x: reversal(choose(mid, pid, f=1 / x)), 1.0, 100.0)  # compute cheaper than modelled
    bdown = 1 / bisect(lambda x: reversal(choose(mid, pid, gB=1 / x)), 1.0, 100.0)  # BLE cheaper than modelled
    wup = bisect(lambda g: reversal(choose(mid, pid, gW=g)), 1.0, 1000.0)          # Wi-R costlier than modelled
    margins[key] = {'e_mac_up': up, 'e_mac_down': 1 / down, 'ble_down': 1 / bdown, 'wir_up': wup, 'measured_emac': pid in MEAS}
out['margins'] = margins

# ---------- 2. global: when does Wi-R start computing anywhere? ----------
f_wir = 1 / bisect(lambda x: not state(lambda p: 1 / x)[1], 1.0, 100.0)        # e_MAC overestimated by 1/f_wir
g_wir = bisect(lambda g: not state(gW=g)[1], 1.0, 1000.0)                        # Wi-R energy underestimated by g_wir
out['wir_all_offload'] = {'holds_until_e_mac_overestimated_by': 1 / f_wir, 'holds_until_wir_cost_underestimated_by': g_wir}

# ---------- 3. Monte Carlo ----------
def mc(F, G, n=4000, seed=1):
    rnd = random.Random(seed)
    nrev, allw, sfu = [], 0, 0
    for _ in range(n):
        fs = {p: math.exp(rnd.uniform(-math.log(F[1] if isinstance(F, tuple) else F), math.log(F[1] if isinstance(F, tuple) else F)))
              if not isinstance(F, tuple) else math.exp(rnd.uniform(math.log(F[0]), math.log(F[1]))) for p in MCUS}
        gB = math.exp(rnd.uniform(-math.log(G), math.log(G))); gW = math.exp(rnd.uniform(-math.log(G), math.log(G)))
        rev, wcut = state(lambda p: fs[p], gB, gW)
        nrev.append(len(rev)); allw += (not wcut); sfu += ('sleepfm/u385' in rev)
    nrev.sort()
    return {'n': n, 'reversals_median': nrev[n // 2], 'reversals_p5': nrev[int(.05 * n)], 'reversals_p95': nrev[int(.95 * n)],
            'p_any_reversal': sum(x > 0 for x in nrev) / n, 'p_wir_offloads_all': allw / n, 'p_sleepfm_u385_reverses': sfu / n}
out['monte_carlo'] = {'x2_compute_x2_links': mc(2.0, 2.0),
                      'mlperf_calibrated_compute_x2_links': mc((0.86, 1.51), 2.0)}

# ---------- 4. memory proxy sensitivity ----------
mem = {}
for scale in (2.0, 4.0):
    lost = []
    for key in sorted(rev0):
        mid, pid = key.split('/')
        cut = next(c for c in cuts[(mid, pid)] if c['k'] == choose(mid, pid)['B'][1])
        p = PRESET[pid]
        if not (cut['params'] * scale <= p['flash'] * MIB and cut['act'] * scale <= p['sram'] * MIB): lost.append(key)
    mem[f'x{scale:g}'] = lost
out['memory_scale_lost_reversals'] = mem

# ---------- 5. compute model vs. MLPerf Tiny measurements ----------
csv_path = next(p for p in (HERE / 'mlperf_tiny_computed.csv', HERE.parents[1] / 'mlperf_tiny_computed.csv') if p.exists())
mlp = list(csv.DictReader(open(csv_path)))
anchor = {'u385': ('NUCLEO_U385RG_Q', 'v1.4'), 'h7a3': ('NUCLEO_H7A3ZI_Q', 'v1.4'), 'l4r5': ('NUCLEO_L4R5ZI-P', 'v1.4'), 'u585': ('NUCLEO_U575ZI_Q', 'v1.3')}
val = {}
for pid, (sysname, ver) in anchor.items():
    rows = [x for x in mlp if x['system'] == sysname and x['ver'] == ver]
    val[pid] = {x['bm']: float(x['pJ_per_MAC']) / PJ[pid] for x in rows}   # measured / modelled energy for that benchmark
allr = [r for v in val.values() for r in v.values()]
out['mlperf_validation'] = {'ratio_measured_over_model': val, 'min': min(allr), 'max': max(allr), 'n': len(allr),
                            'conv_only_range': [min(v[b] for v in val.values() for b in ('ic', 'vww')), max(v[b] for v in val.values() for b in ('ic', 'vww'))],
                            'dense_ad_range': [min(v['ad'] for v in val.values()), max(v['ad'] for v in val.values())]}

(HERE / 'robustness.json').write_text(json.dumps(out, indent=2))

# ---------- print ----------
print('reference reversals:', len(rev0))
print('\nper-reversal margins (factor of model error the reversal tolerates):')
print(f"{'pair':22s} {'e_MAC up':>9s} {'e_MAC down':>11s} {'BLE cheaper':>12s} {'Wi-R costlier':>14s}")
for k, m in margins.items():
    print(f"{k:22s} {m['e_mac_up']:9.2f} {m['e_mac_down']:11.2f} {m['ble_down']:12.2f} {m['wir_up']:14.2f}{'  (measured e_MAC)' if m['measured_emac'] else ''}")
print('\nWi-R offloads all 114 until e_MAC overestimated by %.2fx or Wi-R cost underestimated by %.2fx' % (1 / f_wir, g_wir))
for name, r in out['monte_carlo'].items(): print('MC', name, r)
print('memory proxy x2 / x4 loses:', mem)
v = out['mlperf_validation']; print('MLPerf measured/model ratio: %.2f-%.2f over %d benchmarks; conv-only %.2f-%.2f; dense AD %.2f-%.2f'
      % (v['min'], v['max'], v['n'], *v['conv_only_range'], *v['dense_ad_range']))
for pid, d in val.items(): print('  ', pid, {k: round(x, 2) for k, x in d.items()})
