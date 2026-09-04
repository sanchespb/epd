"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import styles from "./workspace.module.css";
import appPackage from "../../package.json";

type Row = Record<string, unknown>;
type EdoOption={id:string;name:string;status:string;boxId:string;operator:string;history?:{count:number;lastSignedAt:string;documentNumber:string}|null};
type EdoParty={role:"client"|"consignee"|"carrier";name:string;inn:string;kpp:string;key:string;currentId:string;selectedId:string;selectionSource:"manual"|"history"|"automatic"|"unresolved";selectedBy:string;selectedAt:string;history?:{count:number;lastSignedAt:string;documentNumber:string};options:EdoOption[]};
type EdoChoiceState={loading:boolean;parties:EdoParty[];error?:string};
type TransferStepState = "queued" | "working" | "saved" | "error";
type TransferStepKey = "xml" | "connection" | "draft";
type KonturTransferState = {
  open:boolean; busy:boolean; container:string; documentTitle:string; summary:string;
  steps:Record<TransferStepKey,{state:TransferStepState;message:string}>;
};
type KonturStatus = {
  configured:boolean; connected:boolean; boxId:string;
  user:{name:string;email:string;username:string}|null;
  permissions:string[];
};
const emptyKonturTransferSteps=():KonturTransferState["steps"]=>({
  xml:{state:"queued",message:"Ожидает"},
  connection:{state:"queued",message:"Ожидает"},
  draft:{state:"queued",message:"Ожидает"},
});
const fetchWithTimeout=async(input:RequestInfo|URL,init:RequestInit,timeoutMs:number)=>{
  const controller=new AbortController(); const timeout=window.setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(input,{...init,signal:controller.signal});}finally{window.clearTimeout(timeout);}
};
type DirectoryHandle = { name:string; requestPermission?:(options:{mode:"readwrite"})=>Promise<"granted"|"denied"|"prompt">; getDirectoryHandle:(name:string,options:{create:boolean})=>Promise<DirectoryHandle>; getFileHandle:(name:string,options:{create:boolean})=>Promise<{createWritable:()=>Promise<{write:(data:Blob)=>Promise<void>;close:()=>Promise<void>}>}> };

