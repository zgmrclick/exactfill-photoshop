const zlib = require('zlib');
const P = require('/Users/zg.mrclick/ai-image-ps/png.js');

// 1. deflate round-trip на різних даних
console.log('=== deflate round-trip ===');
const samples = [
  ['нулі 10k',       new Uint8Array(10000)],
  ['однакові 0xAB',  new Uint8Array(5000).fill(0xAB)],
  ['випадкові 4k',   Uint8Array.from({length:4000},()=>Math.floor(Math.random()*256))],
  ['градієнт',       Uint8Array.from({length:8000},(_,i)=>i&255)],
  ['1 байт',         new Uint8Array([42])],
  ['порожній',       new Uint8Array(0)],
  ['межа 143/144',   Uint8Array.from({length:512},(_,i)=>i<256?i:255-(i-256))],
];
let fail=0;
for(const [name,data] of samples){
  try{
    const z = P.deflateRle(data, 100);
    const back = zlib.inflateSync(Buffer.from(z));
    const same = back.length===data.length && back.every((v,i)=>v===data[i]);
    const ratio = data.length? (z.length/data.length*100).toFixed(1)+'%' : '—';
    console.log(`  ${name.padEnd(16)} ${String(data.length).padStart(6)}B → ${String(z.length).padStart(6)}B (${ratio.padStart(7)})  ${same?'✓ ідентично':'✗ РІЗНЕ'}`);
    if(!same) fail++;
  }catch(e){ console.log(`  ${name.padEnd(16)} ✗ ВИНЯТОК: ${e.message}`); fail++; }
}

// 2. PNG маски: валідність + розмір
console.log('\n=== buildRectMaskPng ===');
for(const [w,h] of [[1024,1024],[2048,1536],[3840,2160],[816,816]]){
  const png = P.buildRectMaskPng(w,h,{left:w*0.25,top:h*0.25,right:w*0.75,bottom:h*0.75});
  // перевірка сигнатури й CRC кожного чанку
  const sig=[137,80,78,71,13,10,26,10]; let sigOK=sig.every((v,i)=>png[i]===v);
  const rd=o=>((png[o]<<24)|(png[o+1]<<16)|(png[o+2]<<8)|png[o+3])>>>0;
  let off=8, crcOK=true, chunks=[], idat=null;
  while(off+8<=png.length){
    const len=rd(off), type=String.fromCharCode(png[off+4],png[off+5],png[off+6],png[off+7]);
    const want=rd(off+8+len), got=P.crc32(png.subarray(off+4,off+8+len));
    if(want!==got) crcOK=false;
    chunks.push(type);
    if(type==='IDAT') idat=png.subarray(off+8,off+8+len);
    off+=12+len;
    if(type==='IEND') break;
  }
  let inflOK=false, rawLen=0;
  try{ const r=zlib.inflateSync(Buffer.from(idat)); inflOK=true; rawLen=r.length; }catch(e){}
  const expectRaw = h*(w*2+1);
  console.log(`  ${w}×${h}: ${(png.length/1024).toFixed(1)} КБ  sig=${sigOK} crc=${crcOK} chunks=[${chunks}] inflate=${inflOK} raw=${rawLen}/${expectRaw} ${rawLen===expectRaw?'✓':'✗'}`);
  if(!sigOK||!crcOK||!inflOK||rawLen!==expectRaw) fail++;
  if(png.length>4*1024*1024){ console.log('    ✗ ПЕРЕВИЩЕНО ліміт 4 МБ'); fail++; }
}

// 3. pHYs
console.log('\n=== setPngResolution ===');
let png = P.buildRectMaskPng(64,64,{left:0,top:0,right:32,bottom:32});
const noPhys = png.length;
png = P.setPngResolution(png, 300);
const withPhys = png.length;
png = P.setPngResolution(png, 300);   // повторно — мусить перезаписати, не додати
const twice = png.length;
const rd=o=>((png[o]<<24)|(png[o+1]<<16)|(png[o+2]<<8)|png[o+3])>>>0;
let off=8, physVal=null, physCount=0, order=[];
while(off+8<=png.length){
  const len=rd(off), type=String.fromCharCode(png[off+4],png[off+5],png[off+6],png[off+7]);
  order.push(type);
  if(type==='pHYs'){ physCount++; physVal=rd(off+8); }
  off+=12+len; if(type==='IEND') break;
}
console.log(`  без pHYs ${noPhys}B → з pHYs ${withPhys}B → повторно ${twice}B (мусить = ${withPhys})`);
console.log(`  чанків pHYs: ${physCount} (мусить 1), значення: ${physVal} px/m (300ppi → 11811), порядок: [${order}]`);
const physOK = physCount===1 && physVal===11811 && twice===withPhys && order.indexOf('pHYs')===1;
console.log(`  ${physOK?'✓':'✗ ПРОБЛЕМА'}`);
if(!physOK) fail++;

// 4. readPngSize
console.log('\n=== readPngSize ===');
const p2=P.buildRectMaskPng(333,222,{left:1,top:1,right:9,bottom:9});
const sz=P.readPngSize(p2);
console.log(`  333×222 → ${sz.w}×${sz.h} ${sz.w===333&&sz.h===222?'✓':'✗'}`);
if(sz.w!==333||sz.h!==222) fail++;
try{ P.readPngSize(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24])); console.log('  не-PNG → ✗ не кинув'); fail++; }
catch(e){ console.log(`  не-PNG → ✓ "${e.message}"`); }

console.log('\nПРОВАЛІВ:',fail);
process.exit(fail?1:0);
