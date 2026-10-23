// Reproduce the manuscript's analytical results. Node.js, no npm dependencies.
const fs = require('fs');
const path = require('path');
const {PRESETS,EST,BLE,prep,evaluate,mcuE} = require('./cost_model');   // Version 2 model; reproduce_v1.js reruns the v1 model
const D = JSON.parse(fs.readFileSync(path.join(__dirname,'model_profiles.json')));

// Correction 3: count AttX raw input on the same 10-s window as its features. The frozen profile
// sends only the new 4 s per hop, while every feature cut covers the full window.
// model_profiles.json now stores this directly (the same data the website embeds), so no runtime change is needed.

function configure(p, overrides={}) {
  const S={inBits:16,featBits:8,mode:'bulk',acc:'full',align:'sync',
    m:{pj:p.pj||0,mhz:p.mhz,ua:p.ua,V:p.V,mpc:p.mpc||(EST[p.est][0]),flash:p.flash,sram:p.sram,pf:1},
    b:{tx:'0',phy:2,int:30,pl:251,ppe:6,V:p.ble?(p.id==='apollo4'?3.3:p.V):3,txI:p.ble?p.ble[0]:4.6,rxI:p.ble?p.ble[1]:4.6,eff:1,
       sleepI:p.ble?0:BLE.sleepI},          // a built-in radio's sleep is already in the chip's sleep current
    w:{mode:'normal',dr:5,pl:255,sm:'deep',gap:0,int:30,eff:1,tgt:0.99,wakeE:null},
    // Energies are reported at the chip supplies (eta = 1), as in Eq. (2); numbers.battery gives them at the
    // battery through an 85% regulator. Correction 4 (link background during compute) is now part of the model.
    sys:{sleep:p.sleep,hm:'busy',host:16,link:8,irq:20,idle:30,eta:1,q:0,mah:230,vb:3}};
  for(const [k,v] of Object.entries(overrides)) S[k] = typeof v==='object'?{...S[k],...v}:v;
  return prep(S);
}
function rows(m,S) {
  const R = m.splits.map((r,k)=>{
    const x=evaluate(r,S,m.period_s);
    // A five-minute pooled SleepFM vector does not preserve the temporal
    // representation consumed by the selected downstream heads.
    x.taskValid=!(m.id==='sleepfm'&&k===m.splits.length-1);
    x.k=k;
    return x;
  });
  // Eq. (4): break-even compute energy against input offloading (pJ/MAC), and the
  // model-only compression efficiency rho_k = (B_0 - B_k) / C_k (bits per MAC).
  const r0 = R[0];
  for (const x of R) {
    x.rho = x.macs > 0 ? (r0.bits - x.bits) / x.macs : null;
    x.ecritB = x.macs > 0 ? (r0.allB - (x.allB - x.cE)) / x.macs * 1e3 : null;
    x.ecritW = x.macs > 0 ? (r0.allW - (x.allW - x.cE)) / x.macs * 1e3 : null;
  }
  return R;
}
function best(R,link) {
  return R.filter(r=>r.fits&&r.taskValid&&r['ok'+link]).reduce((a,r)=>!a||r['all'+link]<a['all'+link]?r:a,null);
}
const SETTINGS = {
  ref30: {label:'Reference: 6 BLE packets per event, 30-ms keep-alive, MCU awake while sending', over:{}},
  idle1s: {label:'1-s BLE keep-alive between inferences', over:{sys:{idle:1000}}},
  fair4sDMA: {label:'4-s BLE keep-alive; DMA feeds the radio (MCU asleep, wakes per packet)', over:{sys:{idle:4000,hm:'dma'}}},
  ble21: {label:'21 BLE packets per connection event', over:{b:{ppe:21}}},
  hostSvc: {label:'MCU awake only to hand each packet to the radio (20 µs + 8-Mb/s link)', over:{sys:{hm:'svc'}}},
};
const result={provenance:{url:'https://moonlit-gaufre-ac3789.netlify.app/',retrieved:'2026-10-06',source:D.meta,
  status:'Analytical estimates; no hardware or trained-model validation performed.',
  model:'Feature-Map Radio Budget Version 2 (2026-10-16); results_v1.json holds the v1 model.',
  corrections:['Exclude task-incompatible final SleepFM temporal pooling.','Include MCU sleep energy during DMA-mode transmission.',
    'Count AttX raw input on the full 10-s window, consistent with its feature cuts.',
    'Charge BLE connection maintenance and Wi-R sleep during computation as well as idle time.',
    'v2: 11-B packet overhead at LE 2M; no trailing inter-frame space; last connection event charged for its actual packets.',
    'v2: transfer time to the last packet instead of whole connection intervals; reserved intervals must fit the period.',
    'v2: no separate radio sleep current for MCUs with a built-in BLE radio.',
    'v2: Wi-R losses recovered by blind copies chosen for a whole-map delivery target.']},
  presets:PRESETS,profiles:D.models,settings:{},default:{},matrix:[],matrices:{},cuts:[],sensitivity:[]};
