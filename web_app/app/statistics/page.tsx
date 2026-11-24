"use client";

import {Fragment,useEffect,useMemo,useRef,useState} from "react";
import appPackage from "../../package.json";
import styles from "./page.module.css";
import {BacklogCharts} from "./backlog-charts";

type Audience="carrier"|"consignee"|"carrier4"|"backlog";
type BacklogMode="carrier"|"consignee";
type Item={
  month:string;carrier:string;consignee:string;title1or2Signed:boolean;
  carrierTitle2Signed:boolean;consigneeTitle3Signed:boolean;carrierTitle4Signed:boolean;
  number:string;containers:string[];deliveryDate:string;documentUrl:string|null;
};
type TmsTrip={id:string;month:string;carrier:string;client:string;consignee:string;container:string;actualDeliveryDate:string;etrnNumber:string|null;title2Signed:boolean;documentUrl:string|null};
type EntityRow={key:string;name:string;aliases:Set<string>;total:number;signed:number;documents:Item[];trips:TmsTrip[]};
type WeekSnapshot={capturedAt:string;items:Item[];tmsTrips:TmsTrip[]};
type Weekly={currentWeek:string;previousWeek:string;current?:WeekSnapshot;previous:WeekSnapshot|null};
type WeekRow={key:string;name:string;total:number;done:number;pending:number;previousPending:number|null};

