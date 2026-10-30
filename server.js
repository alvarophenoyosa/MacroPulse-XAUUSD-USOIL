import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const app=express(), port=Number(process.env.PORT||8080);
const root=path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({limit:"32kb"}));
app.use(express.static(path.join(root,"public"),{maxAge:"1h"}));
const PAPER_BALANCE=Number(process.env.STARTING_BALANCE_USD||500);
const DATA_DIR=process.env.PAPER_DATA_DIR||"/data";
const LEDGER_FILE=path.join(DATA_DIR,"paper-ledger.json");
const iso=()=>new Date().toISOString();
const timeout=()=>AbortSignal.timeout(12000);
let ledger={version:1,startingBalance:PAPER_BALANCE,balance:PAPER_BALANCE,realizedPnl:0,positions:[],trades:[],lastUpdated:iso()};
let ledgerReady=false,ledgerError=null,writeChain=Promise.resolve();

async function saveLedger(){
 writeChain=writeChain.then(async()=>{await fs.mkdir(DATA_DIR,{recursive:true});const tmp=LEDGER_FILE+".tmp";await fs.writeFile(tmp,JSON.stringify(ledger,null,2));await fs.rename(tmp,LEDGER_FILE);});
 return writeChain;
}
async function loadLedger(){
 try{await fs.mkdir(DATA_DIR,{recursive:true});const raw=await fs.readFile(LEDGER_FILE,"utf8");const saved=JSON.parse(raw);if(saved&&saved.version===1&&Array.isArray(saved.positions)&&Array.isArray(saved.trades)){ledger={...ledger,...saved};}}
 catch(e){if(e.code!=="ENOENT")ledgerError="Ledger read failed: "+e.message;else await saveLedger();}
 ledgerReady=true;
}
const ledgerInit=loadLedger().catch(e=>{ledgerError=e.message;ledgerReady=true;});
async function getJson(url,headers={}){const r=await fetch(url,{headers,signal:timeout()});if(!r.ok)throw new Error("provider_http_"+r.status);return r.json();}
async function getText(url){const r=await fetch(url,{signal:timeout()});if(!r.ok)throw new Error("provider_http_"+r.status);return r.text();}
function status(name,configured,updatedAt,error=null){return {provider:name,configured,available:!error&&!!updatedAt,updatedAt:updatedAt||null,error:error||null};}