const keep = x => ({k:x.k,short:x.short,label:x.label,bits:x.bits,macs:x.macs,params:x.params,act:x.act,fits:x.fits,taskValid:x.taskValid,
  okB:x.okB,okW:x.okW,cE:x.cE,allB:x.allB,allW:x.allW,rho:x.rho,ecritB:x.ecritB,ecritW:x.ecritW});
for (const [sid,{label,over}] of Object.entries(SETTINGS)) {
 result.settings[sid]=label; const mat=[];
 for(const p of PRESETS) {
  const S=configure(p,over);
  for(const m of D.models){
   const R=rows(m,S),b=best(R,'B'),w=best(R,'W');
   mat.push({mcu:p.id,model:m.id,pj:mcuE(1,S)*1e3,measured:!!p.pj,
     ble:b&&{k:b.k,label:b.label,short:b.short,energy_mJ:b.allB/1e6},wir:w&&{k:w.k,label:w.label,short:w.short,energy_mJ:w.allW/1e6}});
   if(sid==='ref30'){
    if(['u385','h7a3','apollo510'].includes(p.id)){result.default[p.id]??={};result.default[p.id][m.id]={settings:S,rows:R};}
    for(const x of R) result.cuts.push({mcu:p.id,model:m.id,...keep(x)});
   }
  }
 }
 result.matrices[sid]=mat;
}
result.matrix=result.matrices.ref30;

const p=PRESETS.find(p=>p.id==='u385'),m=D.models.find(m=>m.id==='sleepfm');
for(const [label,changes] of [
 ['Default',{}],
 ['DMA; 1-s BLE idle interval',{sys:{hm:'dma',idle:1000}}],
 ['DMA; 1-s BLE idle; 7.5-ms bulk CI',{sys:{hm:'dma',idle:1000},b:{int:7.5,ppe:100}}],
 ['DMA; 4-s BLE idle interval',{sys:{hm:'dma',idle:4000}}],
 ['BLE 21 packets per event',{b:{ppe:21}}],
 ['MCU awake only to hand packets over',{sys:{hm:'svc'}}],
 ['BLE random first-event wait',{align:'avg'}],
 ['Half compute energy',{m:{pj:40.5}}],
 ['Twice compute energy',{m:{pj:162}}],
 ['Wi-R 2.5 Mbps',{w:{dr:2.5}}],
 ['Wi-R 1 Mbps',{w:{dr:1}}],
 ['Wi-R low-power mode',{w:{mode:'lp'}}],
 ['Wi-R wake-up energy 100x legacy',{w:{wakeE:1232}}],
 ['Wi-R 99.9% per-packet delivery, 99% map target',{w:{eff:0.999}}],
 ['Wi-R 99% per-packet delivery, 99% map target',{w:{eff:0.99}}]
]) {
 const S=configure(p,changes),R=rows(m,S);
 result.sensitivity.push({label,settings:S,rawB_mJ:R[0].allB/1e6,rawW_mJ:R[0].allW/1e6,tokB_mJ:R[7].allB/1e6,tokW_mJ:R[7].allW/1e6,
  ecritB:R[7].ecritB,ecritW:R[7].ecritW,bestB:best(R,'B').label,bestW:best(R,'W').label});
}
const R=result.default.u385.sleepfm.rows;
result.breakEven={B:R[7].ecritB,W:R[7].ecritW};

