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
    getJson("https://api.twelvedata.com/time_series?symbol="+encodeURIComponent(s.symbol)+"&interval=1h&outputsize=50&apikey="+encodeURIComponent(key))
   ]);
   if(d.status==="error"||!d.close)throw new Error(d.message||"quote_unavailable");
   const values=Array.isArray(bars.values)?bars.values.slice().reverse():[];
   const candles=values.map(v=>({time:v.datetime,open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close),volume:Number(v.volume)||null})).filter(v=>[v.open,v.high,v.low,v.close].every(Number.isFinite));
   const closes=candles.map(v=>v.close), last=closes.at(-1), prior4=closes.length>4?closes.at(-5):null, prior12=closes.length>12?closes.at(-13):null;
   const momentumPct=last>0&&prior4>0?((last-prior4)/prior4)*100:null;
   const momentum12hPct=last>0&&prior12>0?((last-prior12)/prior12)*100:null;
   const ema=(period)=>{if(closes.length<period)return null;const k=2/(period+1);let value=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;for(const price of closes.slice(period))value=price*k+value*(1-k);return value;};
   const tr=candles.slice(1).map((v,i)=>Math.max(v.high-v.low,Math.abs(v.high-candles[i].close),Math.abs(v.low-candles[i].close)));
   const atr=tr.length>=14?tr.slice(-14).reduce((a,b)=>a+b,0)/14:null;
   const ema9=ema(9),ema21=ema(21);
   return {symbol:s.display,providerSymbol:s.symbol,asset:s.asset,price:Number(d.close),open:Number(d.open)||null,high:Number(d.high)||null,low:Number(d.low)||null,change:Number(d.change)||null,percentChange:Number(d.percent_change)||null,datetime:d.datetime||d.timestamp||null,momentumPct:Number.isFinite(momentumPct)?momentumPct:null,momentum12hPct:Number.isFinite(momentum12hPct)?momentum12hPct:null,ema9,ema21,atr14:atr,trend:ema9&&ema21?(ema9>ema21?"UP":ema9<ema21?"DOWN":"FLAT"):"UNKNOWN",candleCount:candles.length,candles,candleTime:candles.at(-1)?.time||null,momentumWindow:"4 hourly candles; trend from EMA 9/21",source:"Twelve Data",verified:true};
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
  const blocks=xml.split("<item>").slice(1).map(part=>part.split("</item>")[0]).slice(0,20);
  const decode=(s)=>s.replace(/<!\[CDATA\[|\]\]>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
  const items=blocks.map(block=>{
   const field=(tag)=>{const match=block.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)</"+tag+">","i"));return match?decode(match[1]):null;};
   return {title:field("title"),url:field("link"),publishedAt:field("pubDate"),source:"Federal Reserve official RSS",sourceType:"official"};
  }).filter(item=>item.title&&item.url);
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
function buildThesis(symbol,quote,news,calendar,macro,energy){
 const gold=symbol==="XAUUSD",reasons=[],risks=[],scores={technical:0,macro:0,news:0,energy:0};
 const priceOK=!!quote?.verified&&Number.isFinite(quote.price);
 const age=quote?.datetime?Date.now()-Date.parse(quote.datetime):Infinity;
 const fresh=Number.isFinite(age)&&age>=-300000&&age<=90*60000;
 if(!priceOK)reasons.push("No verified quote; signal blocked.");
 else if(!fresh)reasons.push("Quote timestamp is missing or older than 90 minutes; signal blocked.");
 else reasons.push("Fresh reference quote: "+quote.price+" from "+quote.providerSymbol+".");
 const momentum=Number(quote?.momentumPct), momentum12=Number(quote?.momentum12hPct);
 if(priceOK&&fresh&&quote.trend==="UP"&&momentum>0&&momentum12>0)scores.technical=35;
 else if(priceOK&&fresh&&quote.trend==="DOWN"&&momentum<0&&momentum12<0)scores.technical=35;
 else if(priceOK&&fresh&&quote.trend!=="UNKNOWN"&&Number.isFinite(momentum)&&Math.abs(momentum)>=0.04)scores.technical=15;
 reasons.push("Technical: EMA 9/21 "+(quote?.trend||"unavailable")+", 4h momentum "+(Number.isFinite(momentum)?momentum.toFixed(3)+"%":"n/a")+", 12h momentum "+(Number.isFinite(momentum12)?momentum12.toFixed(3)+"%":"n/a")+".");
 const headlines=(news.articles||[]).filter(a=>a.title).slice(0,35);
 const upRe=gold?/(gold.{0,25}(rall|surge|rise|gain)|safe.?haven|rate cut|dovish|real yields? fall|dollar weak|weak dollar)/i:/(oil.{0,25}(surge|rise|gain|jump)|supply cut|opec.{0,35}(cut|reduce)|inventory draw|crude stocks fall|supply disruption)/i;
 const downRe=gold?/(gold.{0,25}(drop|fall|slide|sink)|hawkish|rate hike|real yields? rise|dollar surge|strong dollar)/i:/(oil.{0,25}(drop|fall|slide|sink)|opec.{0,35}(increase|raise)|inventory build|crude stocks rise|demand concerns)/i;
 const upHits=headlines.filter(a=>upRe.test(a.title)).length,downHits=headlines.filter(a=>downRe.test(a.title)).length;
 if(upHits>=2&&upHits>downHits)scores.news=15;
 else if(downHits>=2&&downHits>upHits)scores.news=15;
 reasons.push("News context: "+upHits+" bullish-keyword and "+downHits+" bearish-keyword headlines; keyword matches are weak evidence.");
 const real=macro.data?.DFII10,usd=macro.data?.DTWEXBGS;
 if(gold){
  if(real?.change!==null&&real?.change!==undefined)scores.macro+=(real.change<0?15:real.change>0?0:5);
  if(usd?.change!==null&&usd?.change!==undefined)scores.macro+=(usd.change<0?15:usd.change>0?0:5);
  if(real)reasons.push("10Y real yield "+real.value+"%, daily change "+real.change+".");
  if(usd)reasons.push("Broad USD index "+usd.value+", daily change "+usd.change+".");
 }else{
  reasons.push("Oil inventory feed is displayed for review but not auto-scored until its schema and release deltas are normalized.");
  if(macro.data?.DCOILWTICO)reasons.push("FRED WTI daily reference "+macro.data.DCOILWTICO.value+" ("+macro.data.DCOILWTICO.date+").");
 }
 const upcoming=(calendar.events||[]).filter(e=>e.date&&String(e.date).includes("T")).map(e=>({...e,mins:(Date.parse(e.date)-Date.now())/60000})).filter(e=>e.mins>=0&&e.mins<=45&&e.importance>=2);
 const eventBlock=upcoming.length>0;
 if(eventBlock)reasons.push("High/medium-impact US release within 45 minutes: "+upcoming.map(e=>e.event).join(", ")+". Stand aside.");
 const aligned=quote?.trend==="UP"&&momentum>0&&momentum12>0?"BUY":quote?.trend==="DOWN"&&momentum<0&&momentum12<0?"SELL":"";
 const total=scores.technical+scores.macro+scores.news+scores.energy;
 const dataReady=priceOK&&fresh&&news.status.available&&macro.status.available&&calendar.status.available;
 let direction="NO TRADE",setup=null;
 if(dataReady&&!eventBlock&&aligned&&scores.technical>=35&&total>=55){direction="PAPER "+aligned;setup=aligned;}
 else if(dataReady&&!eventBlock&&scores.technical>=15)direction="WATCH";
 risks.push("Rule-based research score only; not trained, backtested or validated.");
 risks.push("Twelve Data spot references may differ from Exness CFD pricing, contract size and spread.");
 risks.push("News keyword matches can be false positives; FRED macro data is delayed/daily.");
 risks.push("No order book, broker spread or verified oil inventory surprise is included.");
 return {instrument:symbol,direction,setup,confidence:Math.min(100,total),score:total,scoreBreakdown:scores,horizon:"multi-day",dataReady,generatedAt:iso(),reasons,risks,eventBlocked:eventBlock,headlineContext:{bullishMatches:upHits,bearishMatches:downHits},note:"PAPER labels are research signals only. No position is opened and no broker order is sent. Missing/stale data blocks signals."};
}
async function overview(){
 const [market,calendar,news,macro,energy,fed]=await Promise.all([getQuotes(),getCalendar(),getNews(),getMacroSeries(),getEnergy(),getFedUpdates()]);
 const bySymbol=Object.fromEntries(market.quotes.map(q=>[q.symbol,q]));
 const combinedNews={...news,articles:[...(fed.articles||[]),...(news.articles||[])].sort((a,b)=>Date.parse(b.publishedAt||0)-Date.parse(a.publishedAt||0)).slice(0,35)};
 return {app:"MacroPulse",mode:"paper",liveExecution:false,startingBalance:PAPER_BALANCE,
  instruments:[{symbol:"XAUUSD",configuredLots:0.01,quote:bySymbol.XAUUSD||null,thesis:buildThesis("XAUUSD",bySymbol.XAUUSD,combinedNews,calendar,macro,energy)},{symbol:"USOIL",configuredLots:0.1,quote:bySymbol.USOIL||null,thesis:buildThesis("USOIL",bySymbol.USOIL,combinedNews,calendar,macro,energy)}],
  providers:{market:market.status,calendar:calendar.status,news:news.status,macro:macro.status,energy:energy.status,federalReserve:fed.status},
  calendar:{configured:calendar.status.configured,provider:calendar.status.provider,updatedAt:calendar.status.updatedAt,events:calendar.events,warning:calendar.status.error||null,attribution:calendar.attribution},
  news,macro,energy,
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
