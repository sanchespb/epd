"use client";
import {useEffect,useMemo,useState} from "react";
import baseStyles from "./edo-settings.module.css";
import tableStyles from "./edo-table.module.css";
import appPackage from "../../package.json";

type History={count:number;lastSignedAt:string;documentNumber:string};
type Option={id:string;operator:string;boxId:string;history:History|null};
type Party={name:string;inn:string;kpp:string;key:string;selectedId:string;selectionSource:"manual"|"history"|"automatic"|"unresolved";selectedBy:string;selectedAt:string;options:Option[]};
const styles={...baseStyles,...tableStyles};

const selectedOption=(party:Party)=>party.options.find(option=>option.id===party.selectedId);
const confirmedParties=(parties:Party[])=>parties.flatMap(party=>{
  const option=selectedOption(party);
  return option && (party.options.length===1 || party.selectionSource==="manual" || (option.history?.count||0)>0) ? [{party,option,history:option.history}] : [];
});

export default function EdoSettings(){
  const [parties,setParties]=useState<Party[]>([]),[loading,setLoading]=useState(true),[query,setQuery]=useState(""),[message,setMessage]=useState("Ищем контрагентов с несколькими операторами…");
  const [showAll,setShowAll]=useState(false),[visibleLimit,setVisibleLimit]=useState(100);
  const [drafts,setDrafts]=useState<Record<string,string>>({}),[saving,setSaving]=useState(""),[expanded,setExpanded]=useState<Record<string,boolean>>({}),[exporting,setExporting]=useState(false);
  const load=async()=>{setLoading(true);try{const response=await fetch("/api/edo-directory",{cache:"no-store"});const result=await response.json();if(!response.ok)throw new Error(result.error);const loaded=result.parties||[];setParties(loaded);setMessage(`В справочнике ID ЭДО: ${loaded.length} контрагентов, из них ${loaded.filter((party:Party)=>party.options.length>1).length} с несколькими ID.`);}catch(error){setMessage(error instanceof Error?error.message:"Не удалось загрузить справочник");}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const multipleCount=useMemo(()=>parties.filter(party=>party.options.length>1).length,[parties]);
  const filtered=useMemo(()=>{const value=query.trim().toLocaleLowerCase("ru-RU");const visible=showAll||value?parties:parties.filter(party=>party.options.length>1);return !value?visible:visible.filter(party=>[party.name,party.inn,party.kpp,...party.options.flatMap(option=>[option.operator,option.id])].some(item=>String(item||"").toLocaleLowerCase("ru-RU").includes(value)));},[parties,query,showAll]);
  const visibleParties=useMemo(()=>filtered.slice(0,visibleLimit),[filtered,visibleLimit]);
  const confirmed=useMemo(()=>confirmedParties(parties),[parties]);
  const save=async(party:Party)=>{const participantId=drafts[party.key]||party.selectedId;if(!participantId)return;setSaving(party.key);try{const response=await fetch("/api/edo-preference",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:party.key,participantId,selectedBy:"Справочник настроек"})});const result=await response.json();if(!response.ok)throw new Error(result.error);setParties(current=>current.map(item=>item.key===party.key?{...item,selectedId:participantId,selectionSource:"manual",selectedBy:"Справочник настроек",selectedAt:result.preference.selectedAt}:item));setDrafts(current=>{const next={...current};delete next[party.key];return next;});setMessage(`Выбор для ${party.name} сохранён отдельно и не изменится при обновлении справочников.`);}catch(error){setMessage(error instanceof Error?error.message:"Не удалось сохранить выбор");}finally{setSaving("");}};
  const exportExcel=async()=>{if(!confirmed.length)return;setExporting(true);try{
    const XLSX=await import("xlsx");
    const rows=[["Название организации","ИНН","КПП","Оператор ЭДО","Идентификатор участника ЭДО","Основание подтверждения","Подписанных документов","Последняя подпись","Номер документа"],...confirmed.map(({party,option,history})=>[party.name,party.inn,party.kpp,option.operator,option.id,party.selectionSource==="manual"?"Ручной выбор":history?.count?"Подписанный документ":"Один ID ЭДО",history?.count||0,history?.lastSignedAt||"",history?.documentNumber||""])];
    const sheet=XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"]=[{wch:44},{wch:16},{wch:14},{wch:25},{wch:55},{wch:26},{wch:24},{wch:24},{wch:30}];
    const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,sheet,"Настроенные ID ЭДО");
    XLSX.writeFile(workbook,`edo-configured-${new Date().toISOString().slice(0,10)}.xlsx`);
    setMessage(`В Excel выгружено ${confirmed.length} контрагентов с настроенным подписанием.`);
  }catch(error){setMessage(error instanceof Error?error.message:"Не удалось выгрузить Excel");}finally{setExporting(false);}};
  return <main className={styles.shell}>
    <header className={styles.topbar}><div style={{background:"transparent"}}><img src="/agr-logo.png" alt="Логотип АГР" width={40} height={40} style={{display:"block",objectFit:"contain"}}/></div><strong>Создание ЭПД <small>версия {appPackage.version}</small></strong><nav><a href="/workspace">Создание документов</a><a href="/forwarding-orders">Поручения экспедиторам</a><a href="/control">Контроль подписания</a><a href="/statistics">Статистика</a><a className={styles.active} href="/edo-settings">Настройки ID ЭДО</a></nav></header>
    <section className={styles.content}><header className={styles.heading}><div><small>СПРАВОЧНИК</small><h1>Настройки ID для ЭПД</h1><p>По умолчанию показаны контрагенты с несколькими ID ЭДО. Откройте полный список или найдите любого контрагента по ИНН, названию, оператору или ID. Выбранный ID можно подтвердить или изменить вручную.</p></div><div className={styles.headingActions}><button type="button" className={styles.listToggle} aria-pressed={showAll} onClick={()=>{setShowAll(current=>!current);setVisibleLimit(100);}} disabled={loading}>{showAll?`Только несколько ID (${multipleCount})`:`Показать всех (${parties.length})`}</button><button type="button" onClick={()=>void load()} disabled={loading}>{loading?"Проверяем…":"Обновить историю"}</button><button type="button" onClick={()=>void exportExcel()} disabled={loading||exporting||!confirmed.length}>{exporting?"Готовим Excel…":`Выгрузить настроенных (${confirmed.length})`}</button></div></header>
      <div className={styles.toolbar}><input aria-label="Поиск по всем контрагентам, включая ИНН" inputMode="search" value={query} onChange={event=>{setQuery(event.target.value);setVisibleLimit(100);}} placeholder="Введите ИНН, название, оператор или ID ЭДО"/><span role="status">{query.trim()?`Найдено: ${filtered.length}`:message}</span></div>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Контрагент</th><th>ИНН / КПП</th><th>Варианты</th><th>Выбранный ID ЭДО</th><th>Подтверждение</th><th>Выбор</th></tr></thead><tbody>{visibleParties.map(party=>{const selected=selectedOption(party),chosen=drafts[party.key]??party.selectedId,changed=Boolean(drafts[party.key]&&drafts[party.key]!==party.selectedId),isExpanded=Boolean(expanded[party.key]);return <FragmentRow key={party.key} party={party} selected={selected} chosen={chosen} changed={changed} isExpanded={isExpanded} saving={saving===party.key} onToggle={()=>setExpanded(current=>({...current,[party.key]:!current[party.key]}))} onChoose={id=>setDrafts(current=>({...current,[party.key]:id}))} onSave={()=>void save(party)}/>;})}</tbody></table></div>
      {!loading&&!filtered.length&&<p className={styles.empty}>{query.trim()?"Контрагент не найден в текущем справочнике ID ЭДО. Проверьте ИНН или обновите справочник контрагентов.":"В выбранном списке нет контрагентов."}</p>}
      {visibleParties.length<filtered.length&&<button type="button" className={styles.showMore} onClick={()=>setVisibleLimit(current=>current+100)}>Показать ещё 100 · {visibleParties.length} из {filtered.length}</button>}
    </section>
  </main>;
}