// ---------- numbers quoted in the manuscript ----------
const N={};
const sum=(sid)=>{const a=result.matrices[sid],rev=a.filter(x=>x.ble.k>0&&x.wir.k===0),ratio=a.map(x=>x.ble.energy_mJ/x.wir.energy_mJ);
  const per={};for(const mm of D.models){const r=a.filter(x=>x.model===mm.id).map(x=>x.ble.energy_mJ/x.wir.energy_mJ);per[mm.id]=[Math.min(...r),Math.max(...r)];}
  return {reversals:rev.length,reversalCells:rev.map(x=>`${x.model}/${x.mcu}/${x.ble.short}`),wirInput:a.filter(x=>x.wir.k===0).length,
    bleSplit:a.filter(x=>x.ble.k>0).length,ratioMin:Math.min(...ratio),ratioMax:Math.max(...ratio),ratioPerModel:per,
    reversalsOnMeasured:rev.filter(x=>x.measured).length};};
for(const sid of Object.keys(SETTINGS)) N[sid]=sum(sid);
// Effective all-in energy per bit (slope between raw and tokens, SleepFM / STM32U385) and radio-only slope.
const tok=R[7],raw=R[0],dB=raw.bits-tok.bits;
N.ebit={BLE_allin:((raw.allB-tok.allB)+tok.cE)/dB,WiR_allin:((raw.allW-tok.allW)+tok.cE)/dB,BLE_radio:(raw.bE-tok.bE)/dB,WiR_radio:(raw.wE-tok.wE)/dB};
N.ebitAcross={};   // spread of the all-in BLE and Wi-R slopes across presets (SleepFM raw vs tokens)
for(const L of ['B','W']){const v=result.cuts.filter(c=>c.model==='sleepfm'&&c.k===7).map(c=>c.ecritB!==null?(L==='B'?c.ecritB:c.ecritW)/c.rho/1e3:null);N.ebitAcross[L]=[Math.min(...v),Math.max(...v)];}
N.sleepfm_u385={rawB:raw.allB/1e6,tokB:tok.allB/1e6,rawW:raw.allW/1e6,tokW:tok.allW/1e6,tokCompute:tok.cE/1e6,
  radioOnly:{rawB:(raw.cE+raw.bE)/1e6,tokB:(tok.cE+tok.bE)/1e6,rawW:(raw.cE+raw.wE)/1e6,tokW:(tok.cE+tok.wE)/1e6},
  pW_raw_uW:raw.allW/1e6/300*1e3,pW_tok_uW:tok.allW/1e6/300*1e3,ecritB:tok.ecritB,ecritW:tok.ecritW,
  poolB:(()=>{const o=i=>R[i].allB-R[i].cE;return (o(7)-o(8))/(R[8].macs-R[7].macs)*1e3;})(),
  poolW:(()=>{const o=i=>R[i].allW-R[i].cE;return (o(7)-o(8))/(R[8].macs-R[7].macs)*1e3;})()};
