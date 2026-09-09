"use client";

import {useEffect,useMemo,useState} from "react";
import appPackage from "../../package.json";
import styles from "./page.module.css";

type Item={month:string;client:string;carrier:string;signed:boolean};
type Metric="total"|"signed"|"unsigned";

const monthName=(value:string,short=false)=>{
  const [year,month]=value.split("-").map(Number);
  return year&&month?new Intl.DateTimeFormat("ru-RU",short?{month:"short"}:{month:"long",year:"numeric"}).format(new Date(year,month-1,1)):value;
};

export default function Statistics(){
  const [items,setItems]=useState<Item[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [client,setClient]=useState("all");
  const [carrier,setCarrier]=useState("all");
  const [metric,setMetric]=useState<Metric>("total");

  const load=()=>{
    setLoading(true);setError("");
    void fetch("/api/kontur/statistics",{cache:"no-store"})
      .then(async response=>{const value=await response.json();if(!response.ok)throw new Error(value.error||"Не удалось загрузить статистику");setItems(value.items||[]);})
      .catch(value=>setError(value instanceof Error?value.message:"Ошибка загрузки"))
      .finally(()=>setLoading(false));
  };
  useEffect(load,[]);

  const clients=useMemo(()=>[...new Set(items.map(item=>item.client))].sort((a,b)=>a.localeCompare(b,"ru")),[items]);
  const carriers=useMemo(()=>[...new Set(items.map(item=>item.carrier))].sort((a,b)=>a.localeCompare(b,"ru")),[items]);
  const base=useMemo(()=>items.filter(item=>(client==="all"||item.client===client)&&(carrier==="all"||item.carrier===carrier)),[items,client,carrier]);
  const filtered=base;
  const totals=useMemo(()=>({
    total:filtered.length,
    signed:filtered.filter(i=>i.signed).length,
    unsigned:filtered.filter(i=>!i.signed).length
  }),[filtered]);
  const monthly=useMemo(()=>{
    const result=new Map<string,{month:string;total:number;signed:number;unsigned:number}>();
    for(const item of filtered){const row=result.get(item.month)||{month:item.month,total:0,signed:0,unsigned:0};row.total++;item.signed?row.signed++:row.unsigned++;result.set(item.month,row);}
    return [...result.values()].sort((a,b)=>a.month.localeCompare(b.month));
  },[filtered]);
  const chartMax=Math.max(1,...monthly.map(row=>row[metric]));
  const signedPercent=totals.total?Math.round(totals.signed/totals.total*100):0;
  const circumference=2*Math.PI*46;

  const EntityCharts=({title,field}:{title:string;field:"client"|"carrier"})=>{
    const names=[...new Set(base.map(item=>item[field]||"Не определён"))].sort((a,b)=>a.localeCompare(b,"ru"));
    const selected=field==="client"?client:carrier;
    const choose=field==="client"?setClient:setCarrier;
    return <section className={styles.entitySection}><header><div><small>ПОМЕСЯЧНО</small><h2>{title}</h2></div><span>Нажмите на график для фильтра</span></header><div className={styles.entityGrid}>{names.map(name=>{
      const own=base.filter(item=>(item[field]||"Не определён")===name);
      const byMonth=new Map<string,{total:number;signed:number}>();
      for(const item of own){const row=byMonth.get(item.month)||{total:0,signed:0};row.total++;if(item.signed)row.signed++;byMonth.set(item.month,row);}
      const rows=[...byMonth.entries()].sort(([a],[b])=>a.localeCompare(b));
      const max=Math.max(1,...rows.map(([,row])=>row.total));
      return <button key={name} className={selected===name?styles.entitySelected:""} onClick={()=>choose(selected===name?"all":name)}>
        <div className={styles.entityName}><strong title={name}>{name}</strong><span>{own.length} документов</span></div>
        <div className={styles.spark}>{rows.map(([month,row])=><div key={month}><span>{row.total}</span><i style={{height:`${Math.max(8,row.total/max*62)}px`}} title={`${monthName(month)}: ${row.total}, подписано ${row.signed}`}><b style={{height:`${row.total?row.signed/row.total*100:0}%`}}/></i><small>{monthName(month,true)}</small></div>)}</div>
      </button>;
    })}{!names.length&&<p className={styles.chartEmpty}>Нет данных</p>}</div></section>;
  };

  return <main className={styles.shell}>
    <header className={styles.topbar}><div>А</div><strong>Создание ЭПД <small>версия {appPackage.version}</small></strong><nav><a href="/workspace">Создание документов</a><a href="/forwarding-orders">Поручения клиентам</a><a href="/control">Контроль подписания</a><a className={styles.active} href="/statistics">Статистика</a><a href="/edo-settings">Настройки ID ЭДО</a></nav></header>
    <section className={styles.content}>
      <header className={styles.heading}><div><small>АНАЛИТИКА ЭТрН</small><h1>Статистика ЭТрН</h1><p>Помесячно по клиентам и перевозчикам, начиная с сентября 2026 года.</p></div><button onClick={load} disabled={loading}>{loading?"Считаем…":"Обновить"}</button></header>
      <section className={styles.filters}><label>Клиент<select value={client} onChange={event=>setClient(event.target.value)}><option value="all">Все клиенты</option>{clients.map(value=><option key={value}>{value}</option>)}</select></label><label>Перевозчик<select value={carrier} onChange={event=>setCarrier(event.target.value)}><option value="all">Все перевозчики</option>{carriers.map(value=><option key={value}>{value}</option>)}</select></label></section>
      {error&&<p className={styles.error}>{error}</p>}
      <section className={styles.metrics}>{[
        {name:"ЭТрН",value:totals.total},{name:"Подписано",value:totals.signed},{name:"Не подписано",value:totals.unsigned}
      ].map(card=><button key={card.name}><span>{card.name}</span><strong>{card.value}</strong></button>)}</section>

      <section className={styles.charts}>
        <article className={styles.chartCard}>
          <header><div><small>ДИНАМИКА</small><h2>Документы по месяцам</h2></div><div className={styles.switcher}>{([{key:"total",label:"Всего"},{key:"signed",label:"Подписано"},{key:"unsigned",label:"Не подписано"}] as {key:Metric;label:string}[]).map(option=><button key={option.key} className={metric===option.key?styles.on:""} onClick={()=>setMetric(option.key)}>{option.label}</button>)}</div></header>
          <div className={styles.barChart}>{monthly.map(row=>{const value=row[metric];return <div className={styles.barColumn} key={row.month}><div className={styles.barValue}>{value}</div><div className={styles.barTrack}><div className={styles.bar} style={{height:`${Math.max(value?5:0,value/chartMax*100)}%`}} title={`${monthName(row.month)}: ${value}`}/></div><span>{monthName(row.month,true)}</span></div>})}{!monthly.length&&<p className={styles.chartEmpty}>Нет данных</p>}</div>
        </article>
        <article className={styles.chartCard}>
          <header><div><small>ПОДПИСАНИЕ</small><h2>Доля подписанных</h2></div></header>
          <div className={styles.donutWrap}><svg className={styles.donut} viewBox="0 0 120 120"><circle cx="60" cy="60" r="46"/><circle className={styles.donutValue} cx="60" cy="60" r="46" strokeDasharray={circumference} strokeDashoffset={circumference*(1-signedPercent/100)}/></svg><div className={styles.donutLabel}><strong>{signedPercent}%</strong><span>подписано</span></div></div>
          <div className={styles.legend}><button onClick={()=>setMetric("signed")}><i className={styles.green}/><span>Подписано</span><strong>{totals.signed}</strong></button><button onClick={()=>setMetric("unsigned")}><i className={styles.red}/><span>Не подписано</span><strong>{totals.unsigned}</strong></button></div>
        </article>
      </section>

      <EntityCharts title="Клиенты" field="client"/>
      <EntityCharts title="Перевозчики" field="carrier"/>
    </section>
  </main>;
}