async function getQuotes(){
 const key=process.env.TWELVE_DATA_API_KEY;
 if(!key)return {status:status("Twelve Data",false,null,"API key required for reference quotes"),quotes:[]};
 const specs=[{symbol:"XAU/USD",display:"XAUUSD",asset:"Gold spot reference"},{symbol:"WTI/USD",display:"USOIL",asset:"WTI spot reference"}];
 const results=await Promise.all(specs.map(async s=>{try{
  const [d,bars]=await Promise.all([
   getJson("https://api.twelvedata.com/quote?symbol="+encodeURIComponent(s.symbol)+"&apikey="+encodeURIComponent(key)),
   getJson("https://api.twelvedata.com/time_series?symbol="+encodeURIComponent(s.symbol)+"&interval=1h&outputsize=5000&apikey="+encodeURIComponent(key))
  ]);
  if(d.status==="error"||!d.close)throw new Error(d.message||"quote_unavailable");
  const values=Array.isArray(bars.values)?bars.values.slice().reverse():[];
  const candles=values.map(v=>({time:v.datetime,open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close),volume:Number(v.volume)||null})).filter(v=>[v.open,v.high,v.low,v.close].every(Number.isFinite));
  const closes=candles.map(v=>v.close),last=closes.at(-1),prior4=closes.length>4?closes.at(-5):null,prior12=closes.length>12?closes.at(-13):null;
  const momentumPct=last>0&&prior4>0?(last-prior4)/prior4*100:null,momentum12hPct=last>0&&prior12>0?(last-prior12)/prior12*100:null;
  const ema=(period)=>{if(closes.length<period)return null;const k=2/(period+1);let v=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;for(const p of closes.slice(period))v=p*k+v*(1-k);return v;};
  const tr=candles.slice(1).map((v,i)=>Math.max(v.high-v.low,Math.abs(v.high-candles[i].close),Math.abs(v.low-candles[i].close)));
  const atr=tr.length>=14?tr.slice(-14).reduce((a,b)=>a+b,0)/14:null,ema9=ema(9),ema21=ema(21);
  return {symbol:s.display,providerSymbol:s.symbol,asset:s.asset,price:Number(d.close),open:Number(d.open)||null,high:Number(d.high)||null,low:Number(d.low)||null,change:Number(d.change)||null,percentChange:Number(d.percent_change)||null,datetime:d.datetime||d.timestamp||null,momentumPct:Number.isFinite(momentumPct)?momentumPct:null,momentum12hPct:Number.isFinite(momentum12hPct)?momentum12hPct:null,ema9,ema21,atr14:atr,trend:ema9&&ema21?(ema9>ema21?"UP":ema9<ema21?"DOWN":"FLAT"):"UNKNOWN",candleCount:candles.length,candles,candleTime:candles.at(-1)?.time||null,source:"Twelve Data",verified:true};
 }catch(e){return {symbol:s.display,asset:s.asset,verified:false,error:e.message};}}));
 return {status:status("Twelve Data",true,iso(),results.some(x=>x.verified)?null:"Quote lookup failed; verify symbols/plan"),quotes:results};
}
async function getCalendar(){
 const url="https://www.financecalendar.com/wp-json/fc/v1/calendar?country=US&impact=high&limit=100";
 try{const d=await getJson(url);if(!Array.isArray(d.events))throw new Error("unexpected_FinanceCalendar_schema");
 const events=d.events.map(e=>({date:e.release_at_utc||e.time_utc||e.date||null,country:e.country||"US",event:e.name||e.title||"Economic event",importance:e.impact==="high"?3:e.impact==="medium"?2:1,actual:e.actual??null,forecast:e.consensus??null,previous:e.prior??null,unit:e.unit||"",currency:"USD",status:e.status||null,source:e.source_name||"Finance Calendar",sourceUrl:e.source_url||e.url||null,stale:!!e.data_stale}));
 return {status:status("Finance Calendar",true,iso()),events,attribution:"Finance Calendar — https://www.financecalendar.com"};
 }catch(e){return {status:status("Finance Calendar",true,null,e.message),events:[],attribution:"Finance Calendar — https://www.financecalendar.com"};}
}
async function getNews(){
 const query='(gold OR crude oil OR WTI OR OPEC OR "Federal Reserve" OR FOMC OR CPI OR inflation OR "nonfarm payrolls" OR "jobless claims" OR Treasury yields OR dollar)';
 const url="https://api.gdeltproject.org/api/v2/doc/doc?query="+encodeURIComponent(query)+"&mode=ArtList&format=json&sort=DateDesc&maxrecords=30&timespan=24h";
 try{const d=await getJson(url);const articles=(d.articles||[]).map(a=>({title:a.title||"Untitled",url:a.url||null,source:a.domain||a.source||"Unknown",publishedAt:a.seendate||null,language:a.language||null,sourceType:"GDELT"})).filter(a=>a.title&&a.url).slice(0,30);return {status:status("GDELT news index",true,iso()),articles};}
 catch(e){return {status:status("GDELT news index",true,null,e.message),articles:[]};}
}
async function getEnergy(){
 const key=process.env.EIA_API_KEY;
 if(!key)return {status:status("US EIA petroleum data",false,null,"EIA_API_KEY not configured"),latest:null,observations:[],note:"Official EIA API adapter is ready when an API key is configured."};
 const url="https://api.eia.gov/v2/petroleum/sum/sndw/data/?api_key="+encodeURIComponent(key)+"&frequency=weekly&data[0]=value&facets[series][]=WCESTUS1&sort[0][column]=period&sort[0][direction]=desc&length=8";
 try{const d=await getJson(url);const rows=d?.response?.data||[];if(!rows.length)throw new Error("EIA returned no weekly crude stock rows");return {status:status("US EIA weekly petroleum data",true,iso()),latest:rows[0],observations:rows,source:"U.S. Energy Information Administration",attribution:"EIA API"};}
 catch(e){return {status:status("US EIA weekly petroleum data",true,null,e.message),latest:null,observations:[],source:"U.S. Energy Information Administration"};}
}
async function getFedUpdates(){
 try{const xml=await getText("https://www.federalreserve.gov/feeds/press_all.xml");const blocks=xml.split("<item>").slice(1).map(p=>p.split("</item>")[0]).slice(0,20);
 const decode=s=>s.replace(/<!\[CDATA\[|\]\]>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
 const items=blocks.map(block=>{const field=tag=>{const m=block.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)</"+tag+">","i"));return m?decode(m[1]):null;};return {title:field("title"),url:field("link"),publishedAt:field("pubDate"),source:"Federal Reserve official RSS",sourceType:"official"};}).filter(x=>x.title&&x.url);
 return {status:status("Federal Reserve official RSS",true,iso()),articles:items};}
 catch(e){return {status:status("Federal Reserve official RSS",true,null,e.message),articles:[]};}
}
async function getMacroSeries(){
 const ids=["DGS10","DFII10","DFF","DTWEXBGS","DCOILWTICO"];
 try{const csv=await getText("https://fred.stlouisfed.org/graph/fredgraph.csv?id="+ids.join(","));const lines=csv.trim().split(/\r?\n/),headers=lines.shift().split(","),rows=lines.map(line=>line.split(","));
 const data={};for(const id of ids){const idx=headers.indexOf(id);if(idx<0)continue;const valid=rows.filter(r=>r[idx]&&r[idx]!=="."&&Number.isFinite(Number(r[idx])));if(valid.length){const a=valid.at(-1),b=valid.at(-2);data[id]={value:Number(a[idx]),date:a[0],previous:b?Number(b[idx]):null,previousDate:b?b[0]:null,change:b?Number((Number(a[idx])-Number(b[idx])).toFixed(5)):null};}}
 return {status:status("FRED public series",true,iso()),data,disclaimer:"FRED values are daily/periodic and can be delayed; not tick-level live prices."};}
 catch(e){return {status:status("FRED public series",true,null,e.message),data:{},disclaimer:"Macro series unavailable."};}
}
function buildThesis(symbol,quote,news,calendar,macro,energy){
 const gold=symbol==="XAUUSD",reasons=[],risks=[],scores={technical:0,macro:0,news:0,energy:0};
 const priceOK=!!quote?.verified&&Number.isFinite(quote.price),age=quote?.datetime?Date.now()-Date.parse(quote.datetime):Infinity,fresh=Number.isFinite(age)&&age>=-300000&&age<=90*60000;
 if(!priceOK)reasons.push("No verified quote; signal blocked.");else if(!fresh)reasons.push("Quote timestamp missing or older than 90 minutes; signal blocked.");else reasons.push("Fresh reference quote: "+quote.price+" from "+quote.providerSymbol+".");
 const momentum=Number(quote?.momentumPct),momentum12=Number(quote?.momentum12hPct);
 if(priceOK&&fresh&&quote.trend==="UP"&&momentum>0&&momentum12>0)scores.technical=35;else if(priceOK&&fresh&&quote.trend==="DOWN"&&momentum<0&&momentum12<0)scores.technical=35;else if(priceOK&&fresh&&quote.trend!=="UNKNOWN"&&Number.isFinite(momentum)&&Math.abs(momentum)>=0.04)scores.technical=15;
 reasons.push("Technical: EMA 9/21 "+(quote?.trend||"unavailable")+", 4h "+(Number.isFinite(momentum)?momentum.toFixed(3)+"%":"n/a")+", 12h "+(Number.isFinite(momentum12)?momentum12.toFixed(3)+"%":"n/a")+".");
 const headlines=(news.articles||[]).filter(a=>a.title).slice(0,35),upRe=gold?/(gold.{0,25}(rall|surge|rise|gain)|safe.?haven|rate cut|dovish|real yields? fall|dollar weak|weak dollar)/i:/(oil.{0,25}(surge|rise|gain|jump)|supply cut|opec.{0,35}(cut|reduce)|inventory draw|crude stocks fall|supply disruption)/i,downRe=gold?/(gold.{0,25}(drop|fall|slide|sink)|hawkish|rate hike|real yields? rise|dollar surge|strong dollar)/i:/(oil.{0,25}(drop|fall|slide|sink)|opec.{0,35}(increase|raise)|inventory build|crude stocks rise|demand concerns)/i;
 const upHits=headlines.filter(a=>upRe.test(a.title)).length,downHits=headlines.filter(a=>downRe.test(a.title)).length;
 if(upHits>=2&&upHits>downHits)scores.news=15;else if(downHits>=2&&downHits>upHits)scores.news=15;
 reasons.push("News context: "+upHits+" bullish-keyword and "+downHits+" bearish-keyword headlines; weak evidence only.");
 if(gold){const real=macro.data?.DFII10,usd=macro.data?.DTWEXBGS;if(real?.change!==null&&real?.change!==undefined)scores.macro+=real.change<0?15:real.change>0?0:5;if(usd?.change!==null&&usd?.change!==undefined)scores.macro+=usd.change<0?15:usd.change>0?0:5;if(real)reasons.push("10Y real yield "+real.value+"%, daily change "+real.change+".");if(usd)reasons.push("Broad USD "+usd.value+", daily change "+usd.change+".");}
 else{const rows=energy.observations||[];if(rows.length>=2&&Number.isFinite(Number(rows[0].value))&&Number.isFinite(Number(rows[1].value))){const delta=Number(rows[0].value)-Number(rows[1].value);scores.energy=delta<0?15:0;reasons.push("EIA weekly crude stocks change "+delta+" "+(rows[0].units||"units")+"; inventory draw is only one input.");}else reasons.push("Oil inventory feed not ready for scoring; official weekly EIA data required.");}
 const upcoming=(calendar.events||[]).filter(e=>e.date&&String(e.date).includes("T")).map(e=>({...e,mins:(Date.parse(e.date)-Date.now())/60000})).filter(e=>e.mins>=0&&e.mins<=45&&e.importance>=2),eventBlock=upcoming.length>0;
 if(eventBlock)reasons.push("High/medium-impact US release within 45 minutes: "+upcoming.map(e=>e.event).join(", ")+". Stand aside.");
 const aligned=quote?.trend==="UP"&&momentum>0&&momentum12>0?"BUY":quote?.trend==="DOWN"&&momentum<0&&momentum12<0?"SELL":"",total=Object.values(scores).reduce((a,b)=>a+b,0),dataReady=priceOK&&fresh&&news.status.available&&macro.status.available&&calendar.status.available;
 let direction="NO TRADE",setup=null;if(dataReady&&!eventBlock&&aligned&&scores.technical>=35&&total>=55){direction="PAPER "+aligned;setup=aligned;}else if(dataReady&&!eventBlock&&scores.technical>=15)direction="WATCH";
 risks.push("Rule-based research score only; not trained or proven.");risks.push("Twelve Data spot references may differ from CFD pricing, contract size and spread.");risks.push("No exchange-grade live order book/depth or intraday open interest feed is connected.");
 return {instrument:symbol,direction,setup,confidence:Math.min(100,total),score:total,scoreBreakdown:scores,horizon:"multi-day",dataReady,generatedAt:iso(),reasons,risks,eventBlocked:eventBlock,headlineContext:{bullishMatches:upHits,bearishMatches:downHits},note:"Paper signals only. No broker orders are sent."};
}
function updatePaperEngine(instruments){
 if(!ledgerReady)return;
 let changed=false;
 for(const item of instruments){const t=item.thesis,q=item.quote;if(!q?.verified||!Number.isFinite(q.price))continue;
  const pos=ledger.positions.find(p=>p.instrument===item.symbol);
  if(pos){pos.markPrice=q.price;const rawMove=pos.side==="BUY"?q.price-pos.entryPrice:pos.entryPrice-q.price;pos.unrealizedPnlUsd=Number((pos.riskUsd*(rawMove/pos.stopDistance)).toFixed(2));changed=true;const stopHit=pos.side==="BUY"?q.price<=pos.stopPrice:q.price>=pos.stopPrice,targetHit=pos.side==="BUY"?q.price>=pos.targetPrice:q.price<=pos.targetPrice;
   if(stopHit||targetHit){const raw=q.price,slip=raw*(pos.side==="BUY"?-1:1)*0.0002,exit=raw+slip,move=pos.side==="BUY"?exit-pos.entryPrice:pos.entryPrice-exit, rMultiple=move/pos.stopDistance,frictionR=(pos.entryPrice+exit)*0.0002/pos.stopDistance,pnl=pos.riskUsd*(rMultiple-frictionR);ledger.balance+=pnl;ledger.realizedPnl+=pnl;ledger.trades.unshift({...pos,exitPrice:exit,exitAt:iso(),exitReason:stopHit?"STOP":"TARGET",rMultiple:Number(rMultiple.toFixed(3)),estimatedCostsUsd:Number((pos.riskUsd*frictionR).toFixed(2)),pnlUsd:Number(pnl.toFixed(2))});ledger.positions=ledger.positions.filter(p=>p.id!==pos.id);changed=true;}
  }else if(t?.setup&&t.dataReady&&!t.eventBlocked){const atr=Number(q.atr14);if(!(atr>0))continue;const stopDistance=atr*1.5,riskUsd=Math.max(0,ledger.balance*0.005);if(riskUsd<=0)continue;const side=t.setup,entry=q.price*(side==="BUY"?1.0002:0.9998),stopPrice=side==="BUY"?entry-stopDistance:entry+stopDistance,targetPrice=side==="BUY"?entry+stopDistance*2:entry-stopDistance*2;
   ledger.positions.push({id:"MP-"+Date.now()+"-"+item.symbol,instrument:item.symbol,side,entryPrice:entry,entryAt:iso(),stopPrice,targetPrice,stopDistance,riskUsd,configuredLots:item.configuredLots,model:"ATR 1.5 stop / 2R target",costModel:"estimated 2 bps per side; not exchange spread",status:"OPEN"});changed=true;
  }
 }
 if(changed){ledger.lastUpdated=iso();saveLedger().catch(e=>{ledgerError="Ledger save failed: "+e.message;});}
}
function paperSummary(){const unrealized=ledger.positions.reduce((sum,p)=>sum+Number(p.unrealizedPnlUsd||0),0);return {startingBalance:ledger.startingBalance,balance:Number(ledger.balance.toFixed(2)),realizedPnl:Number(ledger.realizedPnl.toFixed(2)),unrealizedPnl:Number(unrealized.toFixed(2)),equity:Number((ledger.balance+unrealized).toFixed(2)),positions:ledger.positions,trades:ledger.trades.slice(0,100),tradeCount:ledger.trades.length,ledgerReady,ledgerError,lastUpdated:ledger.lastUpdated,model:"Risk-unit simulation; notional/contract specifications are not assumed."};}
function backtest(instruments){return instruments.map(x=>{const bars=x.quote?.candles||[],out=[];if(bars.length<50)return {instrument:x.symbol,status:"insufficient_data",bars:bars.length,trades:[],note:"At least 50 hourly bars required."};let balance=10000,wins=0,losses=0,peak=balance,maxDD=0;for(let i=30;i<bars.length-2;i++){const hist=bars.slice(0,i+1),cl=hist.map(b=>b.close),ema=(n)=>{const k=2/(n+1);let v=cl.slice(0,n).reduce((a,b)=>a+b,0)/n;for(const p of cl.slice(n))v=p*k+v*(1-k);return v;},e9=ema(9),e21=ema(21),mom=(cl.at(-1)-cl.at(-5))/cl.at(-5),mom12=(cl.at(-1)-cl.at(-13))/cl.at(-13),side=e9>e21&&mom>0&&mom12>0?"BUY":e9<e21&&mom<0&&mom12<0?"SELL":null;if(!side)continue;const trs=hist.slice(1).map((b,j)=>Math.max(b.high-b.low,Math.abs(b.high-hist[j].close),Math.abs(b.low-hist[j].close))),atr=trs.slice(-14).reduce((a,b)=>a+b,0)/Math.min(14,trs.slice(-14).length);if(!(atr>0))continue;const entry=bars[i+1].open,dist=atr*1.5,stop=side==="BUY"?entry-dist:entry+dist,target=side==="BUY"?entry+dist*2:entry-dist*2;let result=null,exit=null,exitTime=null;for(let j=i+1;j<bars.length;j++){const b=bars[j],s=side==="BUY"?b.low<=stop:b.high>=stop,t=side==="BUY"?b.high>=target:b.low<=target;if(s||t){result=s?-1:2;exit=s?stop:target;exitTime=b.time;break;}}if(result===null)continue;const risk=balance*.005,pnl=risk*result-risk*.08;balance+=pnl;wins+=pnl>0?1:0;losses+=pnl<=0?1:0;peak=Math.max(peak,balance);maxDD=Math.max(maxDD,(peak-balance)/peak*100);out.push({side,entryTime:bars[i+1].time,entry,exitTime,exit,resultR:result,pnlUsd:Number(pnl.toFixed(2))});i+=Math.max(0,bars.findIndex((b,j)=>j>i+1&&b.time===exitTime)-(i+1));}
 return {instrument:x.symbol,status:"historical_candle_simulation",bars:bars.length,periodStart:bars[0].time,periodEnd:bars.at(-1).time,startingBalance:10000,endingBalance:Number(balance.toFixed(2)),trades:out.length,wins,losses,winRate:out.length?Number((wins/out.length*100).toFixed(1)):0,maxDrawdownPct:Number(maxDD.toFixed(2)),results:out.slice(-100),limitations:["Hourly technical rules only; no news/event timestamps or macro surprise replay.","Historical data availability depends on Twelve Data plan and returned candle count.","Estimated friction only; not actual CFD spread, slippage, swaps or contract sizing.","In-sample descriptive test, not evidence of future performance."]};});}
async function overview(){
 await ledgerInit;
 const [market,calendar,news,macro,energy,fed]=await Promise.all([getQuotes(),getCalendar(),getNews(),getMacroSeries(),getEnergy(),getFedUpdates()]);
 const bySymbol=Object.fromEntries(market.quotes.map(q=>[q.symbol,q])),combinedNews={...news,articles:[...(fed.articles||[]),...(news.articles||[])].sort((a,b)=>Date.parse(b.publishedAt||0)-Date.parse(a.publishedAt||0)).slice(0,35)};
 const instruments=[{symbol:"XAUUSD",configuredLots:0.01,quote:bySymbol.XAUUSD||null},{symbol:"USOIL",configuredLots:0.1,quote:bySymbol.USOIL||null}].map(x=>({...x,thesis:buildThesis(x.symbol,x.quote,combinedNews,calendar,macro,energy)}));
 updatePaperEngine(instruments);
 return {app:"MacroPulse",mode:"paper",liveExecution:false,startingBalance:PAPER_BALANCE,instruments,providers:{market:market.status,calendar:calendar.status,news:news.status,macro:macro.status,energy:energy.status,federalReserve:fed.status,orderBook:{provider:"Exchange depth feed",configured:false,available:false,error:"No licensed exchange-grade XAUUSD/WTI order-book feed configured."},openInterest:{provider:"Futures open interest",configured:false,available:false,error:"No validated intraday futures OI feed configured; weekly positioning is not a substitute."}},calendar:{configured:calendar.status.configured,provider:calendar.status.provider,updatedAt:calendar.status.updatedAt,events:calendar.events,warning:calendar.status.error||null,attribution:calendar.attribution},news,macro,energy,paper:paperSummary(),monitor:{target:"24/5",active:true,refreshIntervalSeconds:300,note:"Server-side polling runs every 5 minutes while the Railway service is online; uptime and alert delivery are not guaranteed."}};
}
app.get("/api/health",(_req,res)=>res.json({ok:true,app:"MacroPulse",mode:"paper",liveExecution:false,time:iso(),ledgerReady,ledgerError}));
app.get("/api/overview",async(_req,res)=>{res.set("Cache-Control","no-store");try{return res.json(await overview());}catch(e){res.status(503).json({error:"overview_unavailable",message:e.message,liveExecution:false});}});
app.get("/api/paper",async(_req,res)=>{await ledgerInit;res.json(paperSummary());});
app.get("/api/backtest",async(_req,res)=>{try{const m=await getQuotes();const instruments=[{symbol:"XAUUSD",quote:m.quotes.find(q=>q.symbol==="XAUUSD")},{symbol:"USOIL",quote:m.quotes.find(q=>q.symbol==="USOIL")}];res.json({provider:m.status,results:backtest(instruments)});}catch(e){res.status(503).json({error:e.message});}});
app.get("/api/orderflow",(_req,res)=>res.json({available:false,orderBook:{available:false,reason:"No exchange-grade order-book/depth feed configured."},openInterest:{available:false,reason:"No validated intraday futures open-interest feed configured."},note:"Unavailable is explicit; no synthetic order-book or OI values are generated."}));
app.get("/api/news",async(_req,res)=>res.json(await getNews()));
app.get("/api/calendar",async(_req,res)=>res.json(await getCalendar()));
app.get("/api/market",async(_req,res)=>res.json(await getQuotes()));
app.listen(port,"0.0.0.0",()=>console.log("MacroPulse listening on "+port+"; paper-only, live execution disabled; persistent ledger at "+LEDGER_FILE));