const E5=result.default.apollo510.esn.rows;
N.esn_apollo510={rawB:E5[0].allB/1e6,cnnB:E5[3].allB/1e6,rawW:E5[0].allW/1e6,cnnW:E5[3].allW/1e6,cnnCompute:E5[3].cE/1e6,ecritB:E5[3].ecritB,ecritW:E5[3].ecritW};
const EH=result.default.h7a3.esn.rows;
N.esn_h7a3={cnnCompute:EH[3].cE/1e6,rawB:EH[0].allB/1e6,rawW:EH[0].allW/1e6,bitsRaw:EH[0].bits,bitsCnn:EH[3].bits,macs:EH[3].macs};
const AU=result.default.u385.attx_vgg.rows,AL=AU[AU.length-1];
N.attx_u385={rawB:AU[0].allB/1e6,rawW:AU[0].allW/1e6,fullCompute:AL.cE/1e6,ecritB:AL.ecritB,ecritW:AL.ecritW,conv1x:AU[1].bits/AU[0].bits};

// Table II: per model, the task-valid cut with the highest BLE break-even on the STM32U385 link.
const fullIdx=mm=>mm.splits.length-(mm.id==='sleepfm'?2:1);
N.table2=D.models.map(mm=>{
  const rr=result.cuts.filter(c=>c.mcu==='u385'&&c.model===mm.id);
  const cand=rr.filter(c=>c.taskValid&&c.macs>0&&c.k<=fullIdx(mm));
  const b=cand.reduce((a,c)=>!a||c.ecritB>a.ecritB?c:a,null);
  const Cfull=mm.splits[fullIdx(mm)].macs;
  const prof=mm.splits.map(s=>s.ein*16+s.ef*8);
  const firstCmp=mm.splits.findIndex((s,k)=>k>0&&prof[k]<prof[0]);
  return {model:mm.id,name:mm.name,period:mm.period_s,B0:rr[0].bits,cut:b.short,cutLabel:b.label,Bk:b.bits,Ck:b.macs,pctC:b.macs/Cfull,
    rho:b.rho,ecritB:b.ecritB,ecritW:b.ecritW,bleSplits:N.ref30.reversalCells.filter(s=>s.startsWith(mm.id+'/')).length,
    bleSplitsFair:N.fair4sDMA.reversalCells.filter(s=>s.startsWith(mm.id+'/')).length,
    maxExpansion:Math.max(...prof.slice(1,fullIdx(mm)+1))/prof[0],firstCompressing:mm.splits[firstCmp].short,
    firstCompressingPctC:mm.splits[firstCmp].macs/Cfull,firstCompressingRatio:prof[firstCmp]/prof[0],Cfull,paramsFull:mm.splits[fullIdx(mm)].params};
});
const fair=result.sensitivity.find(s=>s.label==='DMA; 4-s BLE idle interval');
N.sleepfm_u385_fair={rawB:fair.rawB_mJ,tokB:fair.tokB_mJ,rawW:fair.rawW_mJ,tokW:fair.tokW_mJ,ecritB:fair.ecritB,ecritW:fair.ecritW};
N.pj=Object.fromEntries(PRESETS.map(p=>[p.id,{pj:p.pj||p.ua*p.V/(p.mpc||EST[p.est][0]),measured:!!p.pj}]));
// The same energies at the battery through an 85% regulator: every total scales by 1/0.85, so ratios,
// savings, break-evens and the chosen splits do not change.
const ETA=0.85;
N.battery={eta:ETA,sleepfm_u385:Object.fromEntries(['rawB','tokB','rawW','tokW','tokCompute'].map(k=>[k,N.sleepfm_u385[k]/ETA]))};
result.numbers=N;

fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(result,null,2));
// ---------- paper_numbers.json: the numbers quoted in the paper, with plain names, units and meanings ----------
// results.json keeps the same numbers in machine form (result.numbers) for the figures and robustness.py.
const rd=(x,d=2)=>x==null?null:+x.toFixed(d);
const sig=(x,s=3)=>x==null?null:+x.toPrecision(s);
const mcuName=id=>PRESETS.find(p=>p.id===id).name, modelName=id=>D.models.find(m=>m.id===id).name;
const pairName=s=>{const [mo,mc,sp]=s.split('/'),sl=D.models.find(m=>m.id===mo).splits.find(x=>x.short===sp);return `${modelName(mo)} on ${mcuName(mc)}, sending ${sl?sl.label:sp}`;};
const u385=PRESETS.find(p=>p.id==='u385'), sleepOverThroughput=u385.sleep*u385.V/(u385.mpc*u385.mhz);   // pJ per MAC (µW ÷ MMAC/s)
const sf=N.sleepfm_u385, esnU585=k=>result.cuts.find(c=>c.mcu==='u585'&&c.model==='esn'&&c.k===k);
const readable={
  about:'Numbers quoted in the paper "Compute or communicate?", produced by reproduce.js with the Version 2 energy model. Energies are per inference period at the chip supply pins (no regulator loss) unless a field says battery. results.json has every split at full precision.',
  reference_settings:'int8 model and 16-bit raw input; BLE 2 Mbps, 0 dBm, 30 ms connection interval, 6 packets per event, 30 ms keep-alive between inferences; Wi-R 5 Mbps, normal mode, deep sleep between transfers; MCU awake at 16 MHz while a radio sends; no lost packets.',
  placement_counts:{
    model_mcu_pairs:114,
    ble_local_processing_wins:{count:N.ref30.bleSplit,meaning:'pairs where running part of the network on the wearable uses less energy than streaming the raw input over BLE',pairs:N.ref30.reversalCells.map(pairName)},
    wir_streaming_wins:{count:N.ref30.wirInput,meaning:'pairs where streaming the raw input over Wi-R uses the least energy'},
    by_setting:Object.keys(SETTINGS).map(s=>({setting:SETTINGS[s].label,ble_local_processing_wins:N[s].bleSplit,wir_streaming_wins:N[s].wirInput})),
  },
  sleepfm_on_stm32u385:{
    period_s:300, raw_input_bits:raw.bits, token_bits:tok.bits, token_MACs:tok.macs,
    compute_energy_mJ:rd(sf.tokCompute),
    ble_energy_mJ:{stream_raw_input:rd(sf.rawB),send_tokens:rd(sf.tokB),saving_percent:rd(100*(1-sf.tokB/sf.rawB),1)},
    wir_energy_mJ:{stream_raw_input:rd(sf.rawW),send_tokens:rd(sf.tokW),tokens_cost_times_more:rd(sf.tokW/sf.rawW)},
    break_even_pJ_per_MAC:{ble:rd(sf.ecritB,1),wir:rd(sf.ecritW),stm32u385_measured:u385.pj,meaning:'computing the tokens saves energy if the MCU spends less than this per MAC'},
    bits_saved_per_MAC:sig(tok.rho,4),
    energy_per_bit_nJ:{ble_all_in:rd(N.ebit.BLE_allin),wir_all_in:rd(N.ebit.WiR_allin,3),ble_radio_only:rd(N.ebit.BLE_radio),wir_radio_only:rd(N.ebit.WiR_radio,3),
      meaning:'all_in: energy saved per bit not sent (radio + MCU awake while sending, minus the sleep and keep-alive that time replaces); radio_only: radio energy alone'},
    sleep_energy_displaced_by_computing_pJ_per_MAC:rd(sleepOverThroughput,3),
    crossover_link_energy_nJ_per_bit:rd((u385.pj-sleepOverThroughput)/tok.rho/1e3),
    crossover_meaning:'a link above this energy per bit favors sending tokens, a link below it favors streaming; it depends only on the MCU and the network',
    battery_energy_mJ:{conversion_efficiency:ETA,ble_stream_raw_input:rd(N.battery.sleepfm_u385.rawB),ble_send_tokens:rd(N.battery.sleepfm_u385.tokB),
      wir_stream_raw_input:rd(N.battery.sleepfm_u385.rawW),wir_send_tokens:rd(N.battery.sleepfm_u385.tokW)},
  },
  per_model_on_stm32u385_link:N.table2.map(t=>({model:t.name,period_s:t.period,raw_input_bits:t.B0,split_with_highest_ble_break_even:t.cutLabel,
    split_bits:t.Bk,split_MACs:t.Ck,share_of_model_MACs_percent:rd(100*t.pctC,1),bits_saved_per_MAC:sig(t.rho,3),
    ble_break_even_pJ_per_MAC:sig(t.ecritB,4),wir_break_even_pJ_per_MAC:sig(t.ecritW,4),ble_local_processing_wins_of_19_mcus:t.bleSplits,
    largest_data_expansion_times:rd(t.maxExpansion,1)})),
  energy_per_bit_across_19_mcus_nJ:{ble:[rd(N.ebitAcross.B[0],1),rd(N.ebitAcross.B[1],1)],wir:[rd(N.ebitAcross.W[0],2),rd(N.ebitAcross.W[1],2)],
    meaning:'range of the all-in energy per bit over the MCU presets; it varies because the MCU awake while sending is part of it'},
  other_worked_examples:{
    ensemblesleepnet_on_stm32u585:{ble_stream_raw_input_mJ:rd(esnU585(0).allB/1e6),ble_send_cnn_outputs_mJ:rd(esnU585(3).allB/1e6),
      meaning:'the CNN cuts the data 20x but uses 89% of the MACs, so sending its outputs costs more than streaming'},
    ensemblesleepnet_on_apollo510:{ble_stream_raw_input_mJ:rd(N.esn_apollo510.rawB),ble_send_cnn_outputs_mJ:rd(N.esn_apollo510.cnnB),
      wir_stream_raw_input_mJ:rd(N.esn_apollo510.rawW),wir_send_cnn_outputs_mJ:rd(N.esn_apollo510.cnnW),ble_break_even_pJ_per_MAC:rd(N.esn_apollo510.ecritB,1),wir_break_even_pJ_per_MAC:rd(N.esn_apollo510.ecritW)},
    attx_vgg_on_stm32u385:{ble_stream_raw_input_mJ:rd(N.attx_u385.rawB,3),wir_stream_raw_input_mJ:rd(N.attx_u385.rawW,3),full_model_compute_mJ:rd(N.attx_u385.fullCompute),
      first_layer_data_expansion_times:N.attx_u385.conv1x},
  },
  sleepfm_on_stm32u385_sensitivity:result.sensitivity.map(s=>({case:s.label,ble_stream_mJ:rd(s.rawB_mJ),ble_tokens_mJ:rd(s.tokB_mJ),
    ble_saving_percent:rd(100*(1-s.tokB_mJ/s.rawB_mJ),1),wir_stream_mJ:rd(s.rawW_mJ),wir_tokens_mJ:rd(s.tokW_mJ),
    ble_break_even_pJ_per_MAC:rd(s.ecritB,1),wir_break_even_pJ_per_MAC:rd(s.ecritW),ble_best:s.bestB,wir_best:s.bestW})),
  mcu_energy_per_MAC_pJ:PRESETS.map(p=>({mcu:p.name,pJ_per_MAC:sig(N.pj[p.id].pj,3),source:N.pj[p.id].measured?'MLPerf Tiny measurement':'datasheet estimate'})),
};
fs.writeFileSync(path.join(__dirname,'paper_numbers.json'),JSON.stringify(readable,null,2));
const counts={};for(const m of D.models){const a=result.matrix.filter(x=>x.model===m.id);counts[m.id]={bleInput:a.filter(x=>x.ble.k===0).length,wirInput:a.filter(x=>x.wir.k===0).length,bleSplit:a.filter(x=>x.ble.k>0).length};}
console.log(JSON.stringify({counts,breakEven:result.breakEven,sensitivity:result.sensitivity.map(({settings,...r})=>r)},null,2));