function FragmentRow({party,selected,chosen,changed,isExpanded,saving,onToggle,onChoose,onSave}:{party:Party;selected:Option|undefined;chosen:string;changed:boolean;isExpanded:boolean;saving:boolean;onToggle:()=>void;onChoose:(id:string)=>void;onSave:()=>void}){
  const manual=party.selectionSource==="manual"&&Boolean(selected);
  const signed=(selected?.history?.count||0)>0;
  const canSave=Boolean(chosen)&&(changed||!manual);
  return <>
    <tr>
      <td><strong>{party.name}</strong></td>
      <td>{party.inn}<span className={styles.secondary}>{party.kpp}</span></td>
      <td>{party.options.length} ID</td>
      <td className={styles.idCell}>{selected?<><strong>{selected.operator}</strong><span className={styles.secondary}>{selected.id}</span></>:"Не выбран"}</td>
      <td>{manual?<><span className={styles.confirmed}>Подтверждено вручную</span>{signed&&<span className={styles.secondary}>{selected?.history?.count} подписанных документов</span>}</>:signed?<><span className={styles.confirmed}>Подтверждено подписью</span><span className={styles.secondary}>{selected?.history?.count} подписанных документов</span></>:<span className={styles.notConfirmed}>Нет подтверждения</span>}</td>
      <td><button type="button" className={styles.expand} aria-expanded={isExpanded} onClick={onToggle}>{isExpanded?"Скрыть варианты":"Выбрать ID"}</button></td>
    </tr>
    {isExpanded&&<tr className={styles.detailRow}><td colSpan={6}>
      <div className={styles.options}>{party.options.map(option=><label key={option.id} className={chosen===option.id?styles.selected:""}><input type="radio" name={party.key} checked={chosen===option.id} onChange={()=>onChoose(option.id)}/><span><strong>{option.operator}</strong><small>{option.id}</small></span><em>{option.history?`Подписанных документов: ${option.history.count}`:"Подтверждённых подписей нет"}</em></label>)}</div>
      <footer className={styles.saveBar}><span>{changed?"Новый ID выбран. Нажмите «Сохранить выбор».":manual?"Ручной выбор сохранён и считается подтверждением. ID можно изменить.":"Сохраните выбранный ID, чтобы подтвердить его вручную. Несохранённый выбор в Excel не попадёт."}</span><button disabled={!canSave||saving} onClick={onSave}>{saving?"Сохраняем…":changed?"Сохранить выбор":"Подтвердить выбор"}</button></footer>
    </td></tr>}
  </>;
}
