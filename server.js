import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app=express(), port=Number(process.env.PORT||8080);
const root=path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({limit:"32kb"}));
app.use(express.static(path.join(root,"public"),{maxAge:"1h"}));
const PAPER_BALANCE=Number(process.env.STARTING_BALANCE_USD||500);
const timeout=()=>AbortSignal.timeout(9000);
async function getJson(url,headers={}) {
 const r=await fetch(url,{headers,signal:timeout()});
 if(!r.ok) throw new Error("provider_http_"+r.status);
 return r.json();
}
async function getText(url) {
 const r=await fetch(url,{signal:timeout()});
 if(!r.ok) throw new Error("provider_http_"+r.status);
 return r.text();
}
const iso=()=>new Date().toISOString();
function status(name,configured,updatedAt,error=null){return {provider:name,configured,available:!error&&!!updatedAt,updatedAt:updatedAt||null,error:error||null};}

async function getQuotes(){
 const key=process.env.TWELVE_DATA_API_KEY;
 if(!key)return {status:status("Twelve Data",false,null,"API key required for live quotes"),quotes:[]};
 const specs=[{symbol:"XAU/USD",display:"XAUUSD",asset:"Gold spot reference"},{symbol:"WTI/USD",display:"USOIL",asset:"WTI spot reference"}];
 const results=await Promise.all(specs.map(async s=>{
  try{
   const [d,bars]=await Promise.all([
    getJson("https://api.twelvedata.com/quote?symbol="+encodeURIComponent(s.symbol)+"&apikey="+encodeURIComponent(key)),
    getJson("https://api.twelvedata.com/time_series?symbol="+encodeURIComponent(s.symbol)+"&interval=1h&outputsize=12&apikey="+encodeURIComponent(key))
   ]);
   if(d.status==="error"||!d.close)throw new Error(d.message||"quote_unavailable");
   const values=Array.isArray(bars.values)?bars.values.slice().reverse():[];
   const last=values.length?Number(values[values.length-1].close):null;
   const prior=values.length>4?Number(values[values.length-5].close):null;
   const momentumPct=last>0&&prior>0?((last-prior)/prior)*100:null;
   return {symbol:s.display,providerSymbol:s.symbol,asset:s.asset,price:Number(d.close),open:Number(d.open)||null,high:Number(d.high)||null,low:Number(d.low)||null,change:Number(d.change)||null,percentChange:Number(d.percent_change)||null,datetime:d.datetime||d.timestamp||null,momentumPct:Number.isFinite(momentumPct)?momentumPct:null,momentumWindow:"approximately 4 hourly candles",candleTime:values.length?values[values.length-1].datetime:null,source:"Twelve Data",verified:true};
  }catch(e){return {symbol:s.display,asset:s.asset,verified:false,error:e.message};}
 }));
 return {status:status("Twelve Data",true,iso(),results.some(x=>x.verified)?null:"Quote lookup failed; verify symbols/plan"),quotes:results};
}
async function getCalendar(){
 const url="https://www.financecalendar.com/wp-json/fc/v1/calendar?country=US&impact=high&limit=100";
 try{
  const d=await getJson(url);
  if(!Array.isArray(d.events))throw new Error("unexpected_FinanceCalendar_schema");
  const events=d.events.map(e=>({date:e.release_at_utc||e.time_utc||e.date||null,country:e.country||"US",event:e.name||e.title||"Economic event",importance:e.impact==="high"?3:e.impact==="medium"?2:1,actual:e.actual??null,forecast:e.consensus??null,previous:e.prior??null,unit:e.unit||"",currency:"USD",status:e.status||null,source:e.source_name||"Finance Calendar",sourceUrl:e.source_url||e.url||null,stale:!!e.data_stale}));
  return {status:status("Finance Calendar",true,iso(),null),events,attribution:"Finance Calendar — https://www.financecalendar.com"};
 }catch(e){return {status:status("Finance Calendar",true,null,e.message),events:[],attribution:"Finance Calendar — https://www.financecalendar.com"};}
}
async function getNews(){
 const query='(gold OR crude oil OR WTI OR OPEC OR "Federal Reserve" OR FOMC OR CPI OR inflation OR "nonfarm payrolls" OR "jobless claims" OR Treasury yields OR dollar)';
 const url="https://api.gdeltproject.org/api/v2/doc/doc?query="+encodeURIComponent(query)+"&mode=ArtList&format=json&sort=DateDesc&maxrecords=30&timespan=24h";
 try{
  const d=await getJson(url);
  const articles=(d.articles||[]).map(a=>({title:a.title||"Untitled",url:a.url||null,source:a.domain||a.source||"Unknown",publishedAt:a.seendate||null,language:a.language||null,sourceType:"GDELT"})).filter(a=>a.title&&a.url).slice(0,30);
  return {status:status("GDELT news index",true,iso(),null),articles};
 }catch(e){return {status:status("GDELT news index",true,null,e.message),articles:[]};}
}
async function getEnergy(){
 const url="https://americasoilwatch.com/api/v1/us-stocks";
 try{
  const d=await getJson(url);
  const rows=Array.isArray(d)?d:(d.data||d.observations||d.results||[]);
  if(!rows.length&&!Object.keys(d||{}).length)throw new Error("empty_AmericasOilWatch_response");
  return {status:status("AmericasOilWatch",true,iso(),null),latest:d,observations:rows,source:"https://americasoilwatch.com/api/v1/us-stocks",attribution:"AmericasOilWatch"};
 }catch(e){return {status:status("AmericasOilWatch",true,null,e.message),latest:null,observations:[],source:"https://americasoilwatch.com/api/v1/us-stocks"};}
}
async function getFedUpdates(){
 try{
  const xml=await getText("https://www.federalreserve.gov/feeds/press_all.xml");
  const items=[...xml.matchAll(/<item>([\\s\\S]*?)<\\/item>/gi)].slice(0,20).map(m=>{
   const block=m[1];
   const field=(tag)=>{const x=block.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)<\\/"+tag+">","i"));return x?x[1].replace(/<!\\[CDATA\\[|\\]\\]>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim():null;};
   return {title:field("title"),url:field("link"),publishedAt:field("pubDate"),source:"Federal Reserve official RSS",sourceType:"official"};
  }).filter(x=>x.title&&x.url);
  return {status:status("Federal Reserve official RSS",true,iso(),null),articles:items};
 }catch(e){return {status:status("Federal Reserve official RSS",true,null,e.message),articles:[]};}
}
async function getMacroSeries(){
 const ids=["DGS10","DFII10","DFF","DTWEXBGS","DCOILWTICO"];
 try{
  const csv=await getText("https://fred.stlouisfed.org/graph/fredgraph.csv?id="+ids.join(","));
  const lines=csv.trim().split(/\r?\n/), headers=lines.shift().split(",");
  const rows=lines.slice(-12).map(line=>line.split(","));
  const latest={};
  for(const id of ids){
   const idx=headers.indexOf(id);
   if(idx<0)continue;
   for(let i=rows.length-1;i>=0;i--){const val=rows[i][idx];if(val&&val!=="."&&Number.isFinite(Number(val))){latest[id]={value:Number(val),date:rows[i][0]};break;}}
  }
  return {status:status("FRED public series",true,iso(),null),data:latest,disclaimer:"FRED values are daily/periodic and can be delayed; not tick-level live prices."};
 }catch(e){return {status:status("FRED public series",true,null,e.message),data:{},disclaimer:"Macro series unavailable."};}
}
function buildThesis(symbol,quote,news,calendar,macro){
 const gold=symbol==="XAUUSD", reasons=[],risks=[];
 const priceOK=!!quote?.verified&&Number.isFinite(quote.price);
 if(!priceOK)reasons.push("Live quote unavailable or not verified.");
 else reasons.push("Latest reference quote: "+quote.price+" ("+quote.providerSymbol+"); source timestamp: "+(quote.datetime||"not supplied")+".");
 const headlines=(news.articles||[]).slice(0,20).map(a=>a.title.toLowerCase());
 const goldUp=/gold (rall|surge|rise|gain)|safe.?haven|rate cut|dovish|yield(s)? fall|dollar weak|weak dollar/;
 const goldDown=/gold (drop|fall|slide|sink)|hawkish|rate hike|yield(s)? rise|dollar surge|strong dollar/;
 const oilUp=/oil (surge|rise|gain|jump)|supply cut|opec.{0,25}(cut|reduce)|inventory draw|crude stocks fall|supply disruption/;
 const oilDown=/oil (drop|fall|slide|sink)|opec.{0,25}(increase|raise)|inventory build|crude stocks rise|demand concerns/;
 const up=gold?goldUp:oilUp, down=gold?goldDown:oilDown;
 let upCount=0,downCount=0;
 for(const h of headlines){if(up.test(h))upCount++;if(down.test(h))downCount++;}
 if(upCount||downCount)reasons.push("Headline keyword scan: "+upCount+" bullish-context and "+downCount+" bearish-context matches; headlines are context, not verified causal signals.");
 else reasons.push("No clear directional headline keyword cluster; do not infer direction from absence of news.");
 if(gold&&macro.data?.DFII10)reasons.push("Latest 10Y TIPS real yield: "+macro.data.DFII10.value+"% ("+macro.data.DFII10.date+").");
 if(gold&&macro.data?.DTWEXBGS)reasons.push("Broad dollar index: "+macro.data.DTWEXBGS.value+" ("+macro.data.DTWEXBGS.date+").");
 if(gold&&macro.data?.DGS10)reasons.push("10Y Treasury yield: "+macro.data.DGS10.value+"% ("+macro.data.DGS10.date+").");
 if(!gold&&macro.data?.DCOILWTICO)reasons.push("FRED WTI series: "+macro.data.DCOILWTICO.value+" ("+macro.data.DCOILWTICO.date+"); daily reference, not Exness CFD quote.");
 const highImpact=(calendar.events||[]).filter(e=>e.importance>=2);
 if(highImpact.length)reasons.push(highImpact.length+" high/medium-importance macro events in provider response; check exact release time before any simulated decision.");
 risks.push("GDELT headline keyword scan is not a trained sentiment model and can misread context.");
 risks.push("FRED macro series are not tick-level live and may be delayed.");
 risks.push("Reference feed symbols may differ from Exness CFD pricing/spread.");
 risks.push("No verified cross-source post-event confirmation, order book, broker contract spec or backtested edge yet.");
 const feedReady=priceOK&&news.status.available&&calendar.status.available;
 const momentum=Number(quote?.momentumPct);
 let direction="WAIT",confidence=0;
 if(feedReady&&Number.isFinite(momentum)&&Math.abs(momentum)>=0.08&&upCount+downCount>=2&&upCount!==downCount){
  const momentumUp=momentum>0;
  const newsUp=upCount>downCount;
  if(momentumUp===newsUp){direction=momentumUp?"BULLISH WATCH":"BEARISH WATCH";confidence=55;}
 }
 if(Number.isFinite(momentum))reasons.push("Hourly reference-price momentum: "+momentum.toFixed(3)+"% over "+(quote.momentumWindow||"recent candles")+"; not an entry signal by itself.");
 return {instrument:symbol,direction,confidence,horizon:"multi-day",dataReady:feedReady,generatedAt:iso(),reasons,risks,headlineContext:{bullishMatches:upCount,bearishMatches:downCount},note:"Watch bias is a basic keyword-plus-momentum filter, not validated AI. No orders or automatic entries are sent; WAIT remains the default unless independent feeds align."};
}
async function overview(){
 const [market,calendar,news,macro,energy,fed]=await Promise.all([getQuotes(),getCalendar(),getNews(),getMacroSeries(),getEnergy(),getFedUpdates()]);
 const bySymbol=Object.fromEntries(market.quotes.map(q=>[q.symbol,q]));\n const combinedNews={...news,articles:[...(fed.articles||[]),...(news.articles||[])].sort((a,b)=>Date.parse(b.publishedAt||0)-Date.parse(a.publishedAt||0)).slice(0,35)};
 return {app:"MacroPulse",mode:"paper",liveExecution:false,startingBalance:PAPER_BALANCE,
  instruments:[{symbol:"XAUUSD",configuredLots:0.01,quote:bySymbol.XAUUSD||null,thesis:buildThesis("XAUUSD",bySymbol.XAUUSD,combinedNews,calendar,macro)},{symbol:"USOIL",configuredLots:0.1,quote:bySymbol.USOIL||null,thesis:buildThesis("USOIL",bySymbol.USOIL,combinedNews,calendar,macro)}],
  providers:{market:market.status,calendar:calendar.status,news:news.status,macro:macro.status,energy:energy.status,federalReserve:fed.status},
  calendar:{configured:calendar.status.configured,provider:calendar.status.provider,updatedAt:calendar.status.updatedAt,events:calendar.events,warning:calendar.status.error||null,attribution:calendar.attribution},
  news,macro,
  paper:{balance:PAPER_BALANCE,realizedPnl:0,positions:[],notes:["Paper ledger baseline only; no P/L simulation or persistent positions are connected yet."]},
  monitor:{target:"24/5",active:false,note:"Web app refreshes on demand; persistent 24/5 background worker and alerts are not connected."}};
}
app.get("/api/health",(_req,res)=>res.json({ok:true,app:"MacroPulse",mode:"paper",liveExecution:false,time:iso()}));
let overviewCache=null, lastRefreshError=null;
async function refreshOverview(){
 try{overviewCache=await overview();lastRefreshError=null;console.log("MacroPulse data refresh ok "+iso());}
 catch(e){lastRefreshError=e.message;console.error("MacroPulse refresh failed "+e.message);}
}
app.get("/api/overview",async(_req,res)=>{res.set("Cache-Control","no-store");if(!overviewCache)await refreshOverview();if(overviewCache)return res.json({...overviewCache,monitor:{target:"24/5",active:true,refreshIntervalSeconds:300,lastRefreshError,note:"Server-side data polling runs every 5 minutes while the Railway service is online. This is not a guarantee of uninterrupted uptime or alert delivery."}});res.status(503).json({error:"overview_unavailable",message:lastRefreshError||"Waiting for first refresh",liveExecution:false});});
setTimeout(()=>refreshOverview(),1000);
setInterval(()=>refreshOverview(),300000).unref();
app.get("/api/news",async(_req,res)=>res.json(await getNews()));
app.get("/api/calendar",async(_req,res)=>res.json(await getCalendar()));
app.get("/api/market",async(_req,res)=>res.json(await getQuotes()));
app.post("/api/paper/validate-entry",(req,res)=>{
 const b=req.body||{}, lots={XAUUSD:0.01,USOIL:0.1}, reasons=[];
 if(!Object.hasOwn(lots,b.instrument)||!["BUY","SELL"].includes(b.side))return res.status(400).json({error:"Invalid instrument or side."});
 const balance=PAPER_BALANCE;
 if(Number(b.lots)!==lots[b.instrument])reasons.push("Lot size does not match configured instrument size.");
 if(!(Number(b.entryPrice)>0)||!(Number(b.invalidationPrice)>0))reasons.push("Entry and invalidation prices must be positive.");
 if(!(Number(b.estimatedRiskUsd)>0))reasons.push("Risk must be estimated from verified contract specifications.");
 if(Number(b.estimatedRiskUsd)>balance*.01)reasons.push("Estimated risk exceeds the 1% paper per-entry cap ($"+(balance*.01).toFixed(2)+").");
 if(b.side==="BUY"&&Number(b.invalidationPrice)>=Number(b.entryPrice))reasons.push("BUY invalidation must be below entry.");
 if(b.side==="SELL"&&Number(b.invalidationPrice)<=Number(b.entryPrice))reasons.push("SELL invalidation must be above entry.");
 res.status(reasons.length?422:200).json({allowed:!reasons.length,reasons:reasons.length?reasons:["Basic checks passed only. No order was sent."]});
});
app.listen(port,"0.0.0.0",()=>console.log("MacroPulse listening on "+port+"; paper-only, live execution disabled"));
