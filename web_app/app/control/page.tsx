"use client";

import { useEffect, useMemo, useState } from "react";
import baseStyles from "./control.module.css";
import groupStyles from "./control-groups.module.css";
import appPackage from "../../package.json";
import RevokeDialog from "./revoke-dialog";

type ControlItem={
  id:string;documentType:"ЭТрН"|"Заявка"|"Поручение экспедитору";workflowGroup:"incoming"|"outgoing"|null;direction:"incoming"|"outgoing"|null;agreed:boolean;serviceCost:string;number:string;container:string;client:string;carrier:string;consignee:string;
  waitingTitle:string;responsible:string;status:"overdue"|"dueSoon"|"waiting"|"agreed";statusText:string;controlDate:string;controlDateLabel:string;
  overdueText:string;messageId:string;entityId:string;sourceMessageId:string;sourceEntityId:string;documentUrl:string|null;
};
type ControlResponse={source:"kontur";generatedAt:string;connected:boolean;user:{name:string;email:string}|null;items:ControlItem[];note?:string};

const formatDate=(value:string)=>new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value));
const shortClientName=(value:string)=>value.replace(/ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ/giu,"").replace(/\bООО\b/giu,"").replace(/^[\s«»"']+|[\s«»"']+$/g,"").replace(/\s+/g," ")||value;
const styles={...baseStyles,...groupStyles};

export default function ControlPage(){
  const [data,setData]=useState<ControlResponse|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [filter,setFilter]=useState<"all"|"overdue"|"etrn"|"order"|"forwarding">("all");
  const [clientFilter,setClientFilter]=useState("all");
  const [directionFilter,setDirectionFilter]=useState<"all"|"outgoing"|"incoming">("all");
  const [query,setQuery]=useState("");
  const load=async(force=false)=>{setLoading(true);setError("");try{const response=await fetch(`/api/kontur/signing-control${force?"?refresh=1":""}`,{cache:"no-store"});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось получить статусы документов");setData(result);}catch(value){setData(null);setError(value instanceof Error?value.message:"Не удалось получить статусы документов");}finally{setLoading(false);}};
  const [revokeItem,setRevokeItem]=useState<ControlItem|null>(null);
  useEffect(()=>{void load();},[]);
  const items=useMemo(()=>{const search=query.trim().toLocaleLowerCase("ru-RU");return data?.items.filter(item=>(filter==="all"||filter==="overdue"&&item.status==="overdue"||filter==="etrn"&&item.documentType==="ЭТрН"||filter==="order"&&item.documentType==="Заявка"||filter==="forwarding"&&item.documentType==="Поручение экспедитору")&&(clientFilter==="all"||item.client===clientFilter)&&(directionFilter==="all"||item.documentType!=="Поручение экспедитору"||item.direction===directionFilter)).filter(item=>!search||[item.number,item.container,item.client,item.consignee,item.carrier].some(value=>value.toLocaleLowerCase("ru-RU").includes(search)))||[];},[data,filter,clientFilter,directionFilter,query]);
  const overdue=data?.items.filter(item=>item.status==="overdue").length||0;
  const etrn=data?.items.filter(item=>item.documentType==="ЭТрН").length||0;
  const orders=data?.items.filter(item=>item.documentType==="Заявка").length||0;
  const forwarding=data?.items.filter(item=>item.documentType==="Поручение экспедитору")||[];
  const incoming=forwarding.filter(item=>item.direction==="incoming").length;
  const outgoing=forwarding.filter(item=>item.direction==="outgoing").length;
  const clients=useMemo(()=>[...new Set((data?.items||[]).map(item=>item.client||"Клиент не определён"))].sort((a,b)=>a.localeCompare(b,"ru")),[data]);
  return <main className={styles.shell}>
      <header className={styles.topbar}><div className={styles.logo}>А</div><div><strong>Создание ЭПД</strong><span>версия {appPackage.version}</span></div><nav><a href="/workspace">Создание документов</a><a href="/forwarding-orders">Поручения клиентам</a><a className={styles.activeTab} href="/control">Контроль подписания</a><a href="/statistics">Статистика</a><a href="/edo-settings">Настройки ID ЭДО</a></nav><i/><b>{data?.connected?"Контур подключён":"Предварительный режим"}</b></header>
    <section className={styles.content}>
      <header className={styles.heading}><div><small>КОНТРОЛЬ ДОКУМЕНТООБОРОТА</small><h1>Неподписанные перевозочные документы</h1><p>ЭТрН, заявки и поручения экспедитору, по которым ожидается следующий титул или подпись.</p></div><button onClick={()=>load(true)} disabled={loading}>{loading?"Проверяем…":"Обновить статусы"}</button></header>
      {error&&<div className={styles.error}><span>{error}</span>{error.includes("Контур")&&<a style={{marginLeft:"auto",color:"#295d72",fontWeight:800}} href="/api/kontur/login?returnTo=/control">Войти через Контур</a>}</div>}
      <section className={`${styles.metrics} ${styles.compactMetrics}`}>
        <button className={filter==="overdue"?styles.selected:""} onClick={()=>setFilter("overdue")}><span>Просрочено</span><strong>{overdue}</strong><small>требуют внимания</small></button>
        <button className={filter==="etrn"?styles.selected:""} onClick={()=>setFilter("etrn")}><span>ЭТрН</span><strong>{etrn}</strong><small>ожидают титулы</small></button>
        <button className={filter==="order"?styles.selected:""} onClick={()=>setFilter("order")}><span>Заявки</span><strong>{orders}</strong><small>ожидают подпись</small></button>
        <button className={filter==="forwarding"?styles.selected:""} onClick={()=>{setFilter("forwarding");setDirectionFilter("all");}}><span>Поручения</span><strong>{forwarding.length}</strong><small>{outgoing} отправили · {incoming} получили</small></button>
      </section>
      {filter==="forwarding"&&<section className={styles.directionFilters}><button className={directionFilter==="all"?styles.selected:""} onClick={()=>setDirectionFilter("all")}>Все поручения <b>{forwarding.length}</b></button><button className={directionFilter==="outgoing"?styles.selected:""} onClick={()=>setDirectionFilter("outgoing")}>Отправили <b>{outgoing}</b></button><button className={directionFilter==="incoming"?styles.selected:""} onClick={()=>setDirectionFilter("incoming")}>Получили <b>{incoming}</b></button></section>}
      <section className={styles.clientFilters}><button className={clientFilter==="all"?styles.selected:""} onClick={()=>setClientFilter("all")}>Все клиенты <b>{data?.items.length||0}</b></button>{clients.map(client=><button key={client} className={clientFilter===client?styles.selected:""} onClick={()=>setClientFilter(client)} title={client}>{shortClientName(client)}<b>{data?.items.filter(item=>item.client===client).length||0}</b></button>)}</section>
      <section className={styles.panel}>
        <div className={styles.panelTitle}><div><strong>Документы в работе</strong><small>{data?`Проверено ${formatDate(data.generatedAt)}`:"Получаем данные…"}</small></div><label style={{position:"relative",width:"min(390px, 100%)",display:"flex",flexDirection:"column",gap:4}}><span style={{color:"#718087",fontSize:10,fontWeight:800}}>Поиск</span><input style={{width:"100%",height:40,padding:"0 40px 0 12px",border:"1px solid #295d7240",borderRadius:10,background:"#fff",color:"#152631",font:"inherit"}} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Контейнер, клиент или перевозчик"/>{query&&<button style={{position:"absolute",right:5,bottom:5,width:30,height:30,border:0,borderRadius:8,background:"#eef2f3",color:"#295d72",fontSize:18,cursor:"pointer"}} onClick={()=>setQuery("")} aria-label="Очистить поиск">×</button>}</label><span>{data?.user?.name?`Авторизация: ${data.user.name}`:"Контур не авторизован"}</span></div>
        <div className={styles.tableWrap}><table><thead><tr><th>Документ</th><th>Контейнер</th><th>Клиент</th><th>Грузополучатель / перевозчик</th>{filter==="forwarding"&&<th>Направление</th>}{filter==="forwarding"&&<th>Стоимость услуг</th>}<th>Ожидается</th><th>Контрольная дата</th><th>Статус</th><th>Документ</th></tr></thead><tbody>{!loading&&items.map(item=><tr key={item.id}><td><b>{item.documentType}</b><strong>{item.number}</strong><small>{item.messageId}</small></td><td><strong>{item.container}</strong></td><td>{item.client}</td><td>{item.documentType==="Поручение экспедитору"?item.carrier:item.consignee}<small>{item.carrier}</small></td>{filter==="forwarding"&&<td><b className={styles.titleBadge}>{item.direction==="incoming"?"Получили":"Отправили"}</b></td>}{filter==="forwarding"&&<td><strong className={item.serviceCost?undefined:styles.missingCost}>{item.serviceCost||"Не указана"}</strong>{item.agreed&&<small>Согласована</small>}</td>}<td><b className={styles.titleBadge}>{item.waitingTitle}</b></td><td><strong>{formatDate(item.controlDate)}</strong><small>{item.controlDateLabel}</small></td><td><span className={styles[item.status]}><b>{item.overdueText}</b><small>{item.statusText}</small></span></td><td><div className={styles.documentActions}>{item.documentUrl?<a href={item.documentUrl} target="_blank" rel="noreferrer">Открыть в Контуре ↗</a>:<button disabled>Ссылка недоступна</button>}{item.documentType==="Поручение экспедитору"&&item.direction==="outgoing"&&item.agreed&&<button onClick={()=>setRevokeItem(item)}>Отозвать</button>}</div></td></tr>)}{!loading&&!items.length&&<tr><td colSpan={10} className={styles.empty}>По выбранным фильтрам документов нет</td></tr>}</tbody></table></div>
      </section>
    </section>
    {revokeItem&&<RevokeDialog item={revokeItem} defaultSigner={data?.user?.name||""} onClose={()=>setRevokeItem(null)} onSent={()=>load(true)}/>}
  </main>;
}
