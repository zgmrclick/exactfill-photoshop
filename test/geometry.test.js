const G = require('/Users/zg.mrclick/ai-image-ps/geometry.js');
const CAPS2 = {arbitrary:true, step:16, maxEdge:3840, minPx:655360, maxPx:8294400, maxRatio:3};
console.log('=== exactSize + planFrame, quality=medium ===');
const cases=[['парне 200x200',{left:100,top:100,right:300,bottom:300}],
 ['НЕПАРНЕ 201x201',{left:100,top:100,right:301,bottom:301}],
 ['дробові',{left:100.4,top:100.4,right:612.6,bottom:612.6}],
 ['дрібне 40x40',{left:5,top:5,right:45,bottom:45}],
 ['велике 3000x2000',{left:0,top:0,right:3000,bottom:2000}],
 ['вузьке 100x900',{left:0,top:0,right:100,bottom:900}],
 ['ratio 5:1',{left:0,top:0,right:2500,bottom:500}],
 ['1000x600',{left:0,top:0,right:1000,bottom:600}]];
let fail=0;
for(const [n,b] of cases){
  const t=G.integerTarget(b);
  for(const q of ['low','medium','high']){
    const r=G.planRequest(CAPS2,t,q);
    if(!r.size){ console.log(`${n.padEnd(18)} q=${q.padEnd(6)} → null (падає на fixed)`); continue; }
    const [w,h]=r.size.split('x').map(Number);
    const f=G.planFrame(t,{w,h});
    const okStep = w%16===0&&h%16===0, okPx=w*h>=655360&&w*h<=8294400, okEdge=Math.max(w,h)<=3840;
    const covers=f.left<=t.left&&f.top<=t.top&&f.right>=t.right&&f.bottom>=t.bottom;
    const exOK = f.mode!=='exact' || (f.left===t.left&&f.top===t.top&&f.right===t.right&&f.bottom===t.bottom);
    const bad = !okStep||!okPx||!okEdge||!covers||!exOK; if(bad) fail++;
    console.log(`${n.padEnd(18)} q=${q.padEnd(6)} size=${r.size.padEnd(11)} ${(w*h/1e6).toFixed(2)}MP mode=${f.mode.padEnd(5)} рамка=${f.left},${f.top},${f.right-f.left}x${f.bottom-f.top}`,
      bad?`✗ step=${okStep} px=${okPx} edge=${okEdge} covers=${covers} exact=${exOK}`:'');
  }
}
console.log('\nпровалів:',fail);
console.log('\n=== fixed / aspect ===');
const t2=G.integerTarget({left:0,top:0,right:1000,bottom:600});
console.log('gpt-image-1:',JSON.stringify(G.planRequest({arbitrary:false,sizes:['1024x1024','1536x1024','1024x1536']},t2,'high')));
console.log('gemini 1K/2K/4K:',JSON.stringify(G.planRequest({arbitrary:false,aspects:['1:1','3:2','2:3','16:9','9:16','4:3','3:4'],imageSizes:['1K','2K','4K']},t2,'high')));
console.log('gemini low:',JSON.stringify(G.planRequest({arbitrary:false,aspects:['1:1','3:2','16:9'],imageSizes:['1K','2K','4K']},t2,'low')));