const openSourceDb = () => new Promise<IDBDatabase>((resolve,reject) => {
  const request=indexedDB.open("agr-local-sources",1);
  request.onupgradeneeded=()=>{ if(!request.result.objectStoreNames.contains("files")) request.result.createObjectStore("files"); };
  request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
});
const saveSourceFile=async(key:string,file:File)=>{const db=await openSourceDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction("files","readwrite");tx.objectStore("files").put(file,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();};
const getSourceFile=async(key:string)=>{const db=await openSourceDb();const file=await new Promise<File|undefined>((resolve,reject)=>{const request=db.transaction("files").objectStore("files").get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return file;};
const clearSourceFiles=async()=>{const db=await openSourceDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction("files","readwrite");tx.objectStore("files").clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();};
type Source = { name: string; count: number; origin?: string; updatedAt?: string };
type Trip = Row & { _container: string; _cargo?: Row; _auto?: Row; _missingCargo?: boolean; _missingAuto?: boolean };

const value = (row: Row | undefined, ...keys: string[]) => {
  for (const key of keys) { const result = String(row?.[key] ?? "").trim(); if (result) return result; }
  return "";
};

const formatTmsDate = (input: unknown) => {
  const text=String(input??"").trim(); if(!text)return "—";
  const parsed=new Date(text);
  if(Number.isNaN(parsed.getTime()))return text;
  return new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Moscow"}).format(parsed);
};

const normalizeContainer = (input: unknown) => {
  const raw = String(input ?? "").toUpperCase().replace(/\s+/g, "");
  const match = raw.match(/[A-ZА-Я]{4}\d{7}/);
  if (!match) return "";
  const letters: Record<string, string> = { А:"A",В:"B",С:"C",Е:"E",Н:"H",К:"K",М:"M",О:"O",Р:"P",Т:"T",Х:"X",У:"Y" };
  return match[0].replace(/[АВСЕНКМОРТХУ]/g, (letter) => letters[letter] ?? letter);
};
const normalizeCompany=(input:unknown)=>String(input??"").toUpperCase().replace(/[«»"'.,()]/g," ").replace(/\b(ООО|АО|ПАО|ЗАО|ОАО)\b/g," ").replace(/\s+/g," ").trim();

const rowContainer = (row: Row) => {
  for (const key of ["Грузовая единица", "Номера грузовых единиц", "Номер грузовой единицы по заказу", "Контейнер", "Номер контейнера", "Импорт"]) {
    const found = normalizeContainer(row[key]); if (found) return found;
  }
  return "";
};

const cleanPoint = (text: string) => text.replace(/^\(RU\)\s*/i, "").replace(/\s+/g, " ").trim();
const routeStart = (row: Row | undefined) => cleanPoint(value(row, "Маршрут").split(/\s*(?:->|→|—>)\s*/)[0] || "");
const comparable = (text: string) => text.toLowerCase().replace(/[«»"'()]/g, "").replace(/\b(ооо|ао|пао|зао|инн|ru)\b/g, "").replace(/\d{10,12}/g, "").replace(/[^a-zа-я0-9]+/g, " ").trim();

function readWorkbook(file: File, expected: string) {
  return file.arrayBuffer().then((buffer) => {
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames.includes(expected) ? expected : workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json<Row>(workbook.Sheets[sheetName], { defval: "" });
  });
}

export default function Workspace() {
  const cargoRef = useRef<HTMLInputElement>(null);
  const autoRef = useRef<HTMLInputElement>(null);
  const pointsRef = useRef<HTMLInputElement>(null);
  const contractsRef = useRef<HTMLInputElement>(null);
  const edoRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<DirectoryHandle | null>(null);
  const containerFoldersRef = useRef<Record<string,DirectoryHandle>>({});
  const [cargoRows, setCargoRows] = useState<Row[]>([]);
  const [autoRows, setAutoRows] = useState<Row[]>([]);
  const [points, setPoints] = useState<Row[]>([]);
  const [cargoSource, setCargoSource] = useState<Source | null>(null);
  const [autoSource, setAutoSource] = useState<Source | null>(null);
  const [pointsSource, setPointsSource] = useState<Source | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Trip[]>([]);
  const [message, setMessage] = useState("Для начала подключите два реестра");
  const [busy, setBusy] = useState(false);
  const [tmsBusy, setTmsBusy] = useState(false);
  const [restoreProgress,setRestoreProgress]=useState({active:true,completed:0,total:3,label:"Проверяем сохранённые справочники на сервере…"});
  const [tmsLogin, setTmsLogin] = useState("");
  const [tmsPassword, setTmsPassword] = useState("");
  const [tmsModalOpen, setTmsModalOpen] = useState(false);
  const [tmsStatuses, setTmsStatuses] = useState<Record<string,{state:"queued"|"working"|"saved"|"error";message:string;count?:number;progress?:number}>>({});
  const [generating, setGenerating] = useState("");
  const [outputFolder, setOutputFolder] = useState("");
  const [employee, setEmployee] = useState("Алексеев Михаил Геннадьевич");
  const [bulkProgress, setBulkProgress] = useState("");
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [docStatuses, setDocStatuses] = useState<Record<string,{state:"queued"|"working"|"saved"|"error";text:string}>>({});
  const [kontur, setKontur] = useState<KonturStatus>({configured:false,connected:false,boxId:"",user:null,permissions:[]});
  const [konturChecking,setKonturChecking]=useState(true);
  const [edoSource,setEdoSource]=useState<Source|null>(null);
  const [edoBusy,setEdoBusy]=useState(false);
  const [edoProgress,setEdoProgress]=useState(0);
  const [edoChoices,setEdoChoices]=useState<Record<string,EdoChoiceState>>({});
  const [edoChoiceStatus,setEdoChoiceStatus]=useState<Record<string,string>>({});
  const [konturStatuses, setKonturStatuses] = useState<Record<string,{state:"working"|"saved"|"error";text:string}>>({});
  const [konturTransfer,setKonturTransfer]=useState<KonturTransferState>({open:false,busy:false,container:"",documentTitle:"",summary:"",steps:emptyKonturTransferSteps()});
  const restoredRef = useRef(false);
  const warningResolverRef=useRef<((confirmed:boolean)=>void)|null>(null);
  const [warningDialog,setWarningDialog]=useState<{open:boolean;container:string;kind:"cargo"|"empty"|"order";warnings:string[]}>({open:false,container:"",kind:"cargo",warnings:[]});
  const requestWarningConfirmation=(container:string,kind:"cargo"|"empty"|"order",warnings:string[])=>new Promise<boolean>(resolve=>{
    warningResolverRef.current=resolve;
    setWarningDialog({open:true,container,kind,warnings});
  });
  const closeWarningDialog=(confirmed:boolean)=>{
    setWarningDialog(current=>({...current,open:false}));
    warningResolverRef.current?.(confirmed);
    warningResolverRef.current=null;
  };

  useEffect(() => {
    if(restoredRef.current) return; restoredRef.current=true;
    void (async()=>{
      try {
        setRestoreProgress({active:true,completed:0,total:3,label:"Проверяем сохранённые справочники на сервере…"});
        const statusResponse=await fetch("/api/tms-status");
        if(!statusResponse.ok) throw new Error("Статус TMS недоступен");
        const status=await statusResponse.json() as {sources?:Record<string,{available:boolean;updatedAt:string,size?:number}|null>};
        if(status.sources?.edo?.available)setEdoSource({name:"Контрагенты Диадок",count:0,origin:"Сохранён на сервере",updatedAt:status.sources.edo.updatedAt});
        const restoreServer=async(kind:"cargo"|"auto"|"points",name:string)=>{
          const info=status.sources?.[kind];
          const title={cargo:"Грузы → Текущие",auto:"ТТН / CMR",points:"Точки маршрута"}[kind];
          if(!info?.available){setRestoreProgress(current=>({...current,completed:current.completed+1,label:`${title}: нет сохранённых данных`}));return false;}
          setRestoreProgress(current=>({...current,label:`Загружаем «${title}»…`}));
          const response=await fetch("/api/source-cache?kind="+kind);
          if(!response.ok){setRestoreProgress(current=>({...current,completed:current.completed+1,label:`${title}: ошибка загрузки`}));return false;}
          await load(kind,new File([await response.blob()],name),false,info.updatedAt);
          setRestoreProgress(current=>({...current,completed:current.completed+1,label:`${title}: загружен`}));
          return true;
        };
        const [serverCargo,serverAuto]=await Promise.all([restoreServer("cargo","TMS · Грузы текущие.xlsx"),restoreServer("auto","TMS · ТТН-CMR.xlsx")]);
        if(serverCargo&&serverAuto) {
          await restoreServer("points","TMS · Точки маршрута.xlsx");
          setMessage("Используются сохранённые на сервере данные TMS. Можно продолжать поиск.");
          setRestoreProgress(current=>({...current,active:false,completed:current.total,label:"Все справочники загружены"}));
          return;
        }
        const [cargo,auto,routePoints]=await Promise.all([getSourceFile("cargo"),getSourceFile("auto"),getSourceFile("points")]);
        if(cargo||auto) setMessage("Восстанавливаем ранее подключённые реестры…");
        if(cargo) await load("cargo",cargo); if(auto) await load("auto",auto); if(routePoints) await load("points",routePoints);
        if(cargo&&auto) setMessage("Реестры восстановлены из этого браузера. Можно продолжать поиск.");
        setRestoreProgress(current=>({...current,active:false,completed:current.total,label:"Восстановление завершено"}));
      } catch { setMessage("Сохранённых реестров пока нет. Обновите данные из TMS.");setRestoreProgress(current=>({...current,active:false,label:"Сохранённые справочники не найдены"})); }
    })();
  }, []);

  useEffect(() => {
    void fetch("/api/kontur/status",{cache:"no-store"}).then(async(response)=>{
      if(!response.ok) throw new Error("Статус Контур недоступен");
      const status=await response.json() as {configured:boolean;connected:boolean;boxId?:string;user?:KonturStatus["user"];permissions?:string[]};
      setKontur({configured:status.configured,connected:status.connected,boxId:status.boxId||"",user:status.user||null,permissions:status.permissions||[]});
      const parameters=new URLSearchParams(window.location.search);
      if(parameters.get("kontur")==="connected") setMessage("Контур подключён. Можно создавать черновики.");
      if(parameters.get("kontur")==="error") setMessage("Не удалось подключить Контур: "+(parameters.get("message")||"ошибка авторизации"));
      if(parameters.has("kontur")) window.history.replaceState({},document.title,window.location.pathname);
    }).catch(()=>setKontur({configured:false,connected:false,boxId:"",user:null,permissions:[]})).finally(()=>setKonturChecking(false));
  }, []);

  const resetSources=async()=>{await clearSourceFiles();setCargoRows([]);setAutoRows([]);setPoints([]);setCargoSource(null);setAutoSource(null);setPointsSource(null);setResults([]);setQuery("");setMessage("Сохранённые реестры удалены. Подключите актуальные файлы.");};

  const ready = Boolean(cargoSource && autoSource);
  const cargoIndex = useMemo(() => new Map<string,Row>(cargoRows.map((row):[string,Row] => [rowContainer(row),row]).filter(([key]) => Boolean(key))), [cargoRows]);
  const autoIndex = useMemo(() => {
    const map = new Map<string, Row>();
    const supplementalFields = ["Водитель","ФИО водителя","Телефон водителя","Номер автомашины","Транспортное средство","Номер прицепа"];
    const operationScore = (row: Row,expectedCarrier:string) =>
      (expectedCarrier&&normalizeCompany(value(row,"Исполнитель","Перевозчик"))===normalizeCompany(expectedCarrier) ? 100 : 0) +
      (value(row,"Водитель","ФИО водителя") ? 8 : 0) +
      (value(row,"Номер автомашины","Транспортное средство") ? 8 : 0) +
      (value(row,"Маршрут") ? 4 : 0) +
      (value(row,"Исполнитель","Перевозчик") ? 4 : 0) +
      (value(row,"Плановая дата отправления") ? 2 : 0) +
      (value(row,"Плановая дата прибытия") ? 2 : 0);
    autoRows.forEach((row) => {
      const key = rowContainer(row);
      if (!key) return;
      const expectedCarrier=value(cargoIndex.get(key),"Перевозчик","Исполнитель");
      const selected = map.get(key);
      if (!selected) { map.set(key, {...row}); return; }
      const preferCurrent = operationScore(row,expectedCarrier) > operationScore(selected,expectedCarrier);
      const preferred = preferCurrent ? {...row} : {...selected};
      const fallback = preferCurrent ? selected : row;
      const sameCarrier=normalizeCompany(value(preferred,"Исполнитель","Перевозчик"))===normalizeCompany(value(fallback,"Исполнитель","Перевозчик"));
      if(sameCarrier)supplementalFields.forEach((field) => {
        if (!value(preferred,field) && value(fallback,field)) preferred[field]=fallback[field];
      });
      map.set(key,preferred);
    });
    return map;
  }, [autoRows,cargoIndex]);

  const resolveDeparture = (auto: Row | undefined) => {
    const direct = value(auto, "Адрес места отправления", "Адрес отправления");
    if (direct) return direct;
    const start = routeStart(auto);
    if (points.length && start) {
      const needle = comparable(start);
      const match = points.find((row) => {
        const names = [value(row,"Название"), value(row,"Номер склада и название")].map(comparable).filter(Boolean);
        return names.some((name) => name === needle || name.includes(needle) || needle.includes(name));
      });
      const address = value(match, "Адрес на русском языке", "Адрес");
      if (address) return address;
    }
    return value(auto, "Место отправления") || start || "Адрес отправления не найден";
  };

  async function load(kind: "cargo" | "auto" | "points", file: File, cacheOnServer = true, updatedAt?: string) {
    setBusy(true);
    try {
      const expected = kind === "cargo" ? "OPERATION_UNIT" : kind === "auto" ? "OPERATION_SUB_DOC" : "LIST_WAREHOUSE";
      const rows = await readWorkbook(file, expected);
      if (!rows.length) throw new Error("В выбранном файле нет строк");
      const source={name:file.name,count:rows.length,origin:cacheOnServer?"Загружен вручную":"Сохранён на сервере",updatedAt};
      if (kind === "cargo") { setCargoRows(rows); setCargoSource(source); }
      if (kind === "auto") { setAutoRows(rows); setAutoSource(source); }
      if (kind === "points") { setPoints(rows); setPointsSource(source); }
      await saveSourceFile(kind,file);
      if(cacheOnServer) {
        const cached=await fetch("/api/cache-source?kind="+kind,{method:"POST",body:file});
        if(!cached.ok) throw new Error("Не удалось сохранить реестр на сервере");
      }
      setMessage(kind === "points" ? "Справочник точек маршрута подключён" : "Файл подключён. Добавьте второй обязательный реестр.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Не удалось прочитать файл"); }
    finally { setBusy(false); }
  }

  const updateFromTms = async () => {
    const stageKeys=["login","cargo","auto","companies","vehicles","drivers","points","contracts","apply"];
    const initial:Record<string,{state:"queued";message:string}>={}; stageKeys.forEach(key=>initial[key]={state:"queued",message:"Ожидает"});
    setTmsStatuses(initial); setTmsModalOpen(true); setTmsBusy(true); setMessage("Обновляем данные из TMS…");
    try {
      const response=await fetch("/api/tms-update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(tmsLogin && tmsPassword ? {login:tmsLogin,password:tmsPassword} : {})});
      if(!response.ok||!response.body) throw new Error("Не удалось запустить обновление TMS");
      const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=""; let completeResult:Record<string,number>|null=null;
      const processLine=(line:string)=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==="status")setTmsStatuses(current=>({...current,[event.key]:{state:event.state,message:event.message,count:event.count,progress:event.progress}}));if(event.type==="fatal")throw new Error(event.error);if(event.type==="complete")completeResult=event.result;};
      while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";for(const line of lines)processLine(line);if(done)break;} if(buffer)processLine(buffer);
      if(!completeResult) throw new Error("TMS не подтвердила завершение обновления");
      const [cargoResponse,autoResponse,pointsResponse]=await Promise.all([fetch("/api/source-cache?kind=cargo"),fetch("/api/source-cache?kind=auto"),fetch("/api/source-cache?kind=points")]);
      if(!cargoResponse.ok||!autoResponse.ok||!pointsResponse.ok) throw new Error("Данные получены, но сохранённые реестры не открылись");
      const stamp=new Date().toLocaleString("ru-RU");
      await load("cargo",new File([await cargoResponse.blob()],"TMS Грузы текущие · "+stamp+".xlsx"),false,new Date().toISOString());
      await load("auto",new File([await autoResponse.blob()],"TMS ТТН-CMR · "+stamp+".xlsx"),false,new Date().toISOString());
      await load("points",new File([await pointsResponse.blob()],"TMS Точки маршрута · "+stamp+".xlsx"),false,new Date().toISOString());
      setMessage("Данные и справочники TMS успешно обновлены");
    } catch(error) { const message=error instanceof Error?error.message:"Ошибка обновления TMS";setMessage(message);setTmsStatuses(current=>({...current,apply:{state:"error",message}})); }
    finally { setTmsBusy(false); }
  };

  const handleFile = (kind: "cargo" | "auto" | "points") => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (file) void load(kind, file);
  };

  const handleContractsFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file=event.target.files?.[0]; if(!file)return;
    try{
      const response=await fetch("/api/cache-source?kind=contracts",{method:"POST",body:file});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||"Не удалось загрузить справочник договоров");
      setMessage(result.unchanged?"Справочник договоров не изменился":"Справочник договоров сохранён и применён");
    }catch(error){setMessage(error instanceof Error?error.message:"Не удалось загрузить справочник договоров");}
    finally{event.target.value="";}
  };

  const handleEdoFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file=event.target.files?.[0];if(!file)return;setEdoBusy(true);
    try{const response=await fetch("/api/cache-source?kind=edo",{method:"POST",body:file});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось загрузить контрагентов");const count=Math.max(0,(await file.text()).split(/\r?\n/).filter(Boolean).length-1);setEdoSource({name:file.name,count,origin:"Загружен вручную",updatedAt:new Date().toISOString()});setMessage(result.unchanged?"Справочник контрагентов не изменился":`Справочник контрагентов сохранён: ${count.toLocaleString("ru-RU")} строк`);}catch(error){setMessage(error instanceof Error?error.message:"Не удалось загрузить контрагентов");}finally{setEdoBusy(false);event.target.value="";}
  };

  const syncEdoFromKontur = async () => {
    setEdoBusy(true);setEdoProgress(0);setMessage("Проверяем подключение к Диадоку…");
    try{const response=await fetch("/api/kontur/sync-counteragents",{method:"POST"});if(!response.ok||!response.body)throw new Error("Не удалось запустить обновление контрагентов");const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="",result:any=null;const processLine=(line:string)=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==="progress"){setEdoProgress(event.progress||0);setMessage(event.message);}if(event.type==="error")throw new Error(event.error);if(event.type==="complete")result=event.result;};while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";for(const line of lines)processLine(line);if(done)break;}if(buffer)processLine(buffer);if(!result)throw new Error("Диадок не подтвердил обновление");setEdoSource({name:"Контрагенты Диадок",count:result.count,origin:"Получен через API",updatedAt:result.updatedAt});setEdoProgress(100);setMessage(`Список контрагентов обновлён: ${result.received.toLocaleString("ru-RU")} из API, ${result.preserved.toLocaleString("ru-RU")} сохранено из CSV`);}catch(error){setMessage(error instanceof Error?error.message:"Не удалось обновить контрагентов");}finally{setEdoBusy(false);}
  };

  const loadEdoChoices=async(trips:Trip[])=>{
    setEdoChoices(current=>{const next={...current};for(const trip of trips)next[trip._container]={loading:true,parties:current[trip._container]?.parties||[]};return next;});
    for(const trip of trips.filter(trip=>!trip._missingCargo&&!trip._missingAuto)){
      try{const response=await fetch("/api/edo-options",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({container:trip._container,date:new Date().toISOString().slice(0,10),user:employee.trim()||"Пользователь"})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось получить ID ЭДО");setEdoChoices(current=>({...current,[trip._container]:{loading:false,parties:result.parties}}));}catch(error){setEdoChoices(current=>({...current,[trip._container]:{loading:false,parties:[],error:error instanceof Error?error.message:"Ошибка ID ЭДО"}}));}
    }
  };
  const saveEdoChoice=async(party:EdoParty,participantId:string)=>{
    if(!participantId)return;const previousId=party.selectedId;setEdoChoiceStatus(current=>({...current,[party.key]:"Сохраняем…"}));setEdoChoices(current=>Object.fromEntries(Object.entries(current).map(([container,state])=>[container,{...state,parties:state.parties.map(item=>item.key===party.key?{...item,selectedId:participantId}:item)}])));
    try{const response=await fetch("/api/edo-preference",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:party.key,participantId,selectedBy:employee.trim()||"Пользователь"})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось сохранить ID ЭДО");setEdoChoices(current=>Object.fromEntries(Object.entries(current).map(([container,state])=>[container,{...state,parties:state.parties.map(item=>item.key===party.key?{...item,selectedId:participantId,selectionSource:"manual",selectedBy:employee.trim()||"Пользователь",selectedAt:result.preference.selectedAt}:item)}])));setEdoChoiceStatus(current=>({...current,[party.key]:"✓ Сохранено"}));setMessage(`ID ЭДО для ${party.name} закреплён и будет использоваться после обновлений справочника.`);}catch(error){setEdoChoices(current=>Object.fromEntries(Object.entries(current).map(([container,state])=>[container,{...state,parties:state.parties.map(item=>item.key===party.key?{...item,selectedId:previousId}:item)}])));const text=error instanceof Error?error.message:"Не удалось сохранить ID ЭДО";setEdoChoiceStatus(current=>({...current,[party.key]:`Ошибка: ${text}`}));setMessage(text);}
  };
  const search = () => {
    if (!ready) return setMessage("Сначала подключите оба обязательных реестра");
    const containers = Array.from(new Set(query.split(/[\s,;]+/).map(normalizeContainer).filter(Boolean)));
    if (!containers.length) return setMessage("Вставьте номера контейнеров в формате ABCD1234567");
    const found = containers.map((container) => {
      const cargo = cargoIndex.get(container); const auto = autoIndex.get(container);
      return { ...(cargo ?? {}), ...(auto ?? {}), _container: container, _cargo: cargo, _auto: auto, _missingCargo: !cargo, _missingAuto: !auto } as Trip;
    });
    setResults(found);
    void loadEdoChoices(found);
    setMessage('Найдено в обоих реестрах: ' + found.filter((item) => !item._missingCargo && !item._missingAuto).length + ' из ' + containers.length);
  };

  const chooseOutputFolder = async () => {
    const picker = (window as unknown as {showDirectoryPicker?:()=>Promise<DirectoryHandle>}).showDirectoryPicker;
    if (!picker) return setMessage("Выбор папки поддерживается в Chrome и Edge");
    try { const handle = await picker(); outputRef.current = handle; setOutputFolder(handle.name); setMessage("Папка выбрана: " + handle.name); } catch { /* окно закрыто */ }
  };

  const ensureOutputFolderAccess = async () => {
    if (!outputRef.current) { await chooseOutputFolder(); }
    const handle=outputRef.current;
    if (!handle) return null;
    if (handle.requestPermission && await handle.requestPermission({mode:"readwrite"}) !== "granted") {
      setMessage("Доступ к папке не предоставлен. Выберите папку повторно."); return null;
    }
    return handle;
  };
  const prepareDocument = async (trip: Trip, kind: "cargo" | "empty" | "order") => {
    if (!employee.trim()) throw new Error("Укажите сотрудника, который формирует документ");
    const row = { ...(trip._cargo ?? {}), ...(trip._auto ?? {}) };
      const requestDocument = async (confirmWarnings = false) => {
        const response = await fetch("/api/generate", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({kind,container:trip._container,row,date:new Date().toISOString().slice(0,10),user:employee.trim(),confirmWarnings}) });
        return {response,result:await response.json()};
      };
      let {response,result} = await requestDocument();
      if (result.requiresConfirmation) {
        const warnings = result.warnings as string[];
        if (!await requestWarningConfirmation(trip._container,kind,warnings)) {
          throw new Error("Формирование отменено: необходимо дополнить данные");
        }
        ({response,result} = await requestDocument(true));
      }
      if (!response.ok || result.error) throw new Error(result.error || "Не удалось сформировать документ");
      return result as {content:string;filename:string};
  };

  const generateDocument = async (trip: Trip, kind: "cargo" | "empty" | "order", quiet = false) => {
    const key = trip._container + kind;
    setDocStatuses((current)=>({...current,[key]:{state:"working",text:"Формируется…"}}));
    if (!quiet) { setGenerating(key); setMessage("Формируем документ для " + trip._container + "…"); }
    try {
      const result=await prepareDocument(trip,kind);
      const bytes = Uint8Array.from(atob(result.content), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], {type:"application/xml"});
      if (outputRef.current) {
        const containerFolder = containerFoldersRef.current[trip._container] ?? await outputRef.current.getDirectoryHandle(trip._container, {create:true});
        const file = await containerFolder.getFileHandle(result.filename, {create:true});
        const writable = await file.createWritable(); await writable.write(blob); await writable.close();
      } else {
        const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = result.filename; link.click(); URL.revokeObjectURL(link.href);
      }
      setDocStatuses((current)=>({...current,[key]:{state:"saved",text:"Сохранён"}}));
      if (!quiet) setMessage("");
      return true;
    } catch (error) { const errorText=error instanceof Error ? error.message : "Ошибка формирования документа"; setDocStatuses((current)=>({...current,[key]:{state:"error",text:errorText}})); if (!quiet) {setMessage(errorText);setStatusModalOpen(true);} return false; }
    finally { if (!quiet) setGenerating(""); }
  };

  const sendToKontur = async (trip:Trip,kind:"cargo"|"empty"|"order") => {
    const key=trip._container+kind;
    const documentTitle=kind==="cargo"?"ЭТрН на груз":kind==="order"?"Заявка перевозчику":"ЭТрН на порожний";
    let currentStep:TransferStepKey="xml";
    const updateStep=(step:TransferStepKey,state:TransferStepState,message:string)=>setKonturTransfer(current=>({...current,steps:{...current.steps,[step]:{state,message}}}));
    setKonturStatuses(current=>({...current,[key]:{state:"working",text:"Передаём…"}}));
    setKonturTransfer({open:true,busy:true,container:trip._container,documentTitle,summary:"Подготавливаем документ для передачи",steps:{...emptyKonturTransferSteps(),xml:{state:"working",message:"Формируем XML из данных TMS и справочников"}}});
    try {
      const document=await prepareDocument(trip,kind);
      updateStep("xml","saved",`XML сформирован: ${document.filename}`);

      currentStep="connection"; updateStep("connection","working","Проверяем авторизацию и доступ к ящику Контур");
      setKonturTransfer(current=>({...current,summary:"Проверяем подключение к Контур.Логистике"}));
      const statusResponse=await fetchWithTimeout("/api/kontur/status",{cache:"no-store"},15_000);
      const status=await statusResponse.json();
      if(!statusResponse.ok||!status.connected) throw new Error(status.error||"Подключение к Контур истекло. Выполните вход заново.");
      updateStep("connection","saved",status.boxId?`Подключено к ящику ${status.boxId}`:"Авторизация подтверждена");

      currentStep="draft"; updateStep("draft","working","Передаём XML и ожидаем проверку документа в Диадоке");
      setKonturTransfer(current=>({...current,summary:"Создаём черновик в Контур.Логистике"}));
      const response=await fetchWithTimeout("/api/kontur/draft",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind,content:document.content,filename:document.filename})},15_000);
      const queued=await response.json();
      if(!response.ok||queued.error||!queued.jobId) throw new Error(queued.error||"Сервер не вернул номер операции");
      let result:{state?:string;message?:string;messageId?:string;error?:string}={};
      const pollingDeadline=Date.now()+130_000;
      while(Date.now()<pollingDeadline){
        await new Promise(resolve=>window.setTimeout(resolve,1_500));
        const statusResponse=await fetchWithTimeout(`/api/kontur/draft-status?jobId=${encodeURIComponent(queued.jobId)}`,{cache:"no-store"},10_000);
        result=await statusResponse.json();
        if(!statusResponse.ok||result.error) throw new Error(result.error||"Не удалось получить статус передачи");
        updateStep("draft","working",result.message||"Диадок обрабатывает документ");
        if(result.state==="saved") break;
        if(result.state==="error") throw new Error(result.message||"Диадок не создал черновик");
      }
      if(result.state!=="saved") throw new Error("Сервер не завершил создание черновика за отведённое время");
      updateStep("draft","saved",result.messageId?`Черновик создан, MessageId: ${result.messageId}`:"Черновик успешно создан");
      setKonturTransfer(current=>({...current,busy:false,summary:"Черновик успешно создан в Контур.Логистике"}));
      setKonturStatuses(current=>({...current,[key]:{state:"saved",text:"Черновик создан"}}));
      setMessage(`Черновик ${document.filename} создан в Контур.Логистике`);
    } catch(error) {
      const text=error instanceof DOMException&&error.name==="AbortError"?"Превышено время ожидания ответа. Проверьте доступность сервера и повторите передачу.":error instanceof Error?error.message:"Ошибка передачи в Контур";
      updateStep(currentStep,"error",text);
      setKonturTransfer(current=>({...current,busy:false,summary:`Передача остановлена на этапе «${currentStep==="xml"?"Формирование XML":currentStep==="connection"?"Подключение к Контур":"Создание черновика"}»`}));
      setKonturStatuses(current=>({...current,[key]:{state:"error",text}})); setMessage(text);
    }
  };

  const generateAll = async () => {
    const readyTrips = results.filter((trip) => !trip._missingCargo && !trip._missingAuto);
    if (!readyTrips.length) return setMessage("Нет готовых перевозок для формирования");
    const outputFolderHandle=await ensureOutputFolderAccess(); if(!outputFolderHandle)return;
    setStatusModalOpen(true);
    containerFoldersRef.current={};
    try { for(const trip of readyTrips) containerFoldersRef.current[trip._container]=await outputFolderHandle.getDirectoryHandle(trip._container,{create:true}); } catch(error) { const text=error instanceof Error?error.message:"Не удалось создать папки контейнеров"; setMessage(text); setGenerating(""); return; }
    const initial:Record<string,{state:"queued";text:string}>={}; readyTrips.forEach((trip)=>["cargo","order","empty"].forEach((kind)=>{initial[trip._container+kind]={state:"queued",text:"В очереди"};})); setDocStatuses(initial);
    setGenerating("all"); let done = 0; let failed = 0; const total = readyTrips.length * 3;
    for (const trip of readyTrips) for (const kind of ["cargo","order","empty"] as const) {
      setBulkProgress((done + failed) + " из " + total + " · " + trip._container + " · " + (kind === "cargo" ? "ЭТрН груз" : kind === "order" ? "Заявка" : "ЭТрН порожний"));
      (await generateDocument(trip, kind, true)) ? done++ : failed++;
    }
    setBulkProgress(""); setGenerating(""); setMessage("Готово: создано " + done + " документов" + (failed ? ", ошибок: " + failed : "") + ". Папка: " + outputFolder);
  };


  const kindTitle=(key:string)=>key.endsWith("cargo")?"ЭТрН груз":key.endsWith("order")?"Заявка перевозчику":"ЭТрН порожний";
  const keyContainer=(key:string)=>key.replace(/(cargo|order|empty)$/,"");
  const tripDocumentSummary=(container:string,transportReady:boolean,edoReady:boolean,missingCargo:boolean,missingAuto:boolean,edoIssue:string)=>{
    if(!transportReady)return {tone:"warning",title:"Недостаточно данных",detail:missingCargo?"Не найден груз":missingAuto?"Не найдена автоперевозка":"Не определены данные перевозки"};
    if(!edoReady)return {tone:"warning",title:"Недостаточно данных",detail:edoIssue||"Не определён ID ЭДО участника"};
    const documents=[{kind:"cargo",title:"ЭТрН на груз"},{kind:"order",title:"Заявка перевозчику"},{kind:"empty",title:"ЭТрН на порожний"}];
    const attempted=documents.map(item=>({...item,state:docStatuses[container+item.kind]?.state})).filter(item=>item.state);
    if(!attempted.length)return {tone:"rowPending",title:"Не сформировано",detail:"Выберите нужный документ"};
    const states=attempted.map(item=>item.state);
    const saved=states.filter(state=>state==="saved").length;
    const errors=states.filter(state=>state==="error").length;
    if(errors)return {tone:"rowError",title:"Есть ошибка",detail:`Ошибок: ${errors} из ${attempted.length}`};
    const active=attempted.find(item=>item.state==="working"||item.state==="queued");
    if(active)return {tone:"rowWorking",title:"Формируется",detail:active.title};
    if(attempted.length===3&&saved===3)return {tone:"ok",title:"Комплект готов",detail:"Создано 3 из 3"};
    return {tone:"ok",title:"Документ готов",detail:attempted.filter(item=>item.state==="saved").map(item=>item.title).join(", ")};
  };
  const tmsStatusItems=Object.values(tmsStatuses);
  const tmsProgressValue=tmsBusy&&tmsStatusItems.length?Math.round(tmsStatusItems.reduce((sum,item)=>sum+(item.state==="saved"||item.state==="error"?100:item.state==="working"?(item.progress??35):0),0)/tmsStatusItems.length):restoreProgress.active?Math.round(restoreProgress.completed/Math.max(1,restoreProgress.total)*100):ready?100:0;
  const konturProgressValue=edoBusy?edoProgress:kontur.connected?100:0;

  return <main className={styles.shell}>
    <header className={styles.topbar}><div className={styles.logo}>А</div><div><strong>Создание ЭПД</strong><span>версия {appPackage.version}</span></div><nav><a className={styles.activeTab} href="/workspace">Создание документов</a><a href="/control">Контроль подписания</a><a href="/edo-settings">Настройки ID ЭДО</a></nav><i/><b>{ready ? "База подключена" : "Нужны 2 файла"}</b></header>
    <section className={styles.content}>
      {(busy||message)&&<div className={styles.notice}>{busy ? "Читаем файл…" : message}</div>}
      <details className={styles.servicePanel}>
        <summary><span><strong>Служебные данные</strong><small>Сборка v{appPackage.version}</small></span><div className={styles.serviceMeters}><span><b>TMS</b><progress value={tmsProgressValue} max={100}/><em>{tmsBusy||restoreProgress.active?tmsProgressValue+"%":ready?"готово":"нет данных"}</em></span><span><b>Контур</b>{konturChecking?<progress/>:<progress value={konturProgressValue} max={100}/>}<em>{konturChecking?"проверка":edoBusy?edoProgress+"%":kontur.connected?"подключён":"не подключён"}</em></span></div><b>Настройки и обновление</b></summary>
      <section className={styles.konturPanel}>
        <div><b>{kontur.connected?"✓":"К"}</b><span><strong>Контур.Логистика</strong><small>{kontur.connected?(kontur.user?.name||"Пользователь Контур"):kontur.configured?"Требуется вход сотрудника":"Интеграция не настроена на сервере"}</small>{kontur.connected&&kontur.user?.email&&<em>{kontur.user.email}</em>}{kontur.connected&&<em>Разрешено приложению: {kontur.permissions.length?kontur.permissions.join(" · "):"доступ к ящику подтверждён"}</em>}</span></div>
        {!kontur.connected?<button disabled={!kontur.configured} onClick={()=>{window.location.href="/api/kontur/login";}}>{kontur.configured?"Войти через Контур":"Нет настроек API"}</button>:<div><button disabled={edoBusy} onClick={syncEdoFromKontur}>{edoBusy?`Обновляем · ${edoProgress}%`:"Обновить контрагентов"}</button>{edoSource?.updatedAt&&<small>Список обновлён {new Date(edoSource.updatedAt).toLocaleString("ru-RU")}</small>}{edoBusy&&<progress value={edoProgress} max={100}/>}</div>}
      </section>
      <section className={styles.tmsPanel}>
        <div className={styles.tmsBar}><div><strong>Сохранённые данные TMS</strong><small>После обновления доступны всем сотрудникам и автоматически открываются при следующем входе.</small></div><button disabled={tmsBusy || busy} onClick={updateFromTms}>{tmsBusy ? "Обновляем…" : ready ? "Обновить данные" : "Загрузить данные из TMS"}</button></div>
        {restoreProgress.active&&<div className={styles.restoreProgress}><div><strong>{restoreProgress.label}</strong><small>{restoreProgress.completed} из {restoreProgress.total} справочников</small></div><progress value={restoreProgress.completed} max={restoreProgress.total}/></div>}
        <div className={styles.tmsSources}>
          {[{title:"Грузы → Текущие",source:cargoSource},{title:"ТТН / CMR",source:autoSource},{title:"Точки маршрута",source:pointsSource}].map(({title,source})=>
            <article key={title} className={source?styles.sourceReady:styles.sourceMissing}><b>{source?"✓":"—"}</b><span><strong>{title}</strong><small>{source?`${source.count.toLocaleString("ru-RU")} строк · ${source.origin}`:"Нет сохранённых данных"}</small>{source?.updatedAt&&<em>Обновлено {new Date(source.updatedAt).toLocaleString("ru-RU")}</em>}</span></article>
          )}
        </div>
        <details className={styles.tmsCredentials}><summary>Данные входа TMS</summary><p>Заполняйте, только если доступ не настроен администратором сервера. Пароль не сохраняется в браузере.</p><div><label><span>Логин</span><input autoComplete="username" value={tmsLogin} onChange={event=>setTmsLogin(event.target.value)} placeholder="Логин TMS"/></label><label><span>Пароль</span><input type="password" autoComplete="current-password" value={tmsPassword} onChange={event=>setTmsPassword(event.target.value)} placeholder="Пароль TMS"/></label></div></details>
      </section>
        <details className={styles.manualPanel}><summary>Ручная загрузка и восстановление</summary><p>Используйте этот раздел, только если TMS или API Диадока временно недоступны.</p><div><button onClick={() => cargoRef.current?.click()}><strong>Реестр грузов</strong><small>{cargoSource?.name ?? "Выбрать OPERATION_UNIT"}</small></button><button onClick={() => autoRef.current?.click()}><strong>ТТН / CMR</strong><small>{autoSource?.name ?? "Выбрать OPERATION_SUB_DOC"}</small></button><button onClick={() => pointsRef.current?.click()}><strong>Точки маршрута</strong><small>{pointsSource?.name ?? "Выбрать LIST_WAREHOUSE"}</small></button><button onClick={()=>edoRef.current?.click()}><strong>Контрагенты ЭДО</strong><small>{edoSource?.count?`${edoSource.count.toLocaleString("ru-RU")} строк`:edoSource?.name??"Загрузить counteragents.csv"}</small></button><button onClick={()=>contractsRef.current?.click()}><strong>Договоры</strong><small>Загрузить LIST_CONTRACTS.xlsx или contracts.json</small></button><button className={styles.resetButton} onClick={resetSources}>Сбросить локальную базу</button></div><input ref={cargoRef} hidden type="file" accept=".xlsx,.xls" onChange={handleFile("cargo")}/><input ref={autoRef} hidden type="file" accept=".xlsx,.xls" onChange={handleFile("auto")}/><input ref={pointsRef} hidden type="file" accept=".xlsx,.xls" onChange={handleFile("points")}/><input ref={edoRef} hidden type="file" accept=".csv,text/csv" onChange={handleEdoFile}/><input ref={contractsRef} hidden type="file" accept=".xlsx,.xls,.json,application/json" onChange={handleContractsFile}/></details>

      </details>

      {!ready && <section className={styles.startPanel}><div className={styles.startTitle}><small>ШАГ 1</small><h2>Обновите данные из TMS</h2><p>Нажмите кнопку выше. После получения грузов и ТТН/CMR автоматически откроется поиск перевозок.</p></div></section>}

      {ready && <>
        <section className={styles.search}><label><strong>Номера контейнеров</strong><textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder={'WEDU8636223\nTGBU5962912'}/></label><button onClick={search}>Найти перевозки →</button></section>
        {results.length > 0 && <><section className={styles.bulkBar}><div><strong>Скачать XML документов</strong><small>{outputFolder ? "Папка: " + outputFolder : "Выберите папку для сохранения XML. Передача в Контур выполняется отдельными кнопками «Контур»."}</small></div><label className={styles.employeeField}><span>Сотрудник для XML</span><input value={employee} onChange={event=>setEmployee(event.target.value)} placeholder="Фамилия Имя Отчество"/><small>Будет указан работником погрузки и подписантом</small></label><button className={styles.folderButton} onClick={chooseOutputFolder}>Выбрать папку</button><button className={styles.bulkButton} disabled={Boolean(generating)||results.some(trip=>{const state=edoChoices[trip._container];return !state||state.loading||Boolean(state.error)||!state.parties.length||state.parties.some(party=>!party.selectedId);})} onClick={generateAll}>{generating === "all" ? (bulkProgress || "Формируем…") : "Скачать все XML"}</button></section><section className={styles.results}><div className={styles.tableWrap}><table><thead><tr><th>Контейнер</th><th>Клиент / грузополучатель</th><th>Перевозчик</th><th>Маршрут</th><th>Погрузка / выгрузка</th><th>Адрес отправления</th><th>Склад клиента</th><th>Контейнерный сток</th><th>Водитель и ТС</th><th>Оператор ЭДО</th><th>Документы</th><th>Статус</th></tr></thead><tbody>{results.map((trip) => {
          const cargo = trip._cargo; const auto = trip._auto;
          const warehouse = value(cargo,"Место доставки на склад","Место доставки груза (Маршрут заказа)","Адрес доставки","Место прибытия") || value(auto,"Место прибытия");
          const stock = value(cargo,"Контейнерный сток","Инструкция на сдачу порожнего","Перенаправление сдачи порожнего") || value(auto,"Контейнерный сток","Инструкция на сдачу порожнего","Перенаправление сдачи порожнего");
          const clientName=value(cargo,"Клиент")||value(auto,"Клиент")||"—";const consigneeFromTms=value(auto,"Грузополучатель");const consigneeName=consigneeFromTms||clientName;
          const ok = !trip._missingCargo && !trip._missingAuto;
          const edoState=edoChoices[trip._container];const edoReady=Boolean(edoState&&!edoState.loading&&!edoState.error&&edoState.parties.length&&edoState.parties.every(party=>party.selectedId));const documentsReady=ok&&edoReady;const unresolvedEdo=edoState?.parties.filter(party=>!party.selectedId)||[];const edoIssue=edoState?.loading?"Проверяем операторов ЭДО":edoState?.error?edoState.error:unresolvedEdo.length?(unresolvedEdo.some(party=>!party.options.length)?"Нет ID ЭДО: ":"Выберите ID ЭДО: ")+[...new Set(unresolvedEdo.map(party=>party.name||party.role))].join(", "):"";
          const konturButton=(kind:"cargo"|"order"|"empty")=>{const status=konturStatuses[trip._container+kind];return <button className={styles.konturButton} disabled={!documentsReady||!kontur.connected||status?.state==="working"} title={!edoReady?"Сначала определите ID ЭДО всех участников":kontur.connected?"Создать черновик в Контур.Логистике":"Сначала подключите Контур"} onClick={()=>sendToKontur(trip,kind)} aria-label="Передать черновик в Контур">↗<small className={status?styles[status.state]:undefined}>{status?.text??"Контур"}</small></button>;};
          return <tr key={trip._container}><td><strong>{trip._container}</strong></td><td className={styles.partyCell}><span><b>Клиент</b><strong>{clientName}</strong></span><span><b>Грузополучатель</b><strong>{consigneeName}</strong><small>{!consigneeFromTms&&clientName!=="—"?"Подставлен клиент":"Из ТТН / CMR"}</small></span></td><td><strong>{value(auto,"Исполнитель","Партнер","Перевозчик") || '—'}</strong></td><td>{value(auto,"Маршрут") || '—'}</td><td className={styles.tripDates}><span><b>Погрузка</b>{formatTmsDate(value(auto,"Плановая дата отправления"))}</span><span><b>Выгрузка</b>{formatTmsDate(value(auto,"Плановая дата прибытия","Последняя план дата прибытия","ETA (план дата прибытия)"))}</span></td><td>{resolveDeparture(auto)}</td><td>{warehouse || '—'}</td><td><span className={styles.stockPreview} title={stock || undefined}>{stock || 'Нужно заполнить'}</span></td><td><strong>{value(auto,"Водитель") || '—'}</strong><small>{value(auto,"Номер автомашины","Транспортное средство")}</small></td><td><div className={styles.edoChoices}>{(()=>{const state=edoChoices[trip._container];const parties=state?.parties.filter(party=>party.role==="carrier"||party.role==="consignee")||[];if(state?.loading)return <small>Проверяем историю подписей…</small>;if(state?.error)return <small className={styles.edoError}>{state.error}</small>;if(!parties.length)return <span className={styles.edoAutomatic}>Нет данных</span>;return parties.map(party=>{const selected=party.options.find(option=>option.id===party.selectedId);const choiceStatus=edoChoiceStatus[party.key];return <label key={party.role}><span><b>{{consignee:"Грузополучатель",carrier:"Перевозчик"}[party.role]}</b><small className={choiceStatus?.startsWith("Ошибка")?styles.edoError:undefined}>{choiceStatus||(party.selectionSource==="manual"?"Закреплён вручную":party.selectionSource==="history"?"Подтверждён подписью":party.selectedId?"Определён автоматически":"Нужно выбрать")}</small></span>{party.options.length===0?<span className={styles.edoMissing}>Нет в справочнике ЭДО</span>:party.options.length>1&&party.selectionSource==="unresolved"&&<select value={party.selectedId} onChange={event=>{const participantId=event.currentTarget.value;if(participantId)void saveEdoChoice(party,participantId);}}><option value="">Выберите оператора</option>{party.options.map(option=><option key={option.id} value={option.id}>{option.operator} — {option.id}</option>)}</select>}{selected&&<div className={styles.edoOperator}><strong>{selected.operator}</strong><small title={selected.id}>{selected.id}</small></div>}</label>});})()}</div></td><td><div className={styles.docActions}><button disabled={!documentsReady || Boolean(generating)} onClick={() => generateDocument(trip,"cargo")}><b className={styles.documentIcon}>Г</b><span>ЭТрН</span><small className={styles[docStatuses[trip._container+"cargo"]?.state]}>{docStatuses[trip._container+"cargo"]?.text ?? "Не сформирован"}</small></button>{konturButton("cargo")}<button disabled={!documentsReady || Boolean(generating)} onClick={() => generateDocument(trip,"order")}><b className={styles.documentIcon}>З</b><span>ЭЗЗ</span><small className={styles[docStatuses[trip._container+"order"]?.state]}>{docStatuses[trip._container+"order"]?.text ?? "Не сформирована"}</small></button>{konturButton("order")}<button disabled={!documentsReady || Boolean(generating)} onClick={() => generateDocument(trip,"empty")}><b className={styles.documentIcon}>П</b><span>ЭТрН пор.</span><small className={styles[docStatuses[trip._container+"empty"]?.state]}>{docStatuses[trip._container+"empty"]?.text ?? "Не сформирован"}</small></button>{konturButton("empty")}</div></td><td>{(()=>{const summary=tripDocumentSummary(trip._container,ok,edoReady,Boolean(trip._missingCargo),Boolean(trip._missingAuto),edoIssue);return <span className={styles[summary.tone]}><strong>{summary.title}</strong><small>{summary.detail}</small></span>;})()}</td></tr>;
        })}</tbody></table></div></section></>}
      </>}
    </section>
    {warningDialog.open && <div className={`${styles.modalBackdrop} ${styles.warningBackdrop}` }><section className={`${styles.statusModal} ${styles.warningGuide}`} role="dialog" aria-modal="true" aria-label="Проверка данных перед формированием"><header><div><small>ТРЕБУЕТСЯ ПРОВЕРКА</small><h2>{warningDialog.container}</h2><p>{warningDialog.kind==="order"?"Перед формированием проверьте указанные данные.":"В черновике ЭТрН найдены данные, которые необходимо заполнить или проверить вручную."}</p></div><button onClick={()=>closeWarningDialog(false)}>×</button></header><div className={styles.warningGuideBody}><ol>{warningDialog.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ol>{warningDialog.warnings.some(item=>item.includes("ФИАС"))&&<section className={styles.fiasGuide}><h3>Как скорректировать адрес в заявке</h3><div><figure><img src="/fias-guide-route.png" alt="Меню редактирования адреса точки маршрута"/><figcaption><b>1.</b> В разделе «Маршрут» откройте меню нужной точки и нажмите «Редактировать».</figcaption></figure><figure><img src="/fias-guide-select.png" alt="Выбор адреса из справочника ФИАС"/><figcaption><b>2.</b> В поле «Адрес» выберите предложенный вариант из справочника. После выбора ниже появится код ФИАС.</figcaption></figure></div></section>}{warningDialog.kind!=="order"&&<section className={styles.etrnGuide}><h3>Как дополнить ЭТрН перед подписанием</h3><p>Черновик можно сформировать с перечисленными неточностями. При попытке подписать накладную Контур подсветит разделы и поля, которые необходимо заполнить вручную.</p><div><figure><img src="/etrn-guide-edit.png" alt="Меню редактирования черновика ЭТрН"/><figcaption><b>1.</b> В списке документов откройте меню ЭТрН и нажмите «Редактировать».</figcaption></figure><figure><img src="/etrn-guide-required.png" alt="Подсветка незаполненных полей ЭТрН"/><figcaption><b>2.</b> При попытке подписания красные счетчики покажут разделы с ошибками, а незаполненные поля будут выделены красной рамкой.</figcaption></figure></div></section>}</div><footer><span>Продолжайте только после проверки данных</span><div><button className={styles.cancelButton} onClick={()=>closeWarningDialog(false)}>Отменить</button><button onClick={()=>closeWarningDialog(true)}>Продолжить формирование</button></div></footer></section></div>}
    {tmsModalOpen && <div className={styles.modalBackdrop}><section className={styles.statusModal} role="dialog" aria-modal="true" aria-label="Статус обновления TMS"><header><div><small>ОБНОВЛЕНИЕ ИЗ TMS</small><h2>{tmsBusy?"Получаем актуальные данные":"Обновление завершено"}</h2><p>{tmsBusy?"В каждой строке показано, какой реестр сейчас читается и сколько строк уже получено.":message}</p></div><button onClick={()=>setTmsModalOpen(false)}>×</button></header><div className={styles.statusList}>{Object.entries(tmsStatuses).map(([key,status])=><article key={key} className={styles[status.state]}><b>{status.state==="saved"?"✓":status.state==="error"?"!":status.state==="working"?"…":"•"}</b><span><strong>{{login:"Вход в TMS",cargo:"Грузы → Текущие",auto:"ТТН / CMR",companies:"Контрагенты",vehicles:"Автомашины",drivers:"Водители",points:"Географические объекты",contracts:"Договоры",apply:"Применение справочников"}[key]||key}</strong><small>{status.state==="queued"?"В очереди":status.state==="working"?"Загружается":status.state==="saved"?"Готово":"Ошибка"}{status.count?` · ${status.count.toLocaleString("ru-RU")} строк`:""}</small>{status.state==="working"&&<progress value={status.progress??35} max={100}/>}</span><em>{status.message}</em></article>)}</div><footer><span>{Object.values(tmsStatuses).filter(item=>item.state==="saved").length} из {Object.keys(tmsStatuses).length} этапов завершено</span><button onClick={()=>setTmsModalOpen(false)}>{tmsBusy?"Скрыть окно":"Закрыть"}</button></footer></section></div>}
    {statusModalOpen && <div className={styles.modalBackdrop}><section className={styles.statusModal} role="dialog" aria-modal="true" aria-label="Статус формирования документов"><header><div><small>ФОРМИРОВАНИЕ ДОКУМЕНТОВ</small><h2>{generating==="all" ? "Документы формируются" : "Результат формирования"}</h2><p>{bulkProgress || message}</p></div><button onClick={()=>setStatusModalOpen(false)} disabled={generating==="all"}>×</button></header><div className={styles.statusList}>{Object.entries(docStatuses).map(([key,status])=><article key={key} className={styles[status.state]}><b>{status.state==="saved"?"✓":status.state==="error"?"!":status.state==="working"?"…":"•"}</b><span><strong>{keyContainer(key)}</strong><small>{kindTitle(key)}</small></span><em title={status.text}>{status.text}</em></article>)}</div><footer><span>{Object.values(docStatuses).filter(item=>item.state==="saved").length} сохранено · {Object.values(docStatuses).filter(item=>item.state==="error").length} ошибок</span><button onClick={()=>setStatusModalOpen(false)} disabled={generating==="all"}>{generating==="all"?"Дождитесь завершения":"Закрыть"}</button></footer></section></div>}
    {konturTransfer.open && <div className={styles.modalBackdrop}><section className={styles.statusModal} role="dialog" aria-modal="true" aria-label="Статус передачи в Контур"><header><div><small>ПЕРЕДАЧА В КОНТУР</small><h2>{konturTransfer.container} · {konturTransfer.documentTitle}</h2><p>{konturTransfer.summary}</p></div><button onClick={()=>setKonturTransfer(current=>({...current,open:false}))}>×</button></header><div className={styles.statusList}>{(["xml","connection","draft"] as TransferStepKey[]).map(step=>{const status=konturTransfer.steps[step];const title={xml:"Формирование XML",connection:"Подключение к Контур",draft:"Создание черновика"}[step];return <article key={step} className={styles[status.state]}><b>{status.state==="saved"?"✓":status.state==="error"?"!":status.state==="working"?"…":"•"}</b><span><strong>{title}</strong><small>{status.state==="queued"?"Ожидает":status.state==="working"?"Выполняется":status.state==="saved"?"Готово":"Ошибка"}</small></span><em title={status.message}>{status.message}</em></article>;})}</div><footer><span>{Object.values(konturTransfer.steps).filter(item=>item.state==="saved").length} из 3 этапов завершено</span><button onClick={()=>setKonturTransfer(current=>({...current,open:false}))}>{konturTransfer.busy?"Скрыть окно":"Закрыть"}</button></footer></section></div>}
  </main>;
}
