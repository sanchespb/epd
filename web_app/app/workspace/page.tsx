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
type EditableField={id:string;label:string;hint?:string};
type WarningChoice={manualValues:Record<string,string>;saveManualValues:boolean}|null;
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
const clearSourceFiles=async()=>{const db=await openSourceDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction("files","readwrite");tx.objectStore("files").clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();};
type Source = { name: string; count: number; origin?: string; updatedAt?: string };
type Trip = Row & { _container: string; _recordId: string; _recordCount: number; _key: string; _cargo?: Row; _auto?: Row; _missingCargo?: boolean; _missingAuto?: boolean };
type DocumentKind = "cargo" | "order" | "empty" | "forwarding";
const documentKinds: {kind:DocumentKind;title:string;icon:string}[] = [
  {kind:"cargo",title:"ЭТрН на груз",icon:"Г"},
  {kind:"order",title:"Заявка перевозчику",icon:"З"},
  {kind:"empty",title:"ЭТрН на порожний",icon:"П"},
  {kind:"forwarding",title:"Поручение экспедитору",icon:"Э"},
];
const serviceOptions=["Организация автодоставки","Экспедирование","Перетарка"];

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
const cleanPoint = (text: string) => text.replace(/^\(RU\)\s*/i, "").replace(/\s+/g, " ").trim();
const routeStart = (row: Row | undefined) => cleanPoint(value(row, "Маршрут").split(/\s*(?:->|→|—>)\s*/)[0] || "");

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
  const [selectedDocs,setSelectedDocs]=useState<Record<string,DocumentKind>>({});
  const [forwardingServices,setForwardingServices]=useState<Record<string,string[]>>({});
  const [manualServices,setManualServices]=useState<Record<string,string>>({});
  const [documentPresence,setDocumentPresence]=useState<Record<string,{checking:boolean;found?:Partial<Record<DocumentKind,boolean>>;links?:Partial<Record<DocumentKind,string>>;error?:string}>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tmsBusy, setTmsBusy] = useState(false);
  const [restoreProgress,setRestoreProgress]=useState({active:true,completed:0,total:3,label:"Проверяем сохранённые справочники на сервере…"});
  const [tmsLogin, setTmsLogin] = useState("");
  const [tmsPassword, setTmsPassword] = useState("");
  const [tmsApiConfigured, setTmsApiConfigured] = useState<boolean | null>(null);
  const [tmsUsePersonal, setTmsUsePersonal] = useState(false);
  const [tmsCaptcha, setTmsCaptcha] = useState("");
  const [tmsCaptchaImage, setTmsCaptchaImage] = useState("");
  const [tmsCaptchaBusy, setTmsCaptchaBusy] = useState(false);
  const [tmsModalOpen, setTmsModalOpen] = useState(false);
  const [tmsStatuses, setTmsStatuses] = useState<Record<string,{state:"queued"|"working"|"saved"|"error";message:string;count?:number;progress?:number}>>({});
  const [generating, setGenerating] = useState("");
  const [outputFolder, setOutputFolder] = useState("");
  const [employee, setEmployee] = useState("Алексеев Михаил Геннадьевич");
  const [employees,setEmployees]=useState<string[]>([]);
  const [savingEmployee,setSavingEmployee]=useState(false);
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
  const warningResolverRef=useRef<((choice:WarningChoice)=>void)|null>(null);
  const [warningDialog,setWarningDialog]=useState<{open:boolean;container:string;kind:"cargo"|"empty"|"order";warnings:string[];fields:EditableField[]}>({open:false,container:"",kind:"cargo",warnings:[],fields:[]});
  const [warningValues,setWarningValues]=useState<Record<string,string>>({});
  const [rememberWarnings,setRememberWarnings]=useState(true);
  const [warningInputError,setWarningInputError]=useState("");
  useEffect(()=>{void fetch("/api/employees",{cache:"no-store"}).then(async response=>{if(!response.ok)throw new Error("Не удалось загрузить сотрудников");const result=await response.json() as {employees:string[]};setEmployees(result.employees||[]);}).catch(()=>setMessage("Не удалось загрузить справочник сотрудников."));},[]);
  const saveEmployee=async()=>{
    const name=employee.trim().replace(/\s+/g," ");
    if(!/^\S+(?:\s+\S+){1,3}$/.test(name)){setMessage("Укажите фамилию и имя сотрудника.");return;}
    setSavingEmployee(true);
    try{const response=await fetch("/api/employees",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});const result=await response.json() as {employees?:string[];error?:string};if(!response.ok)throw new Error(result.error||"Не удалось сохранить сотрудника");setEmployees(result.employees||[]);setEmployee(name);setMessage(`Сотрудник ${name} сохранён в справочнике.`);}
    catch(error){setMessage(error instanceof Error?error.message:"Не удалось сохранить сотрудника");}
    finally{setSavingEmployee(false);}
  };
  const requestWarningConfirmation=(container:string,kind:"cargo"|"empty"|"order",warnings:string[],fields:EditableField[])=>new Promise<WarningChoice>(resolve=>{
    warningResolverRef.current=resolve;
    setWarningValues({});setRememberWarnings(true);setWarningInputError("");
    setWarningDialog({open:true,container,kind,warnings,fields});
  });
  const closeWarningDialog=(choice:WarningChoice)=>{
    setWarningDialog(current=>({...current,open:false}));
    warningResolverRef.current?.(choice);
    warningResolverRef.current=null;
  };
  const applyWarningValues=()=>{
    const missing=warningDialog.fields.filter(field=>!warningValues[field.id]?.trim());
    if(missing.length){setWarningInputError(`Заполните поля: ${missing.map(field=>field.label).join(", ")}. Или выгрузите XML как есть.`);return;}
    closeWarningDialog({manualValues:warningValues,saveManualValues:rememberWarnings});
  };

  useEffect(() => {
    if(restoredRef.current) return; restoredRef.current=true;
    void (async()=>{
      try {
        setRestoreProgress({active:true,completed:0,total:3,label:"Проверяем сохранённые справочники на сервере…"});
        const statusResponse=await fetch("/api/tms-status");
        if(!statusResponse.ok) throw new Error("Статус TMS недоступен");
        const status=await statusResponse.json() as {configured:boolean;sources?:Record<string,{available:boolean;updatedAt:string,size?:number}|null>};
        setTmsApiConfigured(status.configured);
        if(!status.configured)setTmsUsePersonal(true);
        if(status.sources?.edo?.available)setEdoSource({name:"Контрагенты Диадок",count:0,origin:"Сохранён на сервере",updatedAt:status.sources.edo.updatedAt});
        const metadata=(kind:"cargo"|"auto"|"points",name:string)=>{const info=status.sources?.[kind];return info?.available?{name,count:0,origin:"Сохранён на сервере",updatedAt:info.updatedAt}:null;};
        const cargo=metadata("cargo","TMS · Грузы текущие"),auto=metadata("auto","TMS · ТТН / CMR"),routePoints=metadata("points","TMS · Точки маршрута");
        setCargoSource(cargo);setAutoSource(auto);setPointsSource(routePoints);
        setMessage("");
        setRestoreProgress({active:false,completed:3,total:3,label:cargo&&auto?"Данные TMS готовы":"Сохранённые справочники не найдены"});
      } catch { setTmsApiConfigured(false);setTmsUsePersonal(true);setMessage("");setRestoreProgress(current=>({...current,active:false,label:"Сохранённые справочники не найдены"})); }
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

  const resolveDeparture = (auto: Row | undefined) => {
    const direct = value(auto, "Адрес места отправления", "Адрес отправления");
    if (direct) return direct;
    const start = routeStart(auto);
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

  const refreshTmsCaptcha = async () => {
    if(!tmsLogin.trim()){setMessage("Сначала укажите логин TMS.");document.getElementById("tms-login")?.focus();return;}
    setTmsCaptchaBusy(true);
    try{
      const response=await fetch("/api/tms-captcha",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:tmsLogin.trim()})});
      const result=await response.json() as {image?:string;error?:string};
      if(!response.ok||!result.image)throw new Error(result.error||"Не удалось получить капчу TMS");
      setTmsCaptchaImage(result.image);setTmsCaptcha("");setMessage("Введите код с картинки TMS и повторите обновление.");
    }catch(error){setMessage(error instanceof Error?error.message:"Не удалось получить капчу TMS");}
    finally{setTmsCaptchaBusy(false);}
  };

  const updateFromTms = async () => {
    const usePersonal=tmsUsePersonal;
    if(usePersonal&&(!tmsLogin.trim()||!tmsPassword)){
      setMessage("Введите свой логин и пароль TMS перед обновлением.");
      document.getElementById("tms-credentials")?.setAttribute("open","");
      document.getElementById(tmsLogin.trim()?"tms-password":"tms-login")?.focus();
      return;
    }
    if(usePersonal&&tmsCaptchaImage&&!tmsCaptcha.trim()){setMessage("Введите код с картинки TMS.");document.getElementById("tms-captcha")?.focus();return;}
    const stageKeys=["login","cargo","auto","companies","vehicles","drivers","points","contracts","apply"];
    const initial:Record<string,{state:"queued";message:string}>={}; stageKeys.forEach(key=>initial[key]={state:"queued",message:"Ожидает"});
    setTmsStatuses(initial); setTmsModalOpen(true); setTmsBusy(true); setMessage(usePersonal?"Обновляем данные под вашей учётной записью TMS…":"Обновляем данные через API TMS…");
    let captchaRequired=false;
    try {
      const credentials=usePersonal?{mode:"personal",login:tmsLogin.trim(),password:tmsPassword,captcha:tmsCaptcha.trim()}:{mode:"api"};
      const response=await fetch("/api/tms-update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(credentials)});
      if(!response.ok||!response.body) throw new Error("Не удалось запустить обновление TMS");
      const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=""; let completeResult:Record<string,number>|null=null;
      const processLine=(line:string)=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==="status")setTmsStatuses(current=>({...current,[event.key]:{state:event.state,message:event.message,count:event.count,progress:event.progress}}));if(event.type==="fatal"){if(usePersonal&&event.captchaImage){captchaRequired=true;setTmsCaptchaImage(event.captchaImage);setTmsCaptcha("");setTmsModalOpen(false);window.setTimeout(()=>document.getElementById("tms-captcha")?.focus(),0);}throw new Error(event.error);}if(event.type==="complete")completeResult=event.result;};
      while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";for(const line of lines)processLine(line);if(done)break;} if(buffer)processLine(buffer);
      if(!completeResult) throw new Error("TMS не подтвердила завершение обновления");
      const statusResponse=await fetch("/api/tms-status",{cache:"no-store"});if(!statusResponse.ok)throw new Error("Данные обновлены, но их статус недоступен");
      const status=await statusResponse.json() as {sources?:Record<string,{available:boolean;updatedAt:string}|null>};
      const source=(kind:string,name:string)=>status.sources?.[kind]?.available?{name,count:0,origin:"Сохранён на сервере",updatedAt:status.sources[kind]!.updatedAt}:null;
      setCargoSource(source("cargo","TMS · Грузы текущие"));setAutoSource(source("auto","TMS · ТТН / CMR"));setPointsSource(source("points","TMS · Точки маршрута"));setResults([]);
      setTmsCaptchaImage("");setTmsCaptcha("");
      setMessage("Данные и справочники TMS успешно обновлены");
    } catch(error) { const reason=error instanceof Error?error.message:"Ошибка обновления TMS";const message=usePersonal?reason:`${reason} Если обновление через API не удалось, введите свой логин и пароль TMS.`;if(!usePersonal){setTmsUsePersonal(true);setTmsModalOpen(false);}setMessage(message);setTmsStatuses(current=>({...current,apply:{state:"error",message}})); }
    finally { setTmsBusy(false); if(!captchaRequired)setTmsPassword(""); }
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
    setEdoChoices(current=>{const next={...current};for(const trip of trips)next[trip._key]={loading:true,parties:current[trip._key]?.parties||[]};return next;});
    for(const trip of trips.filter(trip=>!trip._missingCargo&&!trip._missingAuto)){
      try{const response=await fetch("/api/edo-options",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({container:trip._container,recordId:trip._recordId,date:new Date().toISOString().slice(0,10),user:employee.trim()||"Пользователь"})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось получить ID ЭДО");setEdoChoices(current=>({...current,[trip._key]:{loading:false,parties:result.parties}}));}catch(error){setEdoChoices(current=>({...current,[trip._key]:{loading:false,parties:[],error:error instanceof Error?error.message:"Ошибка ID ЭДО"}}));}
    }
  };
  const saveEdoChoice=async(party:EdoParty,participantId:string)=>{
    if(!participantId)return;const previousId=party.selectedId;setEdoChoiceStatus(current=>({...current,[party.key]:"Сохраняем…"}));setEdoChoices(current=>Object.fromEntries(Object.entries(current).map(([container,state])=>[container,{...state,parties:state.parties.map(item=>item.key===party.key?{...item,selectedId:participantId}:item)}])));
    try{const response=await fetch("/api/edo-preference",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:party.key,participantId,selectedBy:employee.trim()||"Пользователь"})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось сохранить ID ЭДО");setEdoChoices(current=>Object.fromEntries(Object.entries(current).map(([container,state])=>[container,{...state,parties:state.parties.map(item=>item.key===party.key?{...item,selectedId:participantId,selectionSource:"manual",selectedBy:employee.trim()||"Пользователь",selectedAt:result.preference.selectedAt}:item)}])));setEdoChoiceStatus(current=>({...current,[party.key]:"✓ Сохранено"}));setMessage(`ID ЭДО для ${party.name} закреплён и будет использоваться после обновлений справочника.`);}catch(error){setEdoChoices(current=>Object.fromEntries(Object.entries(current).map(([container,state])=>[container,{...state,parties:state.parties.map(item=>item.key===party.key?{...item,selectedId:previousId}:item)}])));const text=error instanceof Error?error.message:"Не удалось сохранить ID ЭДО";setEdoChoiceStatus(current=>({...current,[party.key]:`Ошибка: ${text}`}));setMessage(text);}
  };
  const search = async () => {
    if (!ready) return setMessage("Данные TMS ещё не загружены. Проверьте статус рядом с поиском контейнеров.");
    const containers = Array.from(new Set(query.split(/[\s,;]+/).map(normalizeContainer).filter(Boolean)));
    if (!containers.length) return setMessage("Вставьте номера контейнеров в формате ABCD1234567");
    setBusy(true);setMessage("Ищем контейнеры в сохранённых данных TMS…");
    try{const response=await fetch("/api/trips/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({containers,user:employee.trim()||"Пользователь"})});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось выполнить поиск");const found=(result.items||[]).map((item:{container:string;recordId:string;recordCount:number;cargo?:Row;auto?:Row;missingCargo:boolean;missingAuto:boolean})=>({...item.cargo,...item.auto,_container:item.container,_recordId:item.recordId,_recordCount:item.recordCount,_key:`${item.container}#${item.recordId}`,_cargo:item.cargo,_auto:item.auto,_missingCargo:item.missingCargo,_missingAuto:item.missingAuto} as Trip));setResults(found);void loadEdoChoices(found);void checkDocumentPresence([...new Set(found.map((item:Trip)=>item._container))]);setMessage('Найдено перевозок: '+found.filter((item:Trip)=>!item._missingCargo&&!item._missingAuto).length+' для '+containers.length+' контейнеров');}catch(error){setMessage(error instanceof Error?error.message:"Не удалось выполнить поиск");}finally{setBusy(false);}
  };

  const checkDocumentPresence=async(containers:string[])=>{
    if(!kontur.connected||!containers.length)return;
    setDocumentPresence(current=>({...current,...Object.fromEntries(containers.map(container=>[container,{checking:true}]))}));
    try{
      const response=await fetchWithTimeout("/api/kontur/document-presence",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({containers})},45_000);
      const result=await response.json();if(!response.ok)throw new Error(result.error||"Проверка документов недоступна");
      setDocumentPresence(current=>({...current,...Object.fromEntries((result.items||[]).map((item:{container:string;found:Partial<Record<DocumentKind,boolean>>;links?:Partial<Record<DocumentKind,string>>})=>[item.container,{checking:false,found:item.found,links:item.links||{}}]))}));
    }catch(error){const message=error instanceof Error?error.message:"Проверка документов недоступна";setDocumentPresence(current=>({...current,...Object.fromEntries(containers.map(container=>[container,{checking:false,error:message}]))}));}
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
  const prepareDocument = async (trip: Trip, kind: DocumentKind) => {
    if (!employee.trim()) throw new Error("Укажите сотрудника, который формирует документ");
    if(kind==="forwarding"){
      const response=await fetch("/api/forwarding-order",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderNumber:trip._container,containers:[trip._container],recordId:trip._recordId,services:forwardingServices[trip._key]||[],user:employee.trim(),signer:employee.trim(),direction:"taglex_to_carrier"})});
      const result=await response.json();
      if(!response.ok||result.error)throw new Error(result.error||"Не удалось сформировать поручение");
      return result as {content:string;filename:string};
    }
    const row = { ...(trip._cargo ?? {}), ...(trip._auto ?? {}) };
      const requestDocument = async (confirmWarnings = false,choice?:Exclude<WarningChoice,null>) => {
        const response = await fetch("/api/generate", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({kind,container:trip._container,recordId:trip._recordId,row,date:new Date().toISOString().slice(0,10),user:employee.trim(),confirmWarnings,manualValues:choice?.manualValues,saveManualValues:choice?.saveManualValues}) });
        return {response,result:await response.json()};
      };
      let {response,result} = await requestDocument();
      if (result.requiresConfirmation) {
        const warnings = result.warnings as string[];
        const choice=await requestWarningConfirmation(trip._container,kind,warnings,result.editableFields as EditableField[]||[]);
        if (!choice) {
          throw new Error("Формирование отменено: необходимо дополнить данные");
        }
        ({response,result} = await requestDocument(true,choice));
      }
      if (!response.ok || result.error) throw new Error(result.error || "Не удалось сформировать документ");
      return result as {content:string;filename:string};
  };

  const generateDocument = async (trip: Trip, kind: DocumentKind, quiet = false) => {
    const key = trip._key + kind;
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

  const sendToKontur = async (trip:Trip,kind:DocumentKind) => {
    const key=trip._key+kind;
    const documentTitle=documentKinds.find(item=>item.kind===kind)?.title||kind;
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
      void checkDocumentPresence([trip._container]);
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
    const initial:Record<string,{state:"queued";text:string}>={}; readyTrips.forEach((trip)=>["cargo","order","empty"].forEach((kind)=>{initial[trip._key+kind]={state:"queued",text:"В очереди"};})); setDocStatuses(initial);
    setGenerating("all"); let done = 0; let failed = 0; const total = readyTrips.length * 3;
    for (const trip of readyTrips) for (const kind of ["cargo","order","empty"] as const) {
      setBulkProgress((done + failed) + " из " + total + " · " + trip._container + " · " + (kind === "cargo" ? "ЭТрН груз" : kind === "order" ? "Заявка" : "ЭТрН порожний"));
      (await generateDocument(trip, kind, true)) ? done++ : failed++;
    }
    setBulkProgress(""); setGenerating(""); setMessage("Готово: создано " + done + " документов" + (failed ? ", ошибок: " + failed : "") + ". Папка: " + outputFolder);
  };


  const kindTitle=(key:string)=>documentKinds.find(item=>key.endsWith(item.kind))?.title||"Документ";
  const keyContainer=(key:string)=>key.replace(/(cargo|order|empty|forwarding)$/,"");
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
  const tmsUpdatedAt=[cargoSource,autoSource,pointsSource].map(source=>source?.updatedAt||"").filter(Boolean).sort().at(-1);
  const updatedLabel=(value?:string)=>value?`Обновлены ${new Date(value).toLocaleString("ru-RU")}`:"Данные ещё не обновлялись";
  const tmsSearchStatus=tmsBusy?`Обновляем данные TMS · ${tmsProgressValue}%`:restoreProgress.active?`Загружаем сохранённые данные TMS · ${tmsProgressValue}%`:ready?`Данные TMS готовы · ${updatedLabel(tmsUpdatedAt)}`:"Данные TMS не загружены. Обновите их в «Настройках».";

  const renderTripCard=(trip:Trip)=>{
    const cargo=trip._cargo,auto=trip._auto,container=trip._container,recordKey=trip._key;
    const clientName=value(cargo,"Клиент")||value(auto,"Клиент")||"—";
    const consigneeFromTms=value(auto,"Грузополучатель");
    const consigneeName=consigneeFromTms||clientName;
    const carrierName=value(auto,"Исполнитель","Партнер","Перевозчик")||"—";
    const warehouse=value(cargo,"Место доставки на склад","Место доставки груза (Маршрут заказа)","Адрес доставки","Место прибытия")||value(auto,"Место прибытия");
    const stock=value(cargo,"Контейнерный сток")||value(auto,"Контейнерный сток");
    const transportReady=!trip._missingCargo&&!trip._missingAuto;
    const edoState=edoChoices[recordKey];
    const parties=edoState?.parties.filter(party=>party.role==="carrier"||party.role==="consignee")||[];
    const edoReady=Boolean(edoState&&!edoState.loading&&!edoState.error&&edoState.parties.length&&edoState.parties.every(party=>party.selectedId));
    const selected=selectedDocs[recordKey]||"cargo";
    const active=documentKinds.find(item=>item.kind===selected)!;
    const services=forwardingServices[recordKey]||[];
    const route=value(auto,"Маршрут")||"—";
    const loadingAddress=resolveDeparture(auto);
    const deliveryAddress=warehouse||value(auto,"Место прибытия")||"—";
    const departureDate=formatTmsDate(value(auto,"Плановая дата отправления"));
    const detailFacts=selected==="forwarding"?[
      ["КЛИЕНТ / ГРУЗООТПРАВИТЕЛЬ","Таглекс"],["ГРУЗОПОЛУЧАТЕЛЬ",consigneeName],["ЭКСПЕДИТОР",carrierName],
      ["МАРШРУТ",route],["ПУНКТ ПОГРУЗКИ",loadingAddress],["ПУНКТ ВЫГРУЗКИ",deliveryAddress],["ПОДАЧА ТС",departureDate],
    ]:selected==="order"?[
      ["ЗАКАЗЧИК","Таглекс"],["ПЕРЕВОЗЧИК",carrierName],["МАРШРУТ",route],["ПУНКТ ПОГРУЗКИ",loadingAddress],["ПУНКТ ВЫГРУЗКИ",deliveryAddress],["ПОДАЧА ТС",departureDate],
    ]:selected==="empty"?[
      ["ЗАКАЗЧИК","Таглекс"],["ПЕРЕВОЗЧИК",carrierName],["МАРШРУТ",route],["ПОГРУЗКА",loadingAddress],["СДАЧА ПОРОЖНЕГО",stock||"Нужно заполнить"],["ПОДАЧА ТС",departureDate],
    ]:[
      ["ГРУЗООТПРАВИТЕЛЬ","Таглекс"],["ГРУЗОПОЛУЧАТЕЛЬ",consigneeName],["ПЕРЕВОЗЧИК",carrierName],["МАРШРУТ",route],["ПУНКТ ПОГРУЗКИ",loadingAddress],["ПУНКТ ВЫГРУЗКИ",deliveryAddress],["ПОДАЧА ТС",departureDate],
    ];
    const statusText=(kind:DocumentKind)=>{
      const sent=konturStatuses[recordKey+kind],local=docStatuses[recordKey+kind];
      if(sent?.state==="saved")return "черновик создан";
      if(documentPresence[container]?.found?.[kind])return trip._recordCount>1?"есть по контейнеру":"есть";
      if(sent?.state==="working")return "передаём";
      if(local?.state==="saved")return "XML скачан";
      if(local?.state==="working")return "формируем";
      if(sent?.state==="error"||local?.state==="error")return "ошибка";
      return documentPresence[container]?.checking?"проверяем":documentPresence[container]?.found?"нет":"не проверено";
    };
    const addManualService=()=>{
      const name=(manualServices[recordKey]||"").trim().replace(/\s+/g," ");
      if(!name)return;
      setForwardingServices(current=>({...current,[recordKey]:[...new Set([...(current[recordKey]||[]),name])]}));
      setManualServices(current=>({...current,[recordKey]:""}));
    };
    return <article className={styles.tripCard} key={recordKey}>
      <header className={styles.tripCardHead}>
        <div><small>КОНТЕЙНЕР / НОМЕР</small><strong>{container}</strong>{trip._recordCount>1&&<small>ТТН/CMR № {trip._recordId} · {trip._recordCount} записи · статус документов по контейнеру</small>}</div>
        <div><small>ГРУЗОПОЛУЧАТЕЛЬ</small><strong>{consigneeName}</strong></div>
        <div className={styles.tripBadges}>{documentKinds.map(item=><span key={item.kind} title={documentPresence[container]?.error||undefined} className={konturStatuses[recordKey+item.kind]?.state==="saved"||documentPresence[container]?.found?.[item.kind]?styles.tripBadgeReady:styles.tripBadgePending}>{({cargo:"ЭТрН",order:"Заявка",empty:"ЭТрН пор.",forwarding:"ПЭ"} as Record<DocumentKind,string>)[item.kind]} — {statusText(item.kind)}</span>)}<button disabled={!kontur.connected||documentPresence[container]?.checking} onClick={()=>void checkDocumentPresence([container])}>Проверить в Контуре</button></div>
      </header>
      <div className={styles.tripCardBody}>
        <section className={styles.tripEdo} aria-label="Статус ЭДО участников">{edoState?.loading?<p>Проверяем ID ЭДО и историю подписей…</p>:edoState?.error?<p className={styles.edoError}>{edoState.error}</p>:parties.length?parties.map(party=>{const chosen=party.options.find(option=>option.id===party.selectedId);return <div key={party.role} className={!party.selectedId?styles.tripEdoMissing:""}><span><small>ЭДО · {party.role==="carrier"?"ПЕРЕВОЗЧИК":"ГРУЗОПОЛУЧАТЕЛЬ"}</small><strong>{party.name}</strong><em>{party.selectionSource==="history"?"Подтверждён подписью":party.selectionSource==="manual"?"Закреплён вручную":party.selectedId?"ID определён автоматически":party.options.length?"ID ЭДО не выбран":"ID ЭДО не найден"}</em>{chosen&&<small title={chosen.id}>{chosen.operator} · {chosen.id}</small>}</span>{party.options.length?<select value={party.selectedId} onChange={event=>{if(event.target.value)void saveEdoChoice(party,event.target.value);}}><option value="">Выберите ID</option>{party.options.map(option=><option key={option.id} value={option.id}>{option.operator} — {option.id}</option>)}</select>:<small className={styles.edoError}>Нет в справочнике ЭДО</small>}</div>;}):<p>Нет данных ЭДО</p>}</section>
        <div className={styles.tripCardGrid}>
          <section className={styles.tripDocuments}><h3>Документы по перевозке</h3>{documentKinds.map(item=><div key={item.kind} className={`${styles.tripDocumentRow} ${selected===item.kind?styles.tripDocumentActive:""}`}><button className={styles.tripDocumentSelect} onClick={()=>setSelectedDocs(current=>({...current,[recordKey]:item.kind}))}><b>{item.icon}</b><span>{item.title}</span></button><small className={konturStatuses[recordKey+item.kind]?.state==="saved"||documentPresence[container]?.found?.[item.kind]?styles.tripBadgeReady:styles.tripBadgePending}>{statusText(item.kind)}</small>{documentPresence[container]?.links?.[item.kind]&&<a className={styles.tripDocumentLink} href={documentPresence[container].links[item.kind]} target="_blank" rel="noopener noreferrer" title={`Открыть ${item.title} в Контуре`}>Открыть ↗</a>}<button className={styles.tripDocumentAction} disabled={!transportReady||!edoReady||Boolean(generating)} onClick={()=>void generateDocument(trip,item.kind)}>XML</button><button className={styles.tripDocumentAction} disabled={!transportReady||!edoReady||!kontur.connected||konturStatuses[recordKey+item.kind]?.state==="working"} onClick={()=>void sendToKontur(trip,item.kind)}>Контур</button></div>)}</section>
          <section className={styles.tripDetail}><h3>{active.title}</h3><p>Источник: TMS и сохранённые справочники. Проверьте сведения перед созданием черновика.</p>{selected==="forwarding"?<><div className={styles.tripDetailFacts}><span><small>КЛИЕНТ / ГРУЗООТПРАВИТЕЛЬ</small><strong>Таглекс</strong></span><span><small>ГРУЗОПОЛУЧАТЕЛЬ</small><strong>{consigneeName}</strong></span><span><small>ЭКСПЕДИТОР</small><strong>{carrierName} · из TMS</strong></span></div><div className={styles.tripServiceBox}><h4>Услуги для этого поручения</h4><p>Наименования попадут в титул клиента (Т1). Стоимость указывается экспедитором в ответном титуле (Т2).</p><div className={styles.tripServiceOptions}>{serviceOptions.map(option=><label key={option}><input type="checkbox" checked={services.includes(option)} onChange={()=>setForwardingServices(current=>({...current,[recordKey]:services.includes(option)?services.filter(item=>item!==option):[...services,option]}))}/>{option}</label>)}</div>{services.filter(item=>!serviceOptions.includes(item)).map(item=><button key={item} className={styles.tripServiceChip} onClick={()=>setForwardingServices(current=>({...current,[recordKey]:services.filter(value=>value!==item)}))}>{item} ×</button>)}<div className={styles.tripManualService}><input value={manualServices[recordKey]||""} onChange={event=>setManualServices(current=>({...current,[recordKey]:event.target.value}))} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();addManualService();}}} placeholder="Введите услугу вручную"/><button onClick={addManualService}>Добавить</button></div></div></>:<div className={styles.tripDetailFacts}><span><small>КЛИЕНТ</small><strong>{clientName}</strong></span><span><small>ГРУЗОПОЛУЧАТЕЛЬ</small><strong>{consigneeName}</strong></span><span><small>ПЕРЕВОЗЧИК</small><strong>{carrierName}</strong></span></div>}
          <div className={styles.tripDetailFacts}>{detailFacts.slice(selected==="forwarding"||selected==="cargo"?3:2).map(([label,fact])=><span key={label}><small>{label}</small><strong>{fact}</strong></span>)}</div>
          <div className={styles.tripDetailActions}><button disabled={!transportReady||!edoReady||Boolean(generating)} onClick={()=>void generateDocument(trip,selected)}>Скачать XML</button><button disabled={!transportReady||!edoReady||!kontur.connected||konturStatuses[recordKey+selected]?.state==="working"} onClick={()=>void sendToKontur(trip,selected)}>Создать черновик в Контуре</button></div>{!transportReady&&<p className={styles.edoError}>Для формирования нужны данные груза и ТТН/CMR.</p>}{transportReady&&!edoReady&&<p className={styles.edoError}>Сначала проверьте ID ЭДО участников.</p>}</section>
        </div>
        <details className={styles.tripFacts}><summary>Данные перевозки <small>Показать все сведения</small></summary><div><span><small>КЛИЕНТ</small><strong>{clientName}</strong></span><span><small>ГРУЗОПОЛУЧАТЕЛЬ</small><strong>{consigneeName}</strong><em>{consigneeFromTms?"Из ТТН / CMR":"Подставлен клиент"}</em></span><span><small>ПЕРЕВОЗЧИК</small><strong>{carrierName}</strong></span><span><small>МАРШРУТ</small><strong>{value(auto,"Маршрут")||"—"}</strong></span><span><small>АДРЕС ОТПРАВЛЕНИЯ</small><strong>{resolveDeparture(auto)}</strong></span><span><small>СКЛАД КЛИЕНТА</small><strong>{warehouse||"—"}</strong></span><span><small>ПОГРУЗКА</small><strong>{formatTmsDate(value(auto,"Плановая дата отправления"))}</strong></span><span><small>ВЫГРУЗКА</small><strong>{formatTmsDate(value(auto,"Плановая дата прибытия","Последняя план дата прибытия","ETA (план дата прибытия)"))}</strong></span><span><small>КОНТЕЙНЕРНЫЙ СТОК</small><strong>{stock||"Нужно заполнить"}</strong></span><span><small>ВОДИТЕЛЬ И ТС</small><strong>{value(auto,"Водитель")||"—"} · {value(auto,"Номер автомашины","Транспортное средство")||"—"}</strong></span></div></details>
      </div>
    </article>;
  };

  return <main className={styles.shell}>
    <header className={styles.topbar}><div className={styles.logo} style={{background:"transparent"}}><img src="/agr-logo.png" alt="Логотип АГР" width={40} height={40} style={{display:"block",objectFit:"contain"}}/></div><div><strong>Создание ЭПД</strong><span>версия {appPackage.version}</span></div><nav><a className={styles.activeTab} href="/workspace">Создание документов</a><a href="/forwarding-orders">Поручения клиентам</a><a href="/control">Контроль подписания</a><a href="/statistics">Статистика</a><a href="/edo-settings">ID ЭДО</a></nav><i/><details className={styles.headerService}><summary><div className={styles.serviceMeters}><span><b>TMS</b><progress value={tmsProgressValue} max={100}/><em>{tmsBusy||restoreProgress.active?tmsProgressValue+"%":ready?"готово":"нет данных"}</em></span><span><b>Контур</b>{konturChecking?<progress/>:<progress value={konturProgressValue} max={100}/>}<em>{konturChecking?"проверка":edoBusy?edoProgress+"%":kontur.connected?"подключён":"не подключён"}</em></span></div><b>Настройки</b></summary><section className={styles.serviceDrawer}>
      <section className={styles.compactSettingRow} aria-label="Контур">
        <div className={styles.settingIdentity}><b className={kontur.connected?styles.settingReady:styles.settingMissing}>{kontur.connected?"✓":"!"}</b><span><strong>Контур · {kontur.connected?"подключён":kontur.configured?"требуется вход":"не настроен"}</strong><small>{kontur.connected?(kontur.user?.name||"Пользователь Контур"):kontur.configured?"Войдите под своей учётной записью":"Настройте API на сервере"}{kontur.connected&&kontur.user?.email?` · ${kontur.user.email}`:""}</small></span></div>
        <div className={styles.settingActions}><span className={styles.settingStatus} role="status">{edoBusy?`Обновляем ЭДО · ${edoProgress}%`:edoSource?.updatedAt?`Контрагенты обновлены ${new Date(edoSource.updatedAt).toLocaleString("ru-RU")}`:"Контрагенты ещё не обновлены"}</span>{kontur.connected?<><button disabled={edoBusy} onClick={syncEdoFromKontur}>Обновить ЭДО</button><button className={styles.settingSecondary} onClick={()=>{window.location.href="/api/kontur/login";}}>Сменить вход</button></>:<button disabled={!kontur.configured} onClick={()=>{window.location.href="/api/kontur/login";}}>Войти в Контур</button>}</div>
      </section>
      <section className={styles.tmsPanel}>
        <div className={styles.compactSettingRow}><div className={styles.settingIdentity}><b className={ready?styles.settingReady:styles.settingMissing}>{ready?"✓":"!"}</b><span><strong>TMS · {ready?"данные загружены":"нет данных"}</strong><small>Грузы, ТТН/CMR и точки маршрута</small></span></div><div className={styles.settingActions}><span className={styles.settingStatus} role="status">{tmsBusy?`Обновляем · ${tmsProgressValue}%`:restoreProgress.active?`Загружаем · ${tmsProgressValue}%`:ready?updatedLabel(tmsUpdatedAt):"Нужно обновить данные"}</span><button disabled={tmsBusy || busy || tmsApiConfigured===null} onClick={updateFromTms}>{tmsBusy ? "Обновляем…" : "Обновить TMS"}</button></div></div>
        {restoreProgress.active&&<div className={styles.restoreProgress}><div><strong>{restoreProgress.label}</strong><small>{restoreProgress.completed} из {restoreProgress.total} справочников</small></div><progress value={restoreProgress.completed} max={restoreProgress.total}/></div>}
        <div className={styles.tmsSources}>
          {[{title:"Грузы → Текущие",source:cargoSource},{title:"ТТН / CMR",source:autoSource},{title:"Точки маршрута",source:pointsSource}].map(({title,source})=>
             <article key={title} className={source?styles.sourceReady:styles.sourceMissing}><b>{source?"✓":"—"}</b><span><strong>{title}</strong><small>{source?`Сохранён на сервере${source.count?` · ${source.count.toLocaleString("ru-RU")} строк`:""}`:"Нет сохранённых данных"}</small>{source?.updatedAt&&<em>{new Date(source.updatedAt).toLocaleString("ru-RU")}</em>}</span></article>
          )}
        </div>
         {tmsUsePersonal?<details id="tms-credentials" className={styles.tmsCredentials} open><summary>Личный вход TMS · запасной способ</summary><p>{tmsApiConfigured?"Вводите личный логин и пароль, только если обновление через API не получилось.":"На сервере не настроен вход через API. Введите свой логин и пароль TMS."} Если TMS запросит капчу, введите код с картинки и повторите обновление.</p><div><label><span>Ваш логин TMS</span><input id="tms-login" autoComplete="username" value={tmsLogin} onChange={event=>{setTmsLogin(event.target.value);setTmsCaptchaImage("");setTmsCaptcha("");}} placeholder="Ваш логин TMS" disabled={tmsBusy}/></label><label><span>Ваш пароль TMS</span><input id="tms-password" type="password" autoComplete="current-password" value={tmsPassword} onChange={event=>setTmsPassword(event.target.value)} placeholder="Ваш пароль TMS" disabled={tmsBusy}/></label></div>{tmsCaptchaImage&&<div className={styles.tmsCaptcha}><img src={tmsCaptchaImage} alt="Код с картинки TMS" width="150" height="50"/><label><span>Код с картинки</span><input id="tms-captcha" value={tmsCaptcha} onChange={event=>setTmsCaptcha(event.target.value)} autoComplete="off" disabled={tmsBusy}/></label><button type="button" onClick={refreshTmsCaptcha} disabled={tmsBusy||tmsCaptchaBusy}>{tmsCaptchaBusy?"Обновляем…":"Другая картинка"}</button></div>}{tmsApiConfigured&&<button type="button" className={styles.tmsApiRetry} onClick={()=>{setTmsUsePersonal(false);setTmsPassword("");setTmsCaptchaImage("");setTmsCaptcha("");}} disabled={tmsBusy}>Снова попробовать через API</button>}</details>:<details className={styles.tmsCredentials}><summary>Личный вход TMS · если API недоступен</summary><p>Обычно логин и пароль вводить не нужно. Используйте личный вход, только если обновление через API не удалось.</p><button type="button" className={styles.tmsApiRetry} onClick={()=>setTmsUsePersonal(true)}>Использовать личный вход</button></details>}
      </section>
        <details className={styles.manualPanel}><summary>Ручная загрузка и восстановление</summary><p>Используйте этот раздел, только если TMS или API Диадока временно недоступны.</p><div><button onClick={() => cargoRef.current?.click()}><strong>Реестр грузов</strong><small>{cargoSource?.name ?? "Выбрать OPERATION_UNIT"}</small></button><button onClick={() => autoRef.current?.click()}><strong>ТТН / CMR</strong><small>{autoSource?.name ?? "Выбрать OPERATION_SUB_DOC"}</small></button><button onClick={() => pointsRef.current?.click()}><strong>Точки маршрута</strong><small>{pointsSource?.name ?? "Выбрать LIST_WAREHOUSE"}</small></button><button onClick={()=>edoRef.current?.click()}><strong>Контрагенты ЭДО</strong><small>{edoSource?.count?`${edoSource.count.toLocaleString("ru-RU")} строк`:edoSource?.name??"Загрузить counteragents.csv"}</small></button><button onClick={()=>contractsRef.current?.click()}><strong>Договоры</strong><small>Загрузить LIST_CONTRACTS.xlsx или contracts.json</small></button><button className={styles.resetButton} onClick={resetSources}>Сбросить локальную базу</button></div><input ref={cargoRef} hidden type="file" accept=".xlsx,.xls" onChange={handleFile("cargo")}/><input ref={autoRef} hidden type="file" accept=".xlsx,.xls" onChange={handleFile("auto")}/><input ref={pointsRef} hidden type="file" accept=".xlsx,.xls" onChange={handleFile("points")}/><input ref={edoRef} hidden type="file" accept=".csv,text/csv" onChange={handleEdoFile}/><input ref={contractsRef} hidden type="file" accept=".xlsx,.xls,.json,application/json" onChange={handleContractsFile}/></details>

      </section></details></header>
    <section className={styles.content}>
      {(busy||message)&&<div className={styles.notice}>{busy ? "Читаем файл…" : message}</div>}

        <section className={styles.search}><label><strong>Номера контейнеров</strong><textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder={'WEDU8636223\nTGBU5962912'} autoFocus/></label><div className={styles.searchActions}><button onClick={search} disabled={!ready||busy}>Найти перевозки →</button><small aria-live="polite" role="status">{tmsSearchStatus}</small></div></section>
      {ready && <>
        {results.length>0&&<section className={styles.tripCards} aria-label="Найденные перевозки"><div className={styles.tripCardsTitle}><h2>Найденные перевозки</h2><small>Все сведения прежней таблицы находятся в карточках</small></div>{results.map(renderTripCard)}</section>}
        {results.length > 0 && <><section className={styles.bulkBar}><div><strong>Скачать XML документов</strong><small>{outputFolder ? "Папка: " + outputFolder : "Выберите папку для сохранения XML. Передача в Контур выполняется отдельными кнопками «Контур»."}</small></div><div className={styles.employeeField}><label htmlFor="employee-xml">Сотрудник для XML</label><input id="employee-xml" list="employee-options" value={employee} onChange={event=>setEmployee(event.target.value)} placeholder="Введите ФИО или выберите из списка" autoComplete="off"/><datalist id="employee-options">{employees.map(name=><option key={name} value={name}/>)}</datalist><button type="button" onClick={()=>void saveEmployee()} disabled={savingEmployee||!employee.trim()||employees.some(name=>name.toLocaleLowerCase("ru")===employee.trim().replace(/\s+/g," ").toLocaleLowerCase("ru"))}>{savingEmployee?"Сохраняем…":"Добавить в справочник"}</button><small>Выбранное ФИО попадёт в XML как работник погрузки и подписант. Добавление сохраняет его для следующих документов.</small></div><button className={styles.folderButton} onClick={chooseOutputFolder}>Выбрать папку</button><button className={styles.bulkButton} disabled={Boolean(generating)||results.some(trip=>{const state=edoChoices[trip._key];return !state||state.loading||Boolean(state.error)||!state.parties.length||state.parties.some(party=>!party.selectedId);})} onClick={generateAll}>{generating === "all" ? (bulkProgress || "Формируем…") : "Скачать все XML"}</button></section><section className={styles.results}><div className={styles.tableWrap}><table><thead><tr><th>Статус</th><th>Документы</th><th>Статус ЭДО ЭТрН</th><th>Контейнер</th><th>Клиент / грузополучатель</th><th>Перевозчик</th><th>Маршрут и адреса</th><th>Погрузка / выгрузка</th><th>Контейнерный сток</th><th>Водитель и ТС</th></tr></thead><tbody>{results.map((trip) => {
          const cargo = trip._cargo; const auto = trip._auto;
          const warehouse = value(cargo,"Место доставки на склад","Место доставки груза (Маршрут заказа)","Адрес доставки","Место прибытия") || value(auto,"Место прибытия");
          const stock = value(cargo,"Контейнерный сток") || value(auto,"Контейнерный сток");
          const clientName=value(cargo,"Клиент")||value(auto,"Клиент")||"—";const consigneeFromTms=value(auto,"Грузополучатель");const consigneeName=consigneeFromTms||clientName;
          const ok = !trip._missingCargo && !trip._missingAuto;
          const edoState=edoChoices[trip._key];const edoReady=Boolean(edoState&&!edoState.loading&&!edoState.error&&edoState.parties.length&&edoState.parties.every(party=>party.selectedId));const documentsReady=ok&&edoReady;const unresolvedEdo=edoState?.parties.filter(party=>!party.selectedId)||[];const edoIssue=edoState?.loading?"Проверяем операторов ЭДО":edoState?.error?edoState.error:unresolvedEdo.length?(unresolvedEdo.some(party=>!party.options.length)?"Нет ID ЭДО: ":"Выберите ID ЭДО: ")+[...new Set(unresolvedEdo.map(party=>party.name||party.role))].join(", "):"";
          const konturButton=(kind:"cargo"|"order"|"empty")=>{const status=konturStatuses[trip._key+kind];return <button className={styles.konturButton} disabled={!documentsReady||!kontur.connected||status?.state==="working"} title={!edoReady?"Сначала определите ID ЭДО всех участников":kontur.connected?"Создать черновик в Контур.Логистике":"Сначала подключите Контур"} onClick={()=>sendToKontur(trip,kind)} aria-label="Передать черновик в Контур">↗<small className={status?styles[status.state]:undefined}>{status?.text??"Контур"}</small></button>;};
          return <tr key={trip._key}><td>{(()=>{const summary=tripDocumentSummary(trip._container,ok,edoReady,Boolean(trip._missingCargo),Boolean(trip._missingAuto),edoIssue);return <span className={styles[summary.tone]}><strong>{summary.title}</strong><small>{summary.detail}</small></span>;})()}</td><td><div className={styles.docActions}><button disabled={!documentsReady || Boolean(generating)} onClick={() => generateDocument(trip,"cargo")}><b className={styles.documentIcon}>Г</b><span>ЭТрН</span><small className={styles[docStatuses[trip._key+"cargo"]?.state]}>{docStatuses[trip._key+"cargo"]?.text ?? "Не сформирован"}</small></button>{konturButton("cargo")}<button disabled={!documentsReady || Boolean(generating)} onClick={() => generateDocument(trip,"order")}><b className={styles.documentIcon}>З</b><span>ЭЗЗ</span><small className={styles[docStatuses[trip._key+"order"]?.state]}>{docStatuses[trip._key+"order"]?.text ?? "Не сформирована"}</small></button>{konturButton("order")}<button disabled={!documentsReady || Boolean(generating)} onClick={() => generateDocument(trip,"empty")}><b className={styles.documentIcon}>П</b><span>ЭТрН пор.</span><small className={styles[docStatuses[trip._key+"empty"]?.state]}>{docStatuses[trip._key+"empty"]?.text ?? "Не сформирован"}</small></button>{konturButton("empty")}</div></td><td><div className={styles.edoChoices}>{(()=>{const state=edoChoices[trip._key];const parties=state?.parties.filter(party=>party.role==="carrier"||party.role==="consignee")||[];if(state?.loading)return <small>Проверяем историю подписей…</small>;if(state?.error)return <small className={styles.edoError}>{state.error}</small>;if(!parties.length)return <span className={styles.edoAutomatic}>Нет данных</span>;return parties.map(party=>{const selected=party.options.find(option=>option.id===party.selectedId);const choiceStatus=edoChoiceStatus[party.key];return <label key={party.role}><span><b>{{client:"Заказчик",consignee:"Грузополучатель",carrier:"Перевозчик"}[party.role]}</b><small className={choiceStatus?.startsWith("Ошибка")?styles.edoError:undefined}>{choiceStatus||(party.selectionSource==="manual"?"Закреплён вручную":party.selectionSource==="history"?"Подтверждён подписью":party.selectedId?"Определён автоматически":"Нужно выбрать")}</small></span>{party.options.length===0?<span className={styles.edoMissing}>Нет в справочнике ЭДО</span>:party.options.length>1&&party.selectionSource==="unresolved"&&<select value={party.selectedId} onChange={event=>{const participantId=event.currentTarget.value;if(participantId)void saveEdoChoice(party,participantId);}}><option value="">Выберите оператора</option>{party.options.map(option=><option key={option.id} value={option.id}>{option.operator} — {option.id}</option>)}</select>}{selected&&<div className={styles.edoOperator}><strong>{selected.operator}</strong><small title={selected.id}>{selected.id}</small></div>}</label>});})()}</div></td><td><strong>{trip._container}</strong>{trip._recordCount>1&&<small>ТТН/CMR № {trip._recordId}</small>}</td><td className={styles.partyCell}><span><b>Клиент</b><strong>{clientName}</strong></span><span><b>Грузополучатель</b><strong>{consigneeName}</strong><small>{!consigneeFromTms&&clientName!=="—"?"Подставлен клиент":"Из ТТН / CMR"}</small></span></td><td><strong>{value(auto,"Исполнитель","Партнер","Перевозчик") || '—'}</strong></td><td className={styles.routeCell}><strong>{value(auto,"Маршрут") || '—'}</strong><small><b>Отправление:</b> {resolveDeparture(auto)}</small><small><b>Склад клиента:</b> {warehouse || '—'}</small></td><td className={styles.tripDates}><span><b>Погрузка</b>{formatTmsDate(value(auto,"Плановая дата отправления"))}</span><span><b>Выгрузка</b>{formatTmsDate(value(auto,"Плановая дата прибытия","Последняя план дата прибытия","ETA (план дата прибытия)"))}</span></td><td><span className={styles.stockPreview} title={stock || undefined}>{stock || 'Нужно заполнить'}</span></td><td><strong>{value(auto,"Водитель") || '—'}</strong><small>{value(auto,"Номер автомашины","Транспортное средство")}</small></td></tr>;
        })}</tbody></table></div></section></>}
      </>}
    </section>
    {warningDialog.open && <div className={`${styles.modalBackdrop} ${styles.warningBackdrop}`}><section className={`${styles.statusModal} ${styles.warningGuide}`} role="dialog" aria-modal="true" aria-label="Проверка данных перед формированием"><header><div><small>ТРЕБУЕТСЯ ПРОВЕРКА</small><h2>{warningDialog.container}</h2><p>Недостающие сведения можно указать сейчас или выгрузить XML без них.</p></div><button aria-label="Закрыть" onClick={()=>closeWarningDialog(null)}>×</button></header><div className={styles.warningGuideBody}><ol>{warningDialog.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ol>{warningDialog.fields.length>0&&<section className={styles.warningEdit}><h3>Заполнить вручную</h3><div>{warningDialog.fields.map(field=><label key={field.id}><span>{field.label}</span><input value={warningValues[field.id]||""} placeholder={field.hint||"Введите значение"} onChange={event=>{setWarningValues(current=>({...current,[field.id]:event.target.value}));setWarningInputError("");}}/></label>)}</div><label className={styles.warningRemember}><input type="checkbox" checked={rememberWarnings} onChange={event=>setRememberWarnings(event.target.checked)}/> Запомнить исправления для следующих документов</label><p>Сохранённое подставляется только при отсутствии данных в TMS. Новые значения TMS всегда имеют приоритет.</p></section>}{warningInputError&&<p className={styles.warningInputError} role="alert">{warningInputError}</p>}{warningDialog.fields.length===0&&<p>Эти сведения пока нельзя изменить здесь. Проверьте черновик в Контуре перед подписанием.</p>}</div><footer><span>Неполный XML может потребовать правки в Контуре.</span><div><button className={styles.cancelButton} onClick={()=>closeWarningDialog(null)}>Отменить</button><button className={styles.cancelButton} onClick={()=>closeWarningDialog({manualValues:{},saveManualValues:false})}>Выгрузить XML как есть</button>{warningDialog.fields.length>0&&<button onClick={applyWarningValues}>Сохранить и сформировать XML</button>}</div></footer></section></div>}
    {tmsModalOpen && <div className={styles.modalBackdrop}><section className={styles.statusModal} role="dialog" aria-modal="true" aria-label="Статус обновления TMS"><header><div><small>ОБНОВЛЕНИЕ ИЗ TMS</small><h2>{tmsBusy?"Получаем актуальные данные":tmsStatusItems.some(item=>item.state==="error")?"Не удалось обновить данные":"Обновление завершено"}</h2><p>{tmsBusy?"В каждой строке показано, какой реестр сейчас читается и сколько строк уже получено.":message}</p></div><button onClick={()=>setTmsModalOpen(false)}>×</button></header><div className={styles.statusList}>{Object.entries(tmsStatuses).map(([key,status])=><article key={key} className={styles[status.state]}><b>{status.state==="saved"?"✓":status.state==="error"?"!":status.state==="working"?"…":"•"}</b><span><strong>{{login:"Вход в TMS",cargo:"Грузы → Текущие",auto:"ТТН / CMR",companies:"Контрагенты",vehicles:"Автомашины",drivers:"Водители",points:"Географические объекты",contracts:"Договоры",apply:"Применение справочников"}[key]||key}</strong><small>{status.state==="queued"?"В очереди":status.state==="working"?"Загружается":status.state==="saved"?"Готово":"Ошибка"}{status.count?` · ${status.count.toLocaleString("ru-RU")} строк`:""}</small>{status.state==="working"&&<progress value={status.progress??35} max={100}/>}</span><em>{status.message}</em></article>)}</div><footer><span>{Object.values(tmsStatuses).filter(item=>item.state==="saved").length} из {Object.keys(tmsStatuses).length} этапов завершено</span><button onClick={()=>setTmsModalOpen(false)}>{tmsBusy?"Скрыть окно":"Закрыть"}</button></footer></section></div>}
    {statusModalOpen && <div className={styles.modalBackdrop}><section className={styles.statusModal} role="dialog" aria-modal="true" aria-label="Статус формирования документов"><header><div><small>ФОРМИРОВАНИЕ ДОКУМЕНТОВ</small><h2>{generating==="all" ? "Документы формируются" : "Результат формирования"}</h2><p>{bulkProgress || message}</p></div><button onClick={()=>setStatusModalOpen(false)} disabled={generating==="all"}>×</button></header><div className={styles.statusList}>{Object.entries(docStatuses).map(([key,status])=><article key={key} className={styles[status.state]}><b>{status.state==="saved"?"✓":status.state==="error"?"!":status.state==="working"?"…":"•"}</b><span><strong>{keyContainer(key)}</strong><small>{kindTitle(key)}</small></span><em title={status.text}>{status.text}</em></article>)}</div><footer><span>{Object.values(docStatuses).filter(item=>item.state==="saved").length} сохранено · {Object.values(docStatuses).filter(item=>item.state==="error").length} ошибок</span><button onClick={()=>setStatusModalOpen(false)} disabled={generating==="all"}>{generating==="all"?"Дождитесь завершения":"Закрыть"}</button></footer></section></div>}
    {konturTransfer.open && <div className={styles.modalBackdrop}><section className={styles.statusModal} role="dialog" aria-modal="true" aria-label="Статус передачи в Контур"><header><div><small>ПЕРЕДАЧА В КОНТУР</small><h2>{konturTransfer.container} · {konturTransfer.documentTitle}</h2><p>{konturTransfer.summary}</p></div><button onClick={()=>setKonturTransfer(current=>({...current,open:false}))}>×</button></header><div className={styles.statusList}>{(["xml","connection","draft"] as TransferStepKey[]).map(step=>{const status=konturTransfer.steps[step];const title={xml:"Формирование XML",connection:"Подключение к Контур",draft:"Создание черновика"}[step];return <article key={step} className={styles[status.state]}><b>{status.state==="saved"?"✓":status.state==="error"?"!":status.state==="working"?"…":"•"}</b><span><strong>{title}</strong><small>{status.state==="queued"?"Ожидает":status.state==="working"?"Выполняется":status.state==="saved"?"Готово":"Ошибка"}</small></span><em title={status.message}>{status.message}</em></article>;})}</div><footer><span>{Object.values(konturTransfer.steps).filter(item=>item.state==="saved").length} из 3 этапов завершено</span><button onClick={()=>setKonturTransfer(current=>({...current,open:false}))}>{konturTransfer.busy?"Скрыть окно":"Закрыть"}</button></footer></section></div>}
  </main>;
}
