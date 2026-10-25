import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app=express(), port=Number(process.env.PORT||8080);
const root=path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({limit:"32kb"}));
app.use(express.static(path.join(root,"public"),{maxAge:"1h"}));

const calendarStatus=()=>({
  configured:false,provider:process.env.ECONOMIC_CALENDAR_PROVIDER||"not-configured",
  updatedAt:null,events:[],
  warning:"No verified live calendar feed is connected. Events and news are never fabricated; directional trading stays disabled."
});
app.get("/api/health",(_req,res)=>res.json({ok:true,app:"MacroPulse",mode:"paper",liveExecution:false,time:new Date().toISOString()}));
app.get("/api/overview",(_req,res)=>{
 const balance=Number(process.env.STARTING_BALANCE_USD||500), calendar=calendarStatus();
 const thesis=(symbol)=>({
  instrument:symbol,direction:"WAIT",confidence:0,horizon:"multi-day",dataReady:false,generatedAt:new Date().toISOString(),
  reasons:symbol==="XAUUSD"
   ?["No verified live market/news feed is connected.","Gold thesis must combine USD, real yields, rate expectations, positioning and risk premium.","Wait for actual-versus-consensus data and post-event price confirmation."]
   :["No verified live market/news feed is connected.","Oil thesis must combine inventories, OPEC/supply, demand, geopolitics, spreads and futures curve.","Wait for verified event data, spread checks and post-event confirmation."],
  risks:["CPI/NFP/FOMC surprises can cause slippage, gaps and whipsaws.","Broker contract sizes, tick values, margin and trading sessions must be verified.","No live orders are enabled."]
 });
 res.json({app:"MacroPulse",mode:"paper",liveExecution:false,startingBalance:balance,
  instruments:[{symbol:"XAUUSD",configuredLots:0.01,thesis:thesis("XAUUSD")},{symbol:"USOIL",configuredLots:0.1,thesis:thesis("USOIL")}],
  calendar,paper:{balance,realizedPnl:0,positions:[],notes:["Paper ledger baseline only; no P/L simulation or orders are connected yet."]},
  monitor:{target:"24/5",active:false,note:"Live worker and verified data feed are not connected."}});
});
app.post("/api/paper/validate-entry",(req,res)=>{
 const b=req.body||{}, lots={XAUUSD:0.01,USOIL:0.1}, reasons=[];
 if(!Object.hasOwn(lots,b.instrument)||!["BUY","SELL"].includes(b.side))return res.status(400).json({error:"Invalid instrument or side."});
 const balance=Number(process.env.STARTING_BALANCE_USD||500);
 if(Number(b.lots)!==lots[b.instrument])reasons.push("Lot size does not match configured instrument size.");
 if(!(Number(b.entryPrice)>0)||!(Number(b.invalidationPrice)>0))reasons.push("Entry and invalidation prices must be positive.");
 if(!(Number(b.estimatedRiskUsd)>0))reasons.push("Risk must be estimated from verified broker contract specifications.");
 if(Number(b.estimatedRiskUsd)>balance*.01)reasons.push("Estimated risk exceeds the 1% paper per-entry cap.");
 if(b.side==="BUY"&&Number(b.invalidationPrice)>=Number(b.entryPrice))reasons.push("BUY invalidation must be below entry.");
 if(b.side==="SELL"&&Number(b.invalidationPrice)<=Number(b.entryPrice))reasons.push("SELL invalidation must be above entry.");
 res.status(reasons.length?422:200).json({allowed:!reasons.length,reasons:reasons.length?reasons:["Basic checks passed only. No order was sent."]});
});
app.listen(port,"0.0.0.0",()=>console.log(`MacroPulse listening on ${port}; paper-only, live execution disabled`));