const currentMonth=()=>new Date().toLocaleDateString("sv-SE",{year:"numeric",month:"2-digit",timeZone:"Europe/Moscow"});
const monthName=(value:string,short=false)=>{const [year,month]=value.split("-").map(Number);return year&&month?new Intl.DateTimeFormat("ru-RU",short?{month:"short"}:{month:"long",year:"numeric"}).format(new Date(year,month-1,1)):value;};
const weekLabel=(value:string)=>new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",timeZone:"UTC"}).format(new Date(`${value}T12:00:00Z`));
const displayName=(value:string)=>{let result=String(value||"Не указано").replace(/\([^)]*по\s+поручению[^)]*\)/giu,"").trim();const quoted=result.match(/[«"]([^»"]{2,})[»"]/u)?.[1];if(quoted)result=quoted;return result.replace(/^(?:общество\s+с\s+ограниченной\s+ответственностью|публичное\s+акционерное\s+общество|акционерное\s+общество|оооо|ооо|пао|ао|ип)\s*/iu,"").replace(/^[«"]|[»"]$/gu,"").trim()||"Не указано";};
const entityKey=(value:string)=>displayName(value).toLocaleUpperCase("ru-RU").replace(/[^A-ZА-ЯЁ0-9]/gu,"");
const consigneeName=(value:string)=>{const raw=String(value||"").trim(),plain=displayName(raw),key=entityKey(raw);if(/ТЯГОВАЯ\s+СИЛА/iu.test(raw))return "Тяговая Сила";if(key==="РО"||key==="ЮСИДЖИ")return "Юсиджи";if(key==="ПК"||key==="ПКПАКПОЛИМЕР")return "ПК ПАКПОЛИМЕР";if(/РУССКОЕ\s+ОБЩЕСТВО\s+СОДЕЙСТВИЯ\s+ШИННИКАМ\s*[-–]\s*ИНВЕСТ/iu.test(raw)||/^РОСШИНА\s*[-–]?\s*ИНВЕСТ$/iu.test(plain))return "Росшина - Инвест";return plain;};
const consigneeKey=(value:string)=>entityKey(consigneeName(value));
const isTaglex=(value:string)=>consigneeKey(value)==="ТАГЛЕКС";
const isEligible=(item:Item,audience:Audience)=>audience==="consignee"?item.title1or2Signed&&!isTaglex(item.consignee):audience==="carrier4"?item.consigneeTitle3Signed||item.carrierTitle4Signed:true;
const isTitleSigned=(item:Item,audience:Audience)=>audience==="consignee"?item.consigneeTitle3Signed:audience==="carrier4"?item.carrierTitle4Signed:item.carrierTitle2Signed;

export default function Statistics(){
  const [items,setItems]=useState<Item[]>([]);
  const [tmsTrips,setTmsTrips]=useState<TmsTrip[]>([]);
  const [weekly,setWeekly]=useState<Weekly|null>(null);
  const [loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(""),[warning,setWarning]=useState("");
  const [refreshKey,setRefreshKey]=useState(0);
  const lastRefreshKey=useRef(0),hasLoaded=useRef(false);
  const [exporting,setExporting]=useState(false);
  const [exportingPdf,setExportingPdf]=useState(false);
  const [month,setMonth]=useState("all"),[expanded,setExpanded]=useState<string|null>(null);
  const [rankingMode,setRankingMode]=useState<"best"|"worst">("best"),[audience,setAudience]=useState<Audience>("carrier");
  const [backlogMode,setBacklogMode]=useState<BacklogMode>("carrier");
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    const force=refreshKey!==lastRefreshKey.current;lastRefreshKey.current=refreshKey;
    setLoading(true);setError("");setWarning("");
    const load=async(refresh=false)=>{
      try{
        const response=await fetch(`/api/kontur/statistics?month=${encodeURIComponent(month)}${refresh?"&refresh=1":""}`,{cache:"no-store"});
        const contentType=response.headers.get("content-type")||"";
        if(!contentType.includes("application/json"))throw new Error(`Сервер статистики вернул HTTP ${response.status} вместо JSON. Возможно, истёк таймаут прокси; повторите загрузку.`);
        const result=await response.json();
        if(!active)return;
        if(response.status===202){setRefreshing(true);timer=setTimeout(()=>void load(),result.retryAfterMs||5000);return;}
        if(!response.ok)throw new Error(result.error||`Не удалось загрузить статистику: HTTP ${response.status}`);
        hasLoaded.current=true;setItems(result.items||[]);setTmsTrips(result.tmsTrips||[]);setWeekly(result.weekly||null);setLoading(false);setRefreshing(Boolean(result.refreshing));setWarning(result.refreshError||"");
        if(result.refreshing)timer=setTimeout(()=>void load(),5000);
      }catch(value){if(!active)return;setLoading(false);setRefreshing(false);const message=value instanceof Error?value.message:"Ошибка загрузки";if(hasLoaded.current)setWarning(message);else setError(message);}
    };
    void load(force);
    return()=>{active=false;if(timer)clearTimeout(timer);};
  },[month,refreshKey]);

  const months=useMemo(()=>{const values:string[]=[];const [year,number]=currentMonth().split("-").map(Number);for(let cursor=new Date(year,number-1,1);cursor>=new Date(2026,8,1);cursor.setMonth(cursor.getMonth()-1))values.push(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,"0")}`);return values;},[]);
  const selected=useMemo(()=>items.filter(item=>(month==="all"||item.month===month)&&isEligible(item,audience)),[items,month,audience]);
  const signedFlag=(item:Item)=>isTitleSigned(item,audience);
  const totals=useMemo(()=>{const signed=selected.filter(signedFlag).length;return {total:selected.length,signed,unsigned:selected.length-signed};},[selected,audience]);
  const circumference=2*Math.PI*46,signedPercent=totals.total?Math.round(totals.signed/totals.total*100):0;
  const selectedTrips=useMemo(()=>tmsTrips.filter(item=>month==="all"||item.month===month),[tmsTrips,month]);
  const dynamics=useMemo(()=>{
    const periods=month==="all"?[...months].reverse():[month];
    return periods.map(period=>{
      if(audience==="backlog"){
        const trips=selectedTrips.filter(item=>item.month===period);
        return {month:period,total:trips.length,completed:trips.filter(item=>Boolean(item.etrnNumber)).length};
      }
      const documents=selected.filter(item=>item.month===period);
      return {month:period,total:documents.length,completed:documents.filter(item=>isTitleSigned(item,audience)).length};
    });
  },[audience,month,months,selected,selectedTrips]);
  const dynamicsMax=Math.max(1,...dynamics.map(item=>item.total));
  const periodName=month==="all"?"весь период с сентября 2026":monthName(month);
  const periodShort=month==="all"?"с сентября 2026":monthName(month,true);
  const entities=useMemo(()=>{const result=new Map<string,EntityRow>();for(const item of selected){const raw=(audience==="consignee"?item.consignee:item.carrier)||"Не указано",key=(audience==="consignee"?consigneeKey(raw):entityKey(raw))||"НЕУКАЗАНО",candidate=audience==="consignee"?consigneeName(raw):displayName(raw),row=result.get(key)||{key,name:candidate,aliases:new Set<string>(),total:0,signed:0,documents:[],trips:[]};row.aliases.add(raw);if(candidate.length<row.name.length)row.name=candidate;row.total++;row.documents.push(item);if(signedFlag(item))row.signed++;result.set(key,row);}return [...result.values()].sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name,"ru"));},[selected,audience]);
  const backlogRows=useMemo(()=>{const result=new Map<string,EntityRow>();for(const trip of selectedTrips){const raw=backlogMode==="carrier"?trip.carrier:trip.consignee,key=(backlogMode==="carrier"?entityKey(raw):consigneeKey(raw))||"НЕУКАЗАНО",candidate=backlogMode==="carrier"?displayName(raw):consigneeName(raw),row=result.get(key)||{key,name:candidate,aliases:new Set<string>(),total:0,signed:0,documents:[],trips:[]};row.aliases.add(raw);row.trips.push(trip);result.set(key,row);}return [...result.values()].sort((a,b)=>b.trips.length-a.trips.length||a.name.localeCompare(b.name,"ru"));},[selectedTrips,backlogMode]);
  const ranked=useMemo(()=>entities.filter(row=>row.name!=="Не указано"&&row.total>0).map(row=>({...row,percent:Math.round(row.signed/row.total*100),unsigned:row.total-row.signed})).sort((a,b)=>rankingMode==="best"?b.signed-a.signed||b.percent-a.percent||b.total-a.total:b.unsigned-a.unsigned||a.percent-b.percent||b.total-a.total).slice(0,5),[entities,rankingMode]);
  const rankingSigned=ranked.reduce((sum,row)=>sum+row.signed,0),rankingTotal=ranked.reduce((sum,row)=>sum+row.total,0),rankingPercent=rankingTotal?Math.round(rankingSigned/rankingTotal*100):0;
  const weekRows=useMemo(()=>{
    const group=(documents:Item[],trips:TmsTrip[])=>{
      const result=new Map<string,WeekRow>();
      if(audience==="backlog")for(const trip of trips){
        const raw=backlogMode==="carrier"?trip.carrier:trip.consignee;
        const key=(backlogMode==="carrier"?entityKey(raw):consigneeKey(raw))||"НЕУКАЗАНО";
        const row=result.get(key)||{key,name:backlogMode==="carrier"?displayName(raw):consigneeName(raw),total:0,done:0,pending:0,previousPending:null};
        row.total++;if(trip.etrnNumber)row.done++;else row.pending++;result.set(key,row);
      }
      else for(const item of documents){
        if(!isEligible(item,audience))continue;
        const raw=audience==="consignee"?item.consignee:item.carrier;
        const key=(audience==="consignee"?consigneeKey(raw):entityKey(raw))||"НЕУКАЗАНО";
        const row=result.get(key)||{key,name:audience==="consignee"?consigneeName(raw):displayName(raw),total:0,done:0,pending:0,previousPending:null};
        row.total++;if(isTitleSigned(item,audience))row.done++;else row.pending++;result.set(key,row);
      }
      return result;
    };
    const currentItems=items,currentTrips=tmsTrips;
    const current=group(currentItems.filter(item=>month==="all"||item.month===month),currentTrips.filter(item=>month==="all"||item.month===month));
    const hasComparablePrevious=Boolean(weekly?.previous)&&(audience!=="carrier4"||weekly!.previous!.items.every(item=>typeof item.carrierTitle4Signed==="boolean"));
    const previous=hasComparablePrevious&&weekly?.previous?group(weekly.previous.items.filter(item=>month==="all"||item.month===month),weekly.previous.tmsTrips.filter(item=>month==="all"||item.month===month)):null;
    const keys=new Set([...current.keys(),...(previous?.keys()||[])]);
    return [...keys].map(key=>({...(current.get(key)||{key,name:previous?.get(key)?.name||"Не указано",total:0,done:0,pending:0,previousPending:null}),previousPending:previous?.get(key)?.pending??(previous?0:null)})).sort((a,b)=>b.pending-a.pending||a.name.localeCompare(b.name,"ru"));
  },[items,tmsTrips,weekly,month,audience,backlogMode]);
  const comparablePrevious=Boolean(weekly?.previous)&&(audience!=="carrier4"||weekly!.previous!.items.every(item=>typeof item.carrierTitle4Signed==="boolean"));
  const weekTotals=useMemo(()=>({total:weekRows.reduce((sum,row)=>sum+row.total,0),done:weekRows.reduce((sum,row)=>sum+row.done,0),pending:weekRows.reduce((sum,row)=>sum+row.pending,0),previousPending:comparablePrevious?weekRows.reduce((sum,row)=>sum+(row.previousPending||0),0):null}),[weekRows,comparablePrevious]);
  const selectedBacklogRow=backlogRows.find(row=>row.key===expanded)||backlogRows[0];
  const maxBacklogTrips=Math.max(1,...backlogRows.map(row=>row.trips.length));
  const titleNumber=audience==="consignee"?3:audience==="carrier4"?4:2,entityLabel=audience==="consignee"?"Грузополучатель":"Перевозчик";
  const exportPdf=async()=>{
    if(loading||exportingPdf||!selectedTrips.length)return;
    setExportingPdf(true);
    try{
      const {downloadBacklogPdf}=await import("./backlog-pdf");
      const recipients=new Map<string,{label:string;total:number;completed:number}>();
      for(const trip of selectedTrips){
        const key=consigneeKey(trip.consignee);
        const row=recipients.get(key)||{label:consigneeName(trip.consignee),total:0,completed:0};
        row.total++;
        if(trip.etrnNumber)row.completed++;
        recipients.set(key,row);
      }
      await downloadBacklogPdf(month==="all"?"С сентября 2026":monthName(month),
        dynamics.map(row=>({...row,label:row.month})),[...recipients.values()],`backlog-consignee-${month}.pdf`);
    }catch(value){setWarning(value instanceof Error?value.message:"Не удалось выгрузить PDF");}
    finally{setExportingPdf(false);}
  };
  const exportBacklog=async()=>{
    if(loading||exporting||!selectedTrips.length)return;
    setExporting(true);setError("");
    try{
      const XLSX=await import("xlsx");
      const groupLabel=backlogMode==="consignee"?"Грузополучатели":"Перевозчики";
      const summaryRows:(string|number)[][]=[["Период","Разрез","Контрагент","Рейсы TMS","С ЭТрН",`Backlog неделя ${weekly?.currentWeek||"текущая"}`,"Покрытие ЭТрН",`Backlog неделя ${weekly?.previousWeek||"прошлая"}`,"Изменение backlog","Изменение, %"]];
      for(const row of backlogRows){const total=row.trips.length,withEtrn=row.trips.filter(trip=>Boolean(trip.etrnNumber)).length,previous=weekRows.find(item=>item.key===row.key)?.previousPending;summaryRows.push([month==="all"?"С сентября 2026":month,groupLabel,row.name,total,withEtrn,total-withEtrn,total?withEtrn/total:0,previous??"",previous===null||previous===undefined?"":total-withEtrn-previous,previous===null||previous===undefined||previous===0?"":(total-withEtrn-previous)/previous]);}
      const detailRows:(string|number)[][]=[["Месяц","Грузополучатель","Перевозчик","Клиент","Контейнеры","Дата доставки на склад","Статус ЭТрН","Номер ЭТрН","Ссылка на ЭТрН","ID рейса TMS"]];
      for(const row of backlogRows)for(const trip of row.trips)detailRows.push([trip.month,consigneeName(trip.consignee),displayName(trip.carrier),trip.client,trip.container,trip.actualDeliveryDate,trip.etrnNumber?"С ЭТрН":"Backlog",trip.etrnNumber||"",trip.documentUrl||"",trip.id]);
      const workbook=XLSX.utils.book_new();
      const summary=XLSX.utils.aoa_to_sheet(summaryRows),details=XLSX.utils.aoa_to_sheet(detailRows);
      summary["!cols"]=[{wch:18},{wch:19},{wch:48},{wch:14},{wch:12},{wch:18},{wch:18},{wch:23},{wch:20},{wch:16}];
      details["!cols"]=[{wch:12},{wch:46},{wch:38},{wch:38},{wch:25},{wch:24},{wch:16},{wch:28},{wch:55},{wch:17}];
      summary["!autofilter"]={ref:`A1:J${summaryRows.length}`};
      details["!autofilter"]={ref:`A1:J${detailRows.length}`};
      for(let index=2;index<=summaryRows.length;index++){for(const col of ["G","J"]){const cell=summary[`${col}${index}`];if(cell&&cell.t==="n")cell.z="0%";}}
      XLSX.utils.book_append_sheet(workbook,summary,"Сводка");
      XLSX.utils.book_append_sheet(workbook,details,"Рейсы и контейнеры");
      XLSX.writeFile(workbook,`backlog-${backlogMode}-${month}.xlsx`);
    }catch(value){setError(value instanceof Error?value.message:"Не удалось выгрузить Excel");}
    finally{setExporting(false);}
  };
  const exportDynamics=async()=>{
    if(loading||exporting)return;
    setExporting(true);setError("");
    try{
      const XLSX=await import("xlsx");
      const rows:(string|number)[][]=[["Месяц",audience==="backlog"?"Рейсы TMS":"ЭТрН",audience==="backlog"?"Рейсы с ЭТрН":`Подписано Т${titleNumber}`,audience==="backlog"?"Без ЭТрН":"Не подписано","Доля, %"]];
      for(const item of dynamics)rows.push([monthName(item.month),item.total,item.completed,item.total-item.completed,item.total?Math.round(item.completed/item.total*100):0]);
      const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"]=[{wch:22},{wch:16},{wch:18},{wch:16},{wch:12}];
      sheet["!autofilter"]={ref:`A1:E${rows.length}`};
      XLSX.utils.book_append_sheet(workbook,sheet,"Динамика");
      XLSX.writeFile(workbook,`dynamics-${audience}-${month}.xlsx`);
    }catch(value){setError(value instanceof Error?value.message:"Не удалось выгрузить динамику");}
    finally{setExporting(false);}
  };
  const exportWeekly=async()=>{
    if(loading||exporting)return;
    setExporting(true);setError("");
    try{
      const XLSX=await import("xlsx");
      const rows:(string|number)[][]=[["Клиент",audience==="backlog"?"Бэклог на этой неделе":`Не подписано Т${titleNumber} сейчас`,audience==="backlog"?"Бэклог на прошлой неделе":`Не подписано Т${titleNumber} на прошлой неделе`,"Изменение"]];
      for(const row of weekRows)rows.push([row.name,row.pending,row.previousPending??"",row.previousPending===null?"":row.pending-row.previousPending]);
      const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"]=[{wch:48},{wch:28},{wch:35},{wch:20}];
      sheet["!autofilter"]={ref:`A1:D${rows.length}`};
      XLSX.utils.book_append_sheet(workbook,sheet,"Недельное сравнение");
      XLSX.writeFile(workbook,`weekly-${audience}-${month}.xlsx`);
    }catch(value){setError(value instanceof Error?value.message:"Не удалось выгрузить недельную динамику");}
    finally{setExporting(false);}
  };
  const exportUnsigned=async()=>{
    if(loading||exporting||audience==="backlog")return;
    setExporting(true);setError("");
    try{
      const XLSX=await import("xlsx");
      const rows:(string|number)[][]=[["Период","Номер ЭТрН","Контейнеры","Перевозчик","Грузополучатель","Дата доставки","Кто подписывает титул","Титул","Ссылка в Контур.Логистику","Предыдущий этап"]];
      for(const item of selected.filter(value=>!signedFlag(value))){
        const signer=audience==="consignee"?"Грузополучатель":"Перевозчик";
        const previousStage=audience==="consignee"&&!item.carrierTitle2Signed?"Т2 не подписан":audience==="carrier"&&!item.title1or2Signed?"Т1 не подписан":"";
        rows.push([item.month,item.number,item.containers.join(", "),item.carrier,item.consignee,item.deliveryDate,signer,`Т${titleNumber}`,item.documentUrl||"",previousStage]);
      }
      const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"]=[{wch:13},{wch:27},{wch:28},{wch:42},{wch:42},{wch:18},{wch:25},{wch:10},{wch:70},{wch:23}];
      sheet["!autofilter"]={ref:`A1:J${rows.length}`};
      XLSX.utils.book_append_sheet(workbook,sheet,`Не подписано Т${titleNumber}`);
      XLSX.writeFile(workbook,`unsigned-title-${titleNumber}-${month}.xlsx`);
    }catch(value){setError(value instanceof Error?value.message:"Не удалось выгрузить неподписанные ЭТрН");}
    finally{setExporting(false);}
  };

  return <main className={styles.shell}>
    <header className={styles.topbar}><div style={{background:"transparent"}}><img src="/agr-logo.png" alt="Логотип АГР" width={40} height={40} style={{display:"block",objectFit:"contain"}}/></div><strong>Создание ЭПД <small>версия {appPackage.version}</small></strong><nav><a href="/workspace">Создание документов</a><a href="/forwarding-orders">Поручения экспедиторам</a><a href="/control">Контроль подписания</a><a className={styles.active} href="/statistics">Статистика</a><a href="/edo-settings">Настройки ID ЭДО</a></nav></header>
    <section className={styles.content}>
      <header className={styles.heading}><div><small>АНАЛИТИКА ЭТрН</small><h1>Статистика ЭТрН</h1><p>{audience==="carrier"?"Контроль подписания титула 2 перевозчиками.":audience==="consignee"?"Контроль подписания титула 3 грузополучателями после наступления даты доставки.":audience==="carrier4"?"Контроль подписания титула 4 перевозчиками после титула 3.":"Контроль рейсов TMS, для которых еще не выпущена ЭТрН."}</p></div><button onClick={()=>setRefreshKey(value=>value+1)} disabled={loading||refreshing}>{loading||refreshing?"Обновляется…":"Обновить"}</button></header>
      {error&&<p className={styles.error}>{error}</p>}
      {warning&&<p className={styles.error}>Показан последний сохранённый срез. {warning}</p>}
      {refreshing&&!loading&&<p className={styles.refreshNotice}>Контур обновляет данные. Пока показан последний готовый срез.</p>}
      <section className={styles.audienceSwitch}><button className={audience==="carrier"?styles.on:""} onClick={()=>{setAudience("carrier");setExpanded(null)}}>Перевозчики · титул 2</button><button className={audience==="consignee"?styles.on:""} onClick={()=>{setAudience("consignee");setExpanded(null)}}>Грузополучатели · титул 3</button><button className={audience==="carrier4"?styles.on:""} onClick={()=>{setAudience("carrier4");setExpanded(null)}}>Перевозчики · титул 4</button><button className={audience==="backlog"?styles.on:""} onClick={()=>{setAudience("backlog");setExpanded(null)}}>Backlog TMS</button></section>
      <section className={styles.monthFilter}><label><span>Период</span><select value={month} onChange={event=>{setMonth(event.target.value);setExpanded(null);}}><option value="all">Все данные с сентября 2026</option>{months.map(value=><option value={value} key={value}>{monthName(value)}</option>)}</select></label></section>
      {!error&&!loading&&<>
      {audience!=="backlog"&&<section className={styles.metrics}>{([{name:"ЭТрН в контроле",value:totals.total},{name:`Подписано Т${titleNumber}`,value:totals.signed},{name:audience==="consignee"?"Отклонения · нет Т3":`Не подписано Т${titleNumber}`,value:totals.unsigned}]).map(card=><article key={card.name}><span>{card.name}</span><strong>{card.value}</strong></article>)}</section>}
      <section className={styles.weeklyCard} aria-label="Недельное сравнение"><header><div><h2>Динамика по неделям</h2><p>Недели начинаются в понедельник по московскому времени. Сравниваются текущие данные и сохранённый срез прошлой недели.</p></div><button type="button" onClick={()=>void exportWeekly()} disabled={exporting||loading}>{exporting?"Готовим Excel…":"Скачать сравнение · Excel"}</button></header>
        <div className={styles.weeklyOverview}><div><span>Текущая неделя · с {weekly?weekLabel(weekly.currentWeek):"—"}</span><strong>{weekTotals.pending}</strong><small>Актуальные данные, как в выгрузке</small></div><div><span>Прошлая неделя · с {weekly?weekLabel(weekly.previousWeek):"—"}</span><strong>{weekTotals.previousPending??"—"}</strong><small>{comparablePrevious&&weekly?.previous?`Срез: ${new Date(weekly.previous.capturedAt).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"})}`:audience==="carrier4"&&weekly?.previous?"В старом срезе нет данных по Т4":"Срез прошлой недели пока отсутствует"}</small></div><div><span>Изменение</span><strong>{weekTotals.previousPending===null?"—":`${weekTotals.pending-weekTotals.previousPending>0?"+":""}${weekTotals.pending-weekTotals.previousPending}`}</strong><small>{weekTotals.previousPending?`${Math.round((weekTotals.pending-weekTotals.previousPending)/weekTotals.previousPending*100)}% к прошлой неделе`:"Нет базы для процента"}</small></div></div>
        <details className={styles.weeklyDetails} open><summary>Сравнение по контрагентам ({weekRows.length})</summary><div><table><thead><tr><th>Клиент</th><th>{audience==="backlog"?"Бэклог на этой неделе":`Не подписано Т${titleNumber} сейчас`}</th><th>{audience==="backlog"?"Бэклог на прошлой неделе":`Не подписано Т${titleNumber} на прошлой неделе`}</th><th>Изменение</th></tr></thead><tbody>{weekRows.map(row=><tr key={row.key}><td>{row.name}</td><td>{row.pending}</td><td>{row.previousPending??"—"}</td><td>{row.previousPending===null?"—":`${row.pending-row.previousPending>0?"+":""}${row.pending-row.previousPending}`}</td></tr>)}</tbody></table></div></details>
      </section>
      {audience==="backlog"?<section className={styles.dynamicsCard} aria-label="Рейсы TMS и покрытие ЭТрН"><header><div><h2>Рейсы TMS и покрытие ЭТрН</h2><p>По месяцу доставки за выбранный период</p></div><button type="button" onClick={()=>void exportDynamics()} disabled={exporting||loading}>{exporting?"Готовим Excel…":"Скачать динамику · Excel"}</button></header><BacklogCharts months={dynamics} currentMonth={currentMonth()}/></section>:
<section className={styles.dynamicsCard} aria-label="Динамика документов по месяцам"><header><div><h2>Динамика ЭТрН и подписания</h2><p>С сентября 2026 года · значения указаны над каждым столбцом</p></div><button type="button" onClick={()=>void exportDynamics()} disabled={exporting||loading}>{exporting?"Готовим Excel…":"Скачать динамику · Excel"}</button></header><div className={styles.dynamicsLegend}><span><i className={styles.dynamicsTotalKey}/>ЭТрН</span><span><i className={styles.dynamicsDoneKey}/>{`Подписано Т${titleNumber}`}</span></div><div className={styles.dynamicsChart}>{dynamics.map(item=><div className={styles.dynamicsMonth} key={item.month} title={`${monthName(item.month)}: всего ${item.total}, подписано ${item.completed}`}><div className={styles.dynamicsColumns}><div className={styles.dynamicsColumn}><strong>{item.total}</strong><span style={{height:`${item.total/dynamicsMax*100}%`}}/></div><div className={styles.dynamicsColumn}><strong>{item.completed}</strong><span style={{height:`${item.completed/dynamicsMax*100}%`}}/></div></div><b>{monthName(item.month,true)}</b></div>)}</div></section>}
      {audience!=="backlog"&&<section className={styles.charts}>
        <article className={`${styles.chartCard} ${styles.monthTotalCard}`}><header><div><small>ОБЪЁМ</small><h2>ЭТрН за {periodName}</h2></div></header><div className={styles.singleBar}><strong>{totals.total}</strong><span><i style={{height:totals.total?"100%":"0"}}/></span><small>{periodShort}</small></div></article>
        <article className={`${styles.chartCard} ${styles.rankingCard}`}><header><div><small>РЕЙТИНГ</small><h2>{entityLabel} · титул {titleNumber}</h2></div><div className={styles.rankSwitch}><button className={rankingMode==="best"?styles.on:""} onClick={()=>setRankingMode("best")}>Топ‑5 лучших</button><button className={rankingMode==="worst"?styles.on:""} onClick={()=>setRankingMode("worst")}>Топ‑5 худших</button></div></header><div className={styles.rankBody}><div className={styles.miniDonut}><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="46"/><circle className={styles.donutValue} cx="60" cy="60" r="46" strokeDasharray={circumference} strokeDashoffset={circumference*(1-rankingPercent/100)}/></svg><div><strong>{rankingPercent}%</strong><span>{rankingSigned} из {rankingTotal}</span></div></div><ol>{ranked.map(row=><li key={row.key}><span title={row.name}>{row.name}</span><strong><small>{row.signed} / {row.total}</small>{row.percent}%</strong></li>)}{!ranked.length&&<li>Нет данных</li>}</ol></div></article>
        <article className={styles.chartCard}><header><div><small>ПОДПИСАНИЕ</small><h2>Доля подписанных · титул {titleNumber}</h2></div></header><div className={styles.donutWrap}><svg className={styles.donut} viewBox="0 0 120 120"><circle cx="60" cy="60" r="46"/><circle className={styles.donutValue} cx="60" cy="60" r="46" strokeDasharray={circumference} strokeDashoffset={circumference*(1-signedPercent/100)}/></svg><div className={styles.donutLabel}><strong>{signedPercent}%</strong><span>подписано</span></div></div><div className={styles.legend}><div><i className={styles.green}/><span>Подписано Т{titleNumber}</span><strong>{totals.signed}</strong></div><div><i className={styles.red}/><span>{audience==="consignee"?"Отклонение":"Не подписано"}</span><strong>{totals.unsigned}</strong></div></div></article>
      </section>}
      <section className={styles.carrierSection}><header><div><small>{audience==="consignee"?"ГРУЗОПОЛУЧАТЕЛИ":audience==="backlog"?"BACKLOG TMS":"ПЕРЕВОЗЧИКИ"}</small><h2>{audience==="backlog"?`Рейсы и выпуск ЭТрН за ${periodName}`:`Подписание титула ${titleNumber} за ${periodName}`}</h2><p>{audience==="backlog"?"Фактические рейсы взяты из ТТН/CMR по дате доставки на склад; рейсы без ЭТрН образуют backlog.":audience==="carrier"?"Учтены только ЭТрН с наступившей датой доставки.":audience==="carrier4"?"В контроле ЭТрН с подписанным Т3. Т4 ожидается от перевозчика.":"Отклонение — Т1 или Т2 подписан, дата доставки наступила, но Т3 не подписан."} Нажмите на строку для проверки реестра.</p></div><span>{audience==="backlog"?backlogRows.length:entities.length} {audience==="backlog"?(backlogMode==="carrier"?"перевозчиков":"грузополучателей"):audience==="consignee"?"грузополучателей":"перевозчиков"}</span></header>
        {audience!=="backlog"&&<div className={styles.unsignedToolbar}><span>{totals.unsigned} ЭТрН ожидают подписи</span><button type="button" onClick={()=>void exportUnsigned()} disabled={exporting||loading||!totals.unsigned}>{exporting?"Готовим Excel…":`Выгрузить неподписанные Т${titleNumber} · Excel`}</button></div>}
        {audience==="backlog"&&<div className={styles.backlogToolbar}><div className={styles.backlogModeSwitch} role="group" aria-label="Разрез backlog"><button type="button" className={backlogMode==="carrier"?styles.on:""} aria-pressed={backlogMode==="carrier"} onClick={()=>{setBacklogMode("carrier");setExpanded(null)}}>Перевозчики</button><button type="button" className={backlogMode==="consignee"?styles.on:""} aria-pressed={backlogMode==="consignee"} onClick={()=>{setBacklogMode("consignee");setExpanded(null)}}>Грузополучатели</button></div><div className={styles.backlogExportActions}><button type="button" className={styles.backlogExport} onClick={()=>void exportBacklog()} disabled={loading||exporting||!selectedTrips.length}>{exporting?"Готовим Excel…":"Выгрузить Excel с контейнерами"}</button><button type="button" className={styles.backlogExport} onClick={()=>void exportPdf()} disabled={loading||exportingPdf||!selectedTrips.length}>{exportingPdf?"Готовим PDF…":"Скачать PDF"}</button></div></div>}
        {audience==="backlog"&&<div className={styles.backlogLayout}>
          <div className={styles.backlogCarriers}>
            <div className={styles.backlogPaneTitle}><span>{backlogMode==="carrier"?"Перевозчики":"Грузополучатели"}</span><span>Backlog</span></div>
            {backlogRows.map(row=>{const trips=row.trips.length,withEtrn=row.trips.filter(trip=>trip.etrnNumber).length,coverage=Math.round(withEtrn/trips*100);return <button key={row.key} type="button" className={`${styles.backlogCarrier} ${selectedBacklogRow?.key===row.key?styles.backlogCarrierActive:""}`} aria-pressed={selectedBacklogRow?.key===row.key} onClick={()=>setExpanded(row.key)}><span className={styles.backlogCarrierHead}><strong>{row.name}</strong><b>{trips-withEtrn}</b></span><span className={styles.backlogBars}><span className={styles.backlogMiniMetric}><span>Рейсы TMS <b>{trips}</b></span><i><em style={{width:`${trips/maxBacklogTrips*100}%`}}/></i></span><span className={styles.backlogMiniMetric}><span>Покрытие ЭТрН <b>{withEtrn} / {trips} · {coverage}%</b></span><i><em style={{width:`${coverage}%`}}/></i></span></span></button>})}
            {!loading&&!backlogRows.length&&<p className={styles.backlogEmpty}>За выбранный период рейсов нет</p>}
          </div>
          <div className={styles.backlogClients}>
            {selectedBacklogRow?<><div className={styles.backlogClientTitle}><strong>{selectedBacklogRow.name}</strong><span>{selectedBacklogRow.trips.length} рейсов · {selectedBacklogRow.trips.filter(trip=>!trip.etrnNumber).length} backlog</span></div><div className={styles.backlogClientHead}><span>{backlogMode==="carrier"?"Грузополучатель":"Перевозчик"}</span><span>Рейсы</span><span>С ЭТрН</span><span>Backlog</span></div>{[...selectedBacklogRow.trips.reduce((groups,trip)=>{const raw=backlogMode==="carrier"?trip.consignee:trip.carrier,key=(backlogMode==="carrier"?consigneeKey(raw):entityKey(raw))||"НЕУКАЗАНО",group=groups.get(key)||{name:backlogMode==="carrier"?consigneeName(raw):displayName(raw),trips:[] as TmsTrip[]};group.trips.push(trip);groups.set(key,group);return groups;},new Map<string,{name:string;trips:TmsTrip[]}>()).values()].sort((a,b)=>b.trips.length-a.trips.length).map(group=>{const withEtrn=group.trips.filter(trip=>trip.etrnNumber).length;return <div className={styles.backlogClient} key={entityKey(group.name)}><strong>{group.name}</strong><span>{group.trips.length}</span><span>{withEtrn}</span><b>{group.trips.length-withEtrn}</b><details><summary>Показать контейнеры ({group.trips.length})</summary><div className={styles.backlogTripDetails}>{group.trips.map(trip=><div key={trip.id}><strong>{trip.container}</strong><span>{trip.actualDeliveryDate||"—"}</span><span>{trip.etrnNumber||"Нет ЭТрН"}</span>{trip.documentUrl?<a href={trip.documentUrl} target="_blank" rel="noreferrer" aria-label={`Открыть ЭТрН ${trip.etrnNumber} в Контуре`}>↗</a>:<span>—</span>}</div>)}</div></details></div>})}</>:<p className={styles.backlogEmpty}>Выберите {backlogMode==="carrier"?"перевозчика":"грузополучателя"}</p>}
          </div>
        </div>}
        {audience!=="backlog"&&<div className={styles.tableWrap}><table><thead><tr><th>{entityLabel}</th><th>ЭТрН</th><th>Подписано Т{titleNumber}</th><th>Процент подписания</th></tr></thead><tbody>
          {entities.map(row=>{const percent=row.total?Math.round(row.signed/row.total*100):0,isOpen=expanded===row.key;return <Fragment key={row.key}><tr className={styles.carrierRow} onClick={()=>setExpanded(isOpen?null:row.key)} aria-expanded={isOpen}><td><button type="button" className={styles.expandButton}><span>{isOpen?"−":"+"}</span><strong>{row.name}</strong></button>{row.aliases.size>1&&<small className={styles.aliasCount}>Объединено названий: {row.aliases.size}</small>}</td><td>{row.total}</td><td>{row.signed}</td><td><div className={styles.percentCell}><strong>{row.signed} / {row.total} · {percent}%</strong><span><i style={{width:`${percent}%`}}/></span></div></td></tr>{isOpen&&<tr className={styles.detailsRow}><td colSpan={4}><div className={styles.documentList}><div className={styles.documentHead}><span>ЭТрН</span><span>Контейнеры</span><span>Дата доставки</span><span>Титул {titleNumber}</span><span>Контур</span></div>{row.documents.map((item,index)=><div className={styles.documentItem} key={`${item.number}-${index}`}><strong>{item.number}</strong><span>{item.containers?.length?item.containers.join(", "):"—"}</span><span>{item.deliveryDate||"—"}</span><span className={signedFlag(item)?styles.signed:styles.unsigned}>{signedFlag(item)?"Подписан":audience==="consignee"?"Отклонение":"Не подписан"}</span>{item.documentUrl?<a className={styles.konturLink} href={item.documentUrl} target="_blank" rel="noreferrer">↗</a>:<span>—</span>}</div>)}</div></td></tr>}</Fragment>})}
          {!loading&&!entities.length&&<tr><td colSpan={4} className={styles.empty}>За выбранный период данных нет</td></tr>}
        </tbody></table></div>}
      </section>
      </>}
    </section>
  </main>;
}
