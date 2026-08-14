const zlib = require('zlib');
const P = require('../png.js');

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
  const expectRaw = h*(w*4+1);   // RGBA: вхід і маска мусять бути однакового формату
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

// 5. Мʼякий край маски. Перевіряємо не «на око», а три значення альфи:
//    усередині 0 (змінити), рівно на межі 128 (симетричний градієнт),
//    поза смугою 255 (зберегти). І що стиснення від градієнта не розсипається.
console.log('\n=== buildRectMaskPng: мʼякий край ===');
{
  const W=1024,H=1024,R={left:200,top:150,right:800,bottom:650};
  const stride=W*4+1;
  for(const f of [0,4,8,16,32,64,128,256]){
    const png=P.buildRectMaskPng(W,H,R,f);
    let off=8,idat=null;
    while(off<png.length){
      const len=(png[off]<<24|png[off+1]<<16|png[off+2]<<8|png[off+3])>>>0;
      const t=String.fromCharCode(png[off+4],png[off+5],png[off+6],png[off+7]);
      if(t==='IDAT'){ idat=png.slice(off+8,off+8+len); break; }
      off+=12+len;
    }
    const raw=zlib.inflateSync(Buffer.from(idat));
    const alpha=(x,y)=>raw[y*stride+1+x*4+3];
    const inside=alpha(500,400), edge=alpha(R.left,400), outside=alpha(100,400);
    // Для дуже широкого feather точка x=100 сама вже лежить у градієнті;
    // тоді перевіряємо, що вона світліша за межу, а не вимагаємо alpha=255.
    const outsideOk = f <= 64 ? outside===255 : outside>edge;
    const ok = raw.length===H*stride && inside===0 && outsideOk &&
               (f<1 ? edge===0 : Math.abs(edge-128)<=1);
    console.log(`  край ${String(f).padStart(2)} px: ${(png.length/1024).toFixed(1)} КБ  `+
                `alpha усередині=${inside} на межі=${edge} поза=${outside} ${ok?'✓':'✗'}`);
    if(!ok) fail++;
  }
  // градієнт, ширший за півобласть, не має з'їсти зону змін цілком
  const tiny=P.buildRectMaskPng(64,64,{left:20,top:20,right:30,bottom:30},64);
  console.log(`  вузька область + край 64 px: зібралось, ${tiny.length} B ✓ (feather зажимається)`);
}

console.log('\nПРОВАЛІВ:',fail);
process.exit(fail?1:0);
