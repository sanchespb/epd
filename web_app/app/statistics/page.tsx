"use client";

import {Fragment,useEffect,useMemo,useState} from "react";
import appPackage from "../../package.json";
import styles from "./page.module.css";

type Audience="carrier"|"consignee"|"backlog";
type BacklogMode="carrier"|"consignee";
type Item={
  month:string;carrier:string;consignee:string;title1or2Signed:boolean;
  carrierTitle2Signed:boolean;consigneeTitle3Signed:boolean;
  number:string;containers:string[];deliveryDate:string;documentUrl:string|null;
};
type TmsTrip={id:string;month:string;carrier:string;client:string;consignee:string;container:string;actualDeliveryDate:string;etrnNumber:string|null;title2Signed:boolean;documentUrl:string|null};
type EntityRow={key:string;name:string;aliases:Set<string>;total:number;signed:number;documents:Item[];trips:TmsTrip[]};

const currentMonth=()=>new Date().toLocaleDateString("sv-SE",{year:"numeric",month:"2-digit",timeZone:"Europe/Moscow"});
const monthName=(value:string,short=false)=>{const [year,month]=value.split("-").map(Number);return year&&month?new Intl.DateTimeFormat("ru-RU",short?{month:"short"}:{month:"long",year:"numeric"}).format(new Date(year,month-1,1)):value;};
const displayName=(value:string)=>{let result=String(value||"Не указано").replace(/\([^)]*по\s+поручению[^)]*\)/giu,"").trim();const quoted=result.match(/[«"]([^»"]{2,})[»"]/u)?.[1];if(quoted)result=quoted;return result.replace(/^(?:общество\s+с\s+ограниченной\s+ответственностью|публичное\s+акционерное\s+общество|акционерное\s+общество|оооо|ооо|пао|ао|ип)\s*/iu,"").replace(/^[«"]|[»"]$/gu,"").trim()||"Не указано";};
const entityKey=(value:string)=>displayName(value).toLocaleUpperCase("ru-RU").replace(/[^A-ZА-ЯЁ0-9]/gu,"");
const consigneeName=(value:string)=>{const raw=String(value||"").trim(),plain=displayName(raw),key=entityKey(raw);if(/ТЯГОВАЯ\s+СИЛА/iu.test(raw))return "Тяговая Сила";if(key==="РО"||key==="ЮСИДЖИ")return "Юсиджи";if(key==="ПК"||key==="ПКПАКПОЛИМЕР")return "ПК ПАКПОЛИМЕР";if(/РУССКОЕ\s+ОБЩЕСТВО\s+СОДЕЙСТВИЯ\s+ШИННИКАМ\s*[-–]\s*ИНВЕСТ/iu.test(raw)||/^РОСШИНА\s*[-–]?\s*ИНВЕСТ$/iu.test(plain))return "Росшина - Инвест";return plain;};
const consigneeKey=(value:string)=>entityKey(consigneeName(value));
const isTaglex=(value:string)=>consigneeKey(value)==="ТАГЛЕКС";

export default function Statistics(){
  const [items,setItems]=useState<Item[]>([]);
  const [tmsTrips,setTmsTrips]=useState<TmsTrip[]>([]);
  const [loading,setLoading]=useState(true),[error,setError]=useState("");
  const [refreshKey,setRefreshKey]=useState(0);
  const [exporting,setExporting]=useState(false);
  const [month,setMonth]=useState("all"),[expanded,setExpanded]=useState<string|null>(null);
  const [rankingMode,setRankingMode]=useState<"best"|"worst">("best"),[audience,setAudience]=useState<Audience>("carrier");
  const [backlogMode,setBacklogMode]=useState<BacklogMode>("carrier");
  useEffect(()=>{let active=true;setLoading(true);setError("");void fetch(`/api/kontur/statistics?month=${encodeURIComponent(month)}${refreshKey?"&refresh=1":""}`,{cache:"no-store"}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось загрузить статистику");if(active){setItems(result.items||[]);setTmsTrips(result.tmsTrips||[]);}}).catch(value=>{if(active){setItems([]);setTmsTrips([]);setError(value instanceof Error?value.message:"Ошибка загрузки");}}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[month,refreshKey]);

  const months=useMemo(()=>{const values:string[]=[];const [year,number]=currentMonth().split("-").map(Number);for(let cursor=new Date(year,number-1,1);cursor>=new Date(2026,8,1);cursor.setMonth(cursor.getMonth()-1))values.push(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,"0")}`);return values;},[]);
  const selected=useMemo(()=>items.filter(item=>(month==="all"||item.month===month)&&(audience!=="consignee"||(item.title1or2Signed&&!isTaglex(item.consignee)))),[items,month,audience]);
  const signedFlag=(item:Item)=>audience==="consignee"?item.consigneeTitle3Signed:item.carrierTitle2Signed;
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
      return {month:period,total:documents.length,completed:documents.filter(item=>audience==="consignee"?item.consigneeTitle3Signed:item.carrierTitle2Signed).length};
    });
  },[audience,month,months,selected,selectedTrips]);
  const dynamicsMax=Math.max(1,...dynamics.map(item=>item.total));
  const periodName=month==="all"?"весь период с сентября 2026":monthName(month);
  const periodShort=month==="all"?"с сентября 2026":monthName(month,true);
  const entities=useMemo(()=>{const result=new Map<string,EntityRow>();for(const item of selected){const raw=(audience==="consignee"?item.consignee:item.carrier)||"Не указано",key=(audience==="consignee"?consigneeKey(raw):entityKey(raw))||"НЕУКАЗАНО",candidate=audience==="consignee"?consigneeName(raw):displayName(raw),row=result.get(key)||{key,name:candidate,aliases:new Set<string>(),total:0,signed:0,documents:[],trips:[]};row.aliases.add(raw);if(candidate.length<row.name.length)row.name=candidate;row.total++;row.documents.push(item);if(signedFlag(item))row.signed++;result.set(key,row);}return [...result.values()].sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name,"ru"));},[selected,audience]);
  const backlogRows=useMemo(()=>{const result=new Map<string,EntityRow>();for(const trip of selectedTrips){const raw=backlogMode==="carrier"?trip.carrier:trip.consignee,key=(backlogMode==="carrier"?entityKey(raw):consigneeKey(raw))||"НЕУКАЗАНО",candidate=backlogMode==="carrier"?displayName(raw):consigneeName(raw),row=result.get(key)||{key,name:candidate,aliases:new Set<string>(),total:0,signed:0,documents:[],trips:[]};row.aliases.add(raw);row.trips.push(trip);result.set(key,row);}return [...result.values()].sort((a,b)=>b.trips.length-a.trips.length||a.name.localeCompare(b.name,"ru"));},[selectedTrips,backlogMode]);
  const ranked=useMemo(()=>entities.filter(row=>row.name!=="Не указано"&&row.total>0).map(row=>({...row,percent:Math.round(row.signed/row.total*100),unsigned:row.total-row.signed})).sort((a,b)=>rankingMode==="best"?b.signed-a.signed||b.percent-a.percent||b.total-a.total:b.unsigned-a.unsigned||a.percent-b.percent||b.total-a.total).slice(0,5),[entities,rankingMode]);
  const rankingSigned=ranked.reduce((sum,row)=>sum+row.signed,0),rankingTotal=ranked.reduce((sum,row)=>sum+row.total,0),rankingPercent=rankingTotal?Math.round(rankingSigned/rankingTotal*100):0;
  const tripTotals=useMemo(()=>({total:selectedTrips.length,withEtrn:selectedTrips.filter(trip=>trip.etrnNumber).length}),[selectedTrips]);
  const selectedBacklogRow=backlogRows.find(row=>row.key===expanded)||backlogRows[0];
  const maxBacklogTrips=Math.max(1,...backlogRows.map(row=>row.trips.length));
  const titleNumber=audience==="consignee"?3:2,entityLabel=audience==="consignee"?"Грузополучатель":"Перевозчик";
  const exportBacklog=async()=>{
    if(loading||exporting||!selectedTrips.length)return;
    setExporting(true);setError("");
    try{
      const XLSX=await import("xlsx");
      const groupLabel=backlogMode==="consignee"?"Грузополучатели":"Перевозчики";
      const summaryRows:(string|number)[][]=[["Период","Разрез","Контрагент","Рейсы TMS","С ЭТрН","Backlog","Покрытие ЭТрН"]];
      for(const row of backlogRows){const total=row.trips.length,withEtrn=row.trips.filter(trip=>Boolean(trip.etrnNumber)).length;summaryRows.push([month==="all"?"С сентября 2026":month,groupLabel,row.name,total,withEtrn,total-withEtrn,total?withEtrn/total:0]);}
      const detailRows:(string|number)[][]=[["Месяц","Грузополучатель","Перевозчик","Клиент","Контейнеры","Дата доставки на склад","Статус ЭТрН","Номер ЭТрН","Ссылка на ЭТрН","ID рейса TMS"]];
      for(const row of backlogRows)for(const trip of row.trips)detailRows.push([trip.month,consigneeName(trip.consignee),displayName(trip.carrier),trip.client,trip.container,trip.actualDeliveryDate,trip.etrnNumber?"С ЭТрН":"Backlog",trip.etrnNumber||"",trip.documentUrl||"",trip.id]);
      const workbook=XLSX.utils.book_new();
      const summary=XLSX.utils.aoa_to_sheet(summaryRows),details=XLSX.utils.aoa_to_sheet(detailRows);
      summary["!cols"]=[{wch:12},{wch:19},{wch:48},{wch:14},{wch:12},{wch:12},{wch:18}];
      details["!cols"]=[{wch:12},{wch:46},{wch:38},{wch:38},{wch:25},{wch:24},{wch:16},{wch:28},{wch:55},{wch:17}];
      summary["!autofilter"]={ref:`A1:G${summaryRows.length}`};
      details["!autofilter"]={ref:`A1:J${detailRows.length}`};
      for(let index=2;index<=summaryRows.length;index++){const cell=summary[`G${index}`];if(cell)cell.z="0%";}
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
      const rows:(string|number)[][]=[["Месяц",audience==="backlog"?"Рейсы TMS":"ЭТрН",audience==="backlog"?"Рейсы с ЭТрН":`Подписано Т${audience==="consignee"?3:2}`,audience==="backlog"?"Без ЭТрН":"Не подписано","Доля, %"]];
      for(const item of dynamics)rows.push([monthName(item.month),item.total,item.completed,item.total-item.completed,item.total?Math.round(item.completed/item.total*100):0]);
      const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"]=[{wch:22},{wch:16},{wch:18},{wch:16},{wch:12}];
      sheet["!autofilter"]={ref:`A1:E${rows.length}`};
      XLSX.utils.book_append_sheet(workbook,sheet,"Динамика");
      XLSX.writeFile(workbook,`dynamics-${audience}-${month}.xlsx`);
    }catch(value){setError(value instanceof Error?value.message:"Не удалось выгрузить динамику");}
    finally{setExporting(false);}
  };

  return <main className={styles.shell}>
    <header className={styles.topbar}><div style={{background:"transparent"}}><img src="/agr-logo.png" alt="Логотип АГР" width={40} height={40} style={{display:"block",objectFit:"contain"}}/></div><strong>Создание ЭПД <small>версия {appPackage.version}</small></strong><nav><a href="/workspace">Создание документов</a><a href="/forwarding-orders">Поручения экспедиторам</a><a href="/control">Контроль подписания</a><a className={styles.active} href="/statistics">Статистика</a><a href="/edo-settings">Настройки ID ЭДО</a></nav></header>
    <section className={styles.content}>
      <header className={styles.heading}><div><small>АНАЛИТИКА ЭТрН</small><h1>Статистика ЭТрН</h1><p>{audience==="carrier"?"Контроль подписания титула 2 перевозчиками.":audience==="consignee"?"Контроль подписания титула 3 грузополучателями после наступления даты доставки.":"Контроль рейсов TMS, для которых еще не выпущена ЭТрН."}</p></div><button onClick={()=>setRefreshKey(value=>value+1)} disabled={loading}>{loading?"Считаем…":"Обновить"}</button></header>
      {error&&<p className={styles.error}>{error}</p>}
      <section className={styles.audienceSwitch}><button className={audience==="carrier"?styles.on:""} onClick={()=>{setAudience("carrier");setExpanded(null)}}>Перевозчики · титул 2</button><button className={audience==="consignee"?styles.on:""} onClick={()=>{setAudience("consignee");setExpanded(null)}}>Грузополучатели · титул 3</button><button className={audience==="backlog"?styles.on:""} onClick={()=>{setAudience("backlog");setExpanded(null)}}>Backlog TMS</button></section>
      <section className={styles.monthFilter}><label><span>Период</span><select value={month} onChange={event=>{setMonth(event.target.value);setExpanded(null);}}><option value="all">Все данные с сентября 2026</option>{months.map(value=><option value={value} key={value}>{monthName(value)}</option>)}</select></label></section>
      {!error&&!loading&&<>
      <section className={styles.metrics}>{(audience==="backlog"?[{name:"Фактические рейсы TMS",value:tripTotals.total},{name:"Рейсы с ЭТрН",value:tripTotals.withEtrn},{name:"Backlog без ЭТрН",value:tripTotals.total-tripTotals.withEtrn},{name:"Покрытие рейсов",value:tripTotals.total?`${Math.round(tripTotals.withEtrn/tripTotals.total*100)}%`:"0%"}]:[{name:"ЭТрН в контроле",value:totals.total},{name:`Подписано Т${titleNumber}`,value:totals.signed},{name:audience==="carrier"?"Не подписано Т2":"Отклонения · нет Т3",value:totals.unsigned}]).map(card=><article key={card.name}><span>{card.name}</span><strong>{card.value}</strong></article>)}</section>
      <section className={styles.dynamicsCard} aria-label="Динамика документов по месяцам"><header><div><h2>{audience==="backlog"?"Динамика рейсов и ЭТрН":"Динамика ЭТрН и подписания"}</h2><p>С сентября 2026 года · значения указаны над каждым столбцом</p></div><button type="button" onClick={()=>void exportDynamics()} disabled={exporting||loading}>{exporting?"Готовим Excel…":"Скачать динамику · Excel"}</button></header><div className={styles.dynamicsLegend}><span><i className={styles.dynamicsTotalKey}/>{audience==="backlog"?"Рейсы TMS":"ЭТрН"}</span><span><i className={styles.dynamicsDoneKey}/>{audience==="backlog"?"С ЭТрН":`Подписано Т${titleNumber}`}</span></div><div className={styles.dynamicsChart}>{dynamics.map(item=><div className={styles.dynamicsMonth} key={item.month} title={`${monthName(item.month)}: всего ${item.total}, ${audience==="backlog"?"с ЭТрН":"подписано"} ${item.completed}`}><div className={styles.dynamicsColumns}><div className={styles.dynamicsColumn}><strong>{item.total}</strong><span style={{height:`${item.total/dynamicsMax*100}%`}}/></div><div className={styles.dynamicsColumn}><strong>{item.completed}</strong><span style={{height:`${item.completed/dynamicsMax*100}%`}}/></div></div><b>{monthName(item.month,true)}</b></div>)}</div></section>
      {audience!=="backlog"&&<section className={styles.charts}>
        <article className={`${styles.chartCard} ${styles.monthTotalCard}`}><header><div><small>ОБЪЁМ</small><h2>ЭТрН за {periodName}</h2></div></header><div className={styles.singleBar}><strong>{totals.total}</strong><span><i style={{height:totals.total?"100%":"0"}}/></span><small>{periodShort}</small></div></article>
        <article className={`${styles.chartCard} ${styles.rankingCard}`}><header><div><small>РЕЙТИНГ</small><h2>{entityLabel} · титул {titleNumber}</h2></div><div className={styles.rankSwitch}><button className={rankingMode==="best"?styles.on:""} onClick={()=>setRankingMode("best")}>Топ‑5 лучших</button><button className={rankingMode==="worst"?styles.on:""} onClick={()=>setRankingMode("worst")}>Топ‑5 худших</button></div></header><div className={styles.rankBody}><div className={styles.miniDonut}><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="46"/><circle className={styles.donutValue} cx="60" cy="60" r="46" strokeDasharray={circumference} strokeDashoffset={circumference*(1-rankingPercent/100)}/></svg><div><strong>{rankingPercent}%</strong><span>{rankingSigned} из {rankingTotal}</span></div></div><ol>{ranked.map(row=><li key={row.key}><span title={row.name}>{row.name}</span><strong><small>{row.signed} / {row.total}</small>{row.percent}%</strong></li>)}{!ranked.length&&<li>Нет данных</li>}</ol></div></article>
        <article className={styles.chartCard}><header><div><small>ПОДПИСАНИЕ</small><h2>Доля подписанных · титул {titleNumber}</h2></div></header><div className={styles.donutWrap}><svg className={styles.donut} viewBox="0 0 120 120"><circle cx="60" cy="60" r="46"/><circle className={styles.donutValue} cx="60" cy="60" r="46" strokeDasharray={circumference} strokeDashoffset={circumference*(1-signedPercent/100)}/></svg><div className={styles.donutLabel}><strong>{signedPercent}%</strong><span>подписано</span></div></div><div className={styles.legend}><div><i className={styles.green}/><span>Подписано Т{titleNumber}</span><strong>{totals.signed}</strong></div><div><i className={styles.red}/><span>{audience==="carrier"?"Не подписано":"Отклонение"}</span><strong>{totals.unsigned}</strong></div></div></article>
      </section>}
      <section className={styles.carrierSection}><header><div><small>{audience==="consignee"?"ГРУЗОПОЛУЧАТЕЛИ":audience==="backlog"?"BACKLOG TMS":"ПЕРЕВОЗЧИКИ"}</small><h2>{audience==="backlog"?`Рейсы и выпуск ЭТрН за ${periodName}`:`Подписание титула ${titleNumber} за ${periodName}`}</h2><p>{audience==="backlog"?"Фактические рейсы взяты из ТТН/CMR по дате доставки на склад; рейсы без ЭТрН образуют backlog.":audience==="carrier"?"Учтены только ЭТрН с наступившей датой доставки.":"Отклонение — Т1 или Т2 подписан, дата доставки наступила, но Т3 не подписан."} Нажмите на строку для проверки реестра.</p></div><span>{audience==="backlog"?backlogRows.length:entities.length} {audience==="backlog"?(backlogMode==="carrier"?"перевозчиков":"грузополучателей"):audience==="consignee"?"грузополучателей":"перевозчиков"}</span></header>
        {audience==="backlog"&&<div className={styles.backlogToolbar}><div className={styles.backlogModeSwitch} role="group" aria-label="Разрез backlog"><button type="button" className={backlogMode==="carrier"?styles.on:""} aria-pressed={backlogMode==="carrier"} onClick={()=>{setBacklogMode("carrier");setExpanded(null)}}>Перевозчики</button><button type="button" className={backlogMode==="consignee"?styles.on:""} aria-pressed={backlogMode==="consignee"} onClick={()=>{setBacklogMode("consignee");setExpanded(null)}}>Грузополучатели</button></div><button type="button" className={styles.backlogExport} onClick={()=>void exportBacklog()} disabled={loading||exporting||!selectedTrips.length}>{exporting?"Готовим Excel…":"Выгрузить Excel с контейнерами"}</button></div>}
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
