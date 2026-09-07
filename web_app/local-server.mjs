import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as XLSX from "xlsx";
import { syncTms, contractRowsToCatalog } from "./tms-sync.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const appPackage = JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
const appBuild = process.env.APP_BUILD || process.env.GIT_COMMIT || spawnSync("git",["rev-parse","--short","HEAD"],{cwd:path.join(root,".."),encoding:"utf8"}).stdout?.trim() || "";
const localEnvFile = path.join(root,"..",".env");
if (fs.existsSync(localEnvFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(localEnvFile);
const clientRoot = path.join(root, "dist", "client");
const vinextCli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
const appPort = 3001;
const publicPort = Number(process.env.PORT || 3000);
const cacheRoot = path.join(root,"work","source-cache");
const credentialsFile = path.join(root,"work","tms-credentials.json");
const konturTokenFile = path.join(root,"work","kontur-tokens.json");
const referenceRoot = process.env.AGR_REFERENCES_DIR || path.join(root,"..","data","references");
const konturIdentityUrl = "https://identity.kontur.ru";
const diadocApiUrl = process.env.KONTUR_DIADOC_API_URL || "https://diadoc-api.kontur.ru";
const konturScopes = process.env.KONTUR_SCOPES || "openid profile email offline_access kl.public.api kl.transportations.orders.public.api Diadoc.PublicAPI";

const konturConfig = () => ({
  clientId: process.env.KONTUR_CLIENT_ID || "",
  clientSecret: process.env.KONTUR_CLIENT_SECRET || "",
  redirectUri: process.env.KONTUR_REDIRECT_URI || "",
  boxId: process.env.KONTUR_LOGISTICS_BOX_ID || "",
});
const requestCookies = (request) => Object.fromEntries(String(request.headers.cookie||"").split(";").map(item=>item.trim().split(/=(.*)/s)).filter(([key])=>key).map(([key,value])=>[key,decodeURIComponent(value||"")]));
const konturStateCookie = (state,maxAge=600) => {
  const secure=konturConfig().redirectUri.startsWith("https://")?"; Secure":"";
  return `kontur_oauth_state=${encodeURIComponent(state)}; Path=/api/kontur; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
};
function loadKonturTokens() {
  if (!fs.existsSync(konturTokenFile)) return null;
  try { return JSON.parse(fs.readFileSync(konturTokenFile,"utf8")); } catch { return null; }
}
function konturUserInfo(tokens) {
  try {
    const payload=String(tokens?.id_token||"").split(".")[1];
    if(!payload)return null;
    const normalized=payload.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(payload.length/4)*4,"=");
    const claims=JSON.parse(Buffer.from(normalized,"base64").toString("utf8"));
    return {name:claims.name||[claims.family_name,claims.given_name,claims.middle_name].filter(Boolean).join(" ")||claims.preferred_username||"Пользователь Контур",email:claims.email||"",username:claims.preferred_username||""};
  } catch { return null; }
}
const konturPermissionLabels=()=>{
  const scopes=new Set(konturScopes.split(/\s+/).filter(Boolean));
  return [
    scopes.has("Diadoc.PublicAPI")&&"Диадок API",
    scopes.has("kl.public.api")&&"Контур.Логистика",
    scopes.has("kl.transportations.orders.public.api")&&"Заявки перевозчику",
  ].filter(Boolean);
};
const konturReturnCookie=(returnTo,maxAge=600)=>{const secure=konturConfig().redirectUri.startsWith("https://")?"; Secure":"";return `kontur_return_to=${encodeURIComponent(returnTo)}; Path=/api/kontur; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;};
function saveKonturTokens(tokens) {
  fs.mkdirSync(path.dirname(konturTokenFile),{recursive:true});
  fs.writeFileSync(konturTokenFile,JSON.stringify(tokens),{encoding:"utf8",mode:0o600});
  try { fs.chmodSync(konturTokenFile,0o600); } catch { /* Windows does not support POSIX modes */ }
}
async function exchangeKonturToken(parameters) {
  const config=konturConfig();
  const response=await fetch(`${konturIdentityUrl}/connect/token`,{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},
    body:new URLSearchParams({...parameters,client_id:config.clientId,client_secret:config.clientSecret}),
    signal:AbortSignal.timeout(30_000),
  });
  const text=await response.text();
  let result; try { result=JSON.parse(text); } catch { result={error_description:text}; }
  if(!response.ok||!result.access_token) throw new Error(result.error_description||result.error||`Контур вернул HTTP ${response.status}`);
  const previous=loadKonturTokens()||{};
  const tokens={...previous,...result,expires_at:Date.now()+Number(result.expires_in||3600)*1000};
  saveKonturTokens(tokens); return tokens;
}
async function getKonturAccessToken() {
  const tokens=loadKonturTokens();
  if(!tokens?.access_token) throw new Error("Сначала подключите учётную запись Контур");
  if(Number(tokens.expires_at||0)>Date.now()+60_000) return tokens.access_token;
  if(!tokens.refresh_token) throw new Error("Сеанс Контур истёк. Выполните вход повторно");
  const refreshed=await exchangeKonturToken({grant_type:"refresh_token",refresh_token:tokens.refresh_token});
  return refreshed.access_token;
}
async function verifyKonturBox(accessToken) {
  const config=konturConfig();
  const response=await fetch(`${diadocApiUrl}/GetMyOrganizations`,{headers:{Authorization:`Bearer ${accessToken}`,"Accept":"application/json"},signal:AbortSignal.timeout(30_000)});
  const text=await response.text(); let result; try{result=JSON.parse(text);}catch{result={};}
  if(!response.ok) throw new Error(result.message||`Не удалось проверить ящик Контур: HTTP ${response.status}`);
  const boxes=(result.Organizations||[]).flatMap(organization=>organization.Boxes||[]);
  const expected=config.boxId.toLowerCase().replace(/@diadoc\.ru$/,"").replaceAll("-","");
  const hasAccess=boxes.some(box=>[box.BoxIdGuid,box.BoxId].some(value=>String(value||"").toLowerCase().replace(/@diadoc\.ru$/,"").replaceAll("-","")===expected));
  if(!hasAccess) throw new Error("У пользователя нет доступа к указанному ящику Таглекс");
}
const konturDocumentFormat = (kind) => kind === "order"
  ? {TypeNamedId:"LogisticsOrderRequest",Function:"default",Version:"zakzvper_05_01_01"}
  : {TypeNamedId:"LogisticsWaybill",Function:"reception",Version:"kl_trn_mt_05_01"};
const konturDraftJobs=new Map();
const setKonturDraftJob=(id,patch)=>konturDraftJobs.set(id,{...konturDraftJobs.get(id),...patch,updatedAt:Date.now()});
async function createKonturDraft(jobId,payload){
  try {
    const config=konturConfig(); const format=konturDocumentFormat(payload.kind);
    setKonturDraftJob(jobId,{state:"working",phase:"authorization",message:"Получаем действующий токен Контур"});
    const accessToken=await getKonturAccessToken();
    const operationId=randomBytes(16).toString("hex");
    const requestBody=JSON.stringify({FromBoxId:config.boxId,IsDraft:true,StrictDraftValidation:false,DocumentAttachments:[{SignedContent:{Content:payload.content},...format}]});
    const deadline=Date.now()+90_000; let apiResponse; let result={}; let attempt=0;
    while(Date.now()<deadline){
      attempt++;
      setKonturDraftJob(jobId,{phase:"post-message",message:attempt===1?"XML передан в Диадок. Ожидаем создание черновика":`Диадок продолжает обработку. Проверка № ${attempt}`});
      try {
        apiResponse=await fetch(`${diadocApiUrl}/V3/PostMessage?operationId=${operationId}`,{
          method:"POST",headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json; charset=utf-8","Accept":"application/json"},
          body:requestBody,signal:AbortSignal.timeout(Math.min(30_000,Math.max(1_000,deadline-Date.now())))
        });
      } catch(error) {
        if(error?.name!=="TimeoutError"||Date.now()>=deadline) throw error;
        setKonturDraftJob(jobId,{message:"Диадок пока не ответил. Повторяем безопасно с тем же номером операции"});
        continue;
      }
      if(apiResponse.status===204){
        const retryAfter=Math.max(1,Number.parseInt(apiResponse.headers.get("retry-after")||"2",10)||2);
        setKonturDraftJob(jobId,{message:`Диадок обрабатывает документ. Следующая проверка через ${retryAfter} сек.`});
        await new Promise(resolve=>setTimeout(resolve,Math.min(retryAfter*1_000,Math.max(0,deadline-Date.now()))));
        continue;
      }
      const text=await apiResponse.text(); try{result=JSON.parse(text);}catch{result={message:text};}
      if(!apiResponse.ok) throw new Error(result.message||result.error_description||result.error||`Диадок вернул HTTP ${apiResponse.status}`);
      break;
    }
    if(!apiResponse||apiResponse.status===204) throw new Error("Диадок продолжает обрабатывать черновик дольше 90 секунд. Повторите передачу позднее.");
    const document=result.Entities?.find(item=>item.EntityType==="Attachment")||result.Entities?.[0];
    setKonturDraftJob(jobId,{state:"saved",phase:"complete",message:"Черновик создан",messageId:result.MessageId||null,entityId:document?.EntityId||null});
  } catch(error) {
    const message=error?.name==="TimeoutError"?"Контур не ответил за 90 секунд. Проверьте доступность API и повторите передачу":error.message||"Не удалось создать черновик в Контуре";
    setKonturDraftJob(jobId,{state:"error",phase:"failed",message});
  }
}

const xmlDecode=value=>String(value||"").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
const xmlEscape=value=>String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const xmlAttribute=(xml,name)=>{const match=String(xml||"").match(new RegExp(`${name}=["']([^"']*)["']`,"i"));return xmlDecode(match?.[1]||"").trim();};
const xmlSection=(xml,tag)=>{const match=String(xml||"").match(new RegExp(`<${tag}(?=\\s|/?>)[^>]*>[\\s\\S]*?<\\/${tag}>|<${tag}(?=\\s|/?>)[^>]*/>`,"i"));return match?.[0]||"";};
const xmlParty=(xml,tag)=>xmlAttribute(xmlSection(xml,tag),"НаимОрг")||"Не указано";
const forwardingServiceCost=xml=>{
  const source=String(xml||"");
  const names=["ОбщСтУсл","TotalServiceCost","СтоимУслуг","СтУслуг","СтУслЭксп","СуммаУслуг","ServiceCost","ServicePrice","Cost"];
  for(const name of names){const value=xmlAttribute(source,name);if(value)return value;}
  const labeled=source.match(/(?:Стоимость|стоимость)[^<>="']{0,80}[=:]\s*["']?([\d\s]+(?:[.,]\d{1,2})?)/u);
  return labeled?.[1]?.trim()||"";
};
const ticksToDate=ticks=>{if(!ticks)return null;const value=Number(ticks);return Number.isFinite(value)?new Date(value/10_000-62135596800000):null;};
const documentDate=value=>{const match=String(value||"").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);return match?new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00+03:00`):null;};
const addHours=(date,hours)=>date?new Date(date.getTime()+hours*3_600_000):null;
const describeDelay=date=>{if(!date)return {status:"waiting",text:"Контрольная дата не определена"};const hours=(Date.now()-date.getTime())/3_600_000;if(hours>0)return {status:"overdue",text:hours>=48?`Просрочено на ${Math.floor(hours/24)} дн.`:`Просрочено на ${Math.max(1,Math.floor(hours))} ч.`};if(hours>-24)return {status:"dueSoon",text:"Срок в течение суток"};return {status:"waiting",text:`Осталось ${Math.max(1,Math.ceil(-hours/24))} дн.`};};
const mapLimit=async(items,limit,handler)=>{const result=new Array(items.length);let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const index=cursor++;result[index]=await handler(items[index],index);}}));return result;};
async function diadocJson(pathname,accessToken,options={}){
  const response=await fetch(`${diadocApiUrl}${pathname}`,{...options,headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json; charset=utf-8",...(options.body?{"Content-Type":"application/json; charset=utf-8"}:{}),...options.headers},signal:AbortSignal.timeout(45_000)});
  const text=await response.text();let result={};try{result=JSON.parse(text);}catch{result={message:text};}
  if(!response.ok)throw new Error(result.message||result.error_description||result.error||`Диадок вернул HTTP ${response.status}`);return result;
}
const isCompleteGarAddress=(address,result)=>{
  if(!result?.FiasId||!result?.RegionCode)return false;
  const needsHouse=/(?:^|[\s,])(?:д(?:ом)?|вл(?:адение)?|стр(?:оение)?)\.?\s*(?:№\s*)?\d/iu.test(address);
  const needsStreet=/(?:^|[\s,])(?:ул(?:ица)?|ш(?:оссе)?|пр-кт|проспект|проезд|пер(?:еулок)?)\.?\s/iu.test(address);
  const hasHouse=Boolean(result.Garhouse?.Number);
  const hasStreet=Boolean(result.Street?.Name||result.PlanningStructure?.Name);
  return (!needsHouse||hasHouse)&&(!needsStreet||hasStreet);
};
async function resolveGarAddress(address){
  const key=normalizeAddressKey(address);if(!key)return null;
  const cache=loadGarAddressCache();
  if(Object.hasOwn(cache,key)){
    if(isCompleteGarAddress(address,cache[key]))return cache[key];
    delete cache[key];
  }
  try{
    const accessToken=await getKonturAccessToken();
    const result=await diadocJson(`/V1/ParseGarAddress?address=${encodeURIComponent(address)}&isAdministrativeDivision=false`,accessToken);
    const resolved=isCompleteGarAddress(address,result)?result:null;
    cache[key]=resolved;saveGarAddressCache();return resolved;
  }catch{return null;}
}
async function diadocEntityText(accessToken,boxId,messageId,entityId){
  const response=await fetch(`${diadocApiUrl}/V4/GetEntityContent?boxId=${encodeURIComponent(boxId)}&messageId=${encodeURIComponent(messageId)}&entityId=${encodeURIComponent(entityId)}`,{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(45_000)});
  if(!response.ok)throw new Error(`Не удалось прочитать титул: HTTP ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());
  const head=bytes.subarray(0,200).toString("ascii").toLowerCase();const encoding=head.includes("windows-1251")?"windows-1251":"utf-8";return new TextDecoder(encoding).decode(bytes);
}
const csvCell=value=>{const text=String(value??"");return /[;"\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;};
const parseSemicolonCsv=text=>{const records=[];let record=[],cell="",quoted=false;const source=String(text||"").replace(/^\uFEFF/,"");for(let index=0;index<source.length;index++){const char=source[index];if(quoted){if(char==='"'&&source[index+1]==='"'){cell+='"';index++;}else if(char==='"')quoted=false;else cell+=char;}else if(char==='"')quoted=true;else if(char===';'){record.push(cell);cell="";}else if(char==='\n'){record.push(cell.replace(/\r$/, ""));records.push(record);record=[];cell="";}else cell+=char;}if(cell||record.length){record.push(cell.replace(/\r$/, ""));records.push(record);}const headers=records.shift()||[];return records.filter(row=>row.some(Boolean)).map(row=>Object.fromEntries(headers.map((header,index)=>[header,row[index]||""])));};
async function syncKonturCounteragents(onProgress=()=>{}){
  onProgress({phase:"authorization",progress:5,message:"Проверяем подключение к Диадоку"});
  const accessToken=await getKonturAccessToken();const {boxId}=konturConfig();const counteragents=[];let afterIndexKey="";
  for(let page=0;page<100;page++){
    const suffix=afterIndexKey?`&afterIndexKey=${encodeURIComponent(afterIndexKey)}`:"";
    const result=await diadocJson(`/V3/GetCounteragents?myBoxId=${encodeURIComponent(boxId)}${suffix}`,accessToken);
    const portion=result.Counteragents||[];counteragents.push(...portion);const total=Math.max(counteragents.length,Number(result.TotalCount||0));onProgress({phase:"loading",progress:total?Math.min(90,10+Math.round(counteragents.length/total*80)):10,message:`Получено ${counteragents.length.toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")} контрагентов`,count:counteragents.length,total});
    if(portion.length<100)break;afterIndexKey=portion.at(-1)?.IndexKey||"";if(!afterIndexKey)break;
  }
  const headers=["Название организации","ИНН","КПП","Идентификатор участника ЭДО","Статус","Дата изменения статуса","Группа","Дата ликвидации контрагента","Организация работает в тестовом режиме","ID организации","ID ящика"];
  const apiRows=counteragents.map(item=>{const organization=item.Organization||{};return [organization.FullName||organization.ShortName,organization.Inn,organization.Kpp,organization.FnsParticipantId,item.CounteragentStatus||item.Status,item.LastEventTimestamp,item.CounteragentGroupId,organization.IsActive&&!organization.LiquidationDate?"Действующая организация":organization.LiquidationDate||"Ликвидирована",organization.IsTest?"Да":"Нет",organization.OrgIdGuid||organization.OrgId,organization.Boxes?.[0]?.BoxIdGuid||organization.Boxes?.[0]?.BoxId];});
  if(!apiRows.length)throw new Error("Диадок вернул пустой список контрагентов");
  const target=sourceFiles.edo();const merged=new Map();
  if(fs.existsSync(target)){for(const item of parseSemicolonCsv(fs.readFileSync(target,"utf8"))){const row=headers.map(header=>item[header]||"");const key=item["Идентификатор участника ЭДО"]||`${item["ИНН"]}|${item["КПП"]}|${item["ID ящика"]}`;if(key)merged.set(key,row);}}
  for(const row of apiRows){const key=row[3]||`${row[1]}|${row[2]}|${row[10]}`;if(key)merged.set(key,row);}
  const rows=[...merged.values()];onProgress({phase:"saving",progress:95,message:"Сохраняем и применяем обновлённый справочник"});fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,"\uFEFF"+[headers,...rows].map(row=>row.map(csvCell).join(";")).join("\r\n"),"utf8");restartGeneratorWorker();onProgress({phase:"complete",progress:100,message:`Справочник обновлён: ${rows.length.toLocaleString("ru-RU")} строк`});
  return {count:rows.length,received:apiRows.length,preserved:rows.length-apiRows.length,updatedAt:new Date().toISOString()};
}
let counteragentSyncPromise=null;
const runCounteragentSync=onProgress=>{if(!counteragentSyncPromise)counteragentSyncPromise=syncKonturCounteragents(onProgress).finally(()=>{counteragentSyncPromise=null;});return counteragentSyncPromise;};
const konturDocumentUrl=(boxId,messageId,logisticsId,typeNamedId)=>{
  const normalizedBoxId=String(boxId||"").replace(/@diadoc\.ru$/i,"");
  if(typeNamedId==="LogisticsWaybill"&&normalizedBoxId&&logisticsId)return `https://logist.kontur.ru/${encodeURIComponent(normalizedBoxId)}/consignor/sign/waybill/${encodeURIComponent(logisticsId)}`;
  const template=process.env.KONTUR_DOCUMENT_URL_TEMPLATE||"";
  return template?template.replaceAll("{boxId}",encodeURIComponent(normalizedBoxId)).replaceAll("{messageId}",encodeURIComponent(messageId)).replaceAll("{entityId}",encodeURIComponent(logisticsId)):null;
};
let signingControlCache={expiresAt:0,value:null};
async function loadSigningControl(){
  const config=konturConfig();const accessToken=await getKonturAccessToken();const months=Math.max(1,Number(process.env.KONTUR_CONTROL_MONTHS||4));const from=new Date();from.setMonth(from.getMonth()-months);
  const formatDate=date=>`${String(date.getDate()).padStart(2,"0")}.${String(date.getMonth()+1).padStart(2,"0")}.${date.getFullYear()}`;
  const documents=[];let afterIndexKey="";for(let page=0;page<10;page++){const body={DocumentTypeNamedIds:["LogisticsWaybill","LogisticsOrderRequest","LogisticsForwardingOrder"],DocumentCategory:"Any",FromDocumentDate:formatDate(from),SortDirection:"Descending",Count:100,...(afterIndexKey?{AfterIndexKey:afterIndexKey}:{})};const list=await diadocJson(`/V4/GetDocuments?boxId=${encodeURIComponent(config.boxId)}`,accessToken,{method:"POST",body:JSON.stringify(body)});const portion=list.Documents||[];documents.push(...portion);if(portion.length<100)break;afterIndexKey=portion.at(-1)?.IndexKey||"";if(!afterIndexKey)break;}
  const unique=[];const seen=new Set();for(const document of documents){if(document.IsDeleted)continue;const key=`${document.MessageId}:${document.EntityId}`;if(!seen.has(key)){seen.add(key);unique.push(document);}}
  const docflows=[];for(let offset=0;offset<unique.length;offset+=100){const part=unique.slice(offset,offset+100);const response=await diadocJson(`/V5/GetDocflows?boxId=${encodeURIComponent(config.boxId)}`,accessToken,{method:"POST",body:JSON.stringify({Requests:part.map(item=>({DocumentId:{MessageId:item.MessageId,EntityId:item.EntityId}}))})});docflows.push(...(response.Documents||[]));}
  const flowById=new Map(docflows.map(item=>[`${item.DocumentId?.MessageId}:${item.DocumentId?.EntityId}`,item]));
  const items=(await mapLimit(unique,5,async document=>{
    const flow=flowById.get(`${document.MessageId}:${document.EntityId}`);if(flow?.DocumentInfo?.IsDeleted)return [];const isForwarding=document.TypeNamedId==="LogisticsForwardingOrder";const titles=flow?.Docflow?.Titles||[];const waiting=titles.filter(title=>title.AuthorSigning&&title.AuthorSigning.IsFinished===false&&title.AuthorSigning.Status==="TitleAuthorStatusWaiting").filter(title=>!isForwarding||Number(title.TitleIndex||0)<2);const forwardingAgreed=isForwarding&&!document.IsIncoming&&!waiting.length&&titles.some(title=>Number(title.TitleIndex||0)===1&&title.AuthorSigning?.IsFinished===true);if(!waiting.length&&!forwardingAgreed)return [];
    const customData=Object.fromEntries((document.CustomData||[]).map(item=>[item.Key,item.Value]));
    const initialParts=String(customData["kl-initial-document-id"]||"").split(":");
    const sourceMessageId=initialParts.length===3?initialParts[1]:document.MessageId;
    const sourceEntityId=initialParts.length===3?initialParts[2]:document.EntityId;
    let xml="";try{xml=await diadocEntityText(accessToken,config.boxId,sourceMessageId,sourceEntityId);}catch{try{xml=await diadocEntityText(accessToken,config.boxId,document.MessageId,document.EntityId);}catch{/* metadata remains available */}}
    const isOrder=document.TypeNamedId==="LogisticsOrderRequest";const container=(xml.match(/[A-Z]{4}\d{7}/)||[])[0]||"—";const firstParty=(...tags)=>tags.map(tag=>xmlParty(xml,tag)).find(value=>value!=="Не указано")||"Не указано";const client=isForwarding?firstParty("СвКл","СвЗакТЭУ","СвЗак"):xmlParty(xml,"СвЗак");const carrier=isForwarding?firstParty("СвЭксп","СвИсп","СвПер"):(xmlParty(xml,"СвПер")!=="Не указано"?xmlParty(xml,"СвПер"):xmlParty(xml,"СвИсп"));const consignee=isForwarding?"—":xmlParty(xml,"СвГП");
    const trackedTitles=forwardingAgreed?[{TitleIndex:1,agreed:true}]:waiting;const serviceCost=isForwarding?forwardingServiceCost(xml):"";
    return trackedTitles.map(title=>{const titleNumber=Number(title.TitleIndex||0)+1;let controlDate=null;let controlDateLabel="Дата документа";
      if(isForwarding){controlDate=addHours(documentDate(document.DocumentDate)||new Date(document.CreationTimestamp||Date.now()),Number(process.env.KONTUR_FORWARDING_RESPONSE_HOURS||24));controlDateLabel=document.IsIncoming?"Срок нашей подписи":"Срок подписи экспедитора";}
      else if(isOrder){controlDate=addHours(documentDate(document.DocumentDate)||new Date(document.CreationTimestamp||Date.now()),Number(process.env.KONTUR_ORDER_RESPONSE_HOURS||24));controlDateLabel="Срок ответа перевозчика";}
      else if(titleNumber===2){controlDate=new Date(xmlAttribute(xml,"ЗаявПогр")||xmlAttribute(xml,"StatedArrivalDateTime")||"");controlDateLabel="Плановая подача ТС под погрузку";}
      else if(titleNumber===3){controlDate=new Date(xmlAttribute(xml,"ДатВрДостГр")||xmlAttribute(xml,"DeliveryDateTime")||"");controlDateLabel="Плановая доставка груза";}
      else if(titleNumber===4){controlDate=new Date(xmlAttribute(xml,"ФДатВрУбыт")||xmlAttribute(xml,"ActualDepartureDateTime")||xmlAttribute(xml,"ФДатВрПриб")||"");controlDateLabel="Фактическое завершение выгрузки";}
      if(!controlDate||Number.isNaN(controlDate.getTime()))controlDate=documentDate(document.DocumentDate)||ticksToDate(document.SendTimestampTicks)||new Date(document.CreationTimestamp||Date.now());const delay=describeDelay(controlDate);
      const agreed=Boolean(title.agreed);const responsible=isForwarding?(document.IsIncoming?"Мы":"Экспедитор"):titleNumber===3?"Грузополучатель":titleNumber===1?"Грузоотправитель":"Перевозчик";
      return {id:`${document.MessageId}:${document.EntityId}:${titleNumber}`,documentType:isForwarding?"Поручение экспедитору":isOrder?"Заявка":"ЭТрН",workflowGroup:isForwarding?(document.IsIncoming?"incoming":"outgoing"):null,direction:isForwarding?(document.IsIncoming?"incoming":"outgoing"):null,agreed,serviceCost,number:document.DocumentNumber||xmlAttribute(xml,isForwarding?"НомДок":isOrder?"НомерЗаяв":"НомерТрН")||"Без номера",container,client,carrier,consignee,waitingTitle:agreed?"Согласовано":`Т${titleNumber}`,responsible,status:agreed?"agreed":delay.status,statusText:agreed?"Подписано экспедитором":isForwarding&&document.IsIncoming?"Требуется наша подпись":`Ожидается подпись: ${responsible.toLowerCase()}`,controlDate:controlDate.toISOString(),controlDateLabel,overdueText:agreed?"Согласовано":delay.text,messageId:document.MessageId,entityId:document.EntityId,sourceMessageId,sourceEntityId,documentUrl:konturDocumentUrl(config.boxId,document.MessageId,customData["kl-id"]||sourceEntityId,document.TypeNamedId)};});
  })).flat();
  return {source:"kontur",generatedAt:new Date().toISOString(),connected:true,user:konturUserInfo(loadKonturTokens()),items,note:null};
}

const sourceFiles = {
  cargo: () => path.join(cacheRoot,"cargo.xlsx"),
  auto: () => path.join(cacheRoot,"auto.xlsx"),
  points: () => path.join(referenceRoot,"route-points.xlsx"),
  contracts: () => path.join(referenceRoot,"contracts.json"),
  edo: () => path.join(referenceRoot,"counteragents.csv"),
};
function sourceStatus() {
  return Object.fromEntries(Object.entries(sourceFiles).map(([kind,getFile])=>{
    const file=getFile();
    if(!fs.existsSync(file)) return [kind,null];
    const stat=fs.statSync(file);
    return [kind,{available:true,updatedAt:stat.mtime.toISOString(),size:stat.size}];
  }));
}

function readTmsCredentials() {
  if (process.env.TMS_LOGIN && process.env.TMS_PASSWORD) return {login:process.env.TMS_LOGIN,password:process.env.TMS_PASSWORD};
  if (!fs.existsSync(credentialsFile)) return null;
  const config = JSON.parse(fs.readFileSync(credentialsFile,"utf8").replace(/^\uFEFF/,""));
  const command = "$c=Get-Content -Raw $env:TMS_CREDENTIALS|ConvertFrom-Json;$s=ConvertTo-SecureString $c.password;$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}";
  const result = spawnSync("powershell.exe",["-NoProfile","-Command",command],{encoding:"utf8",env:{...process.env,TMS_CREDENTIALS:credentialsFile},windowsHide:true});
  if (result.status !== 0) throw new Error("Не удалось прочитать сохранённый пароль TMS");
  return {login:config.login,password:result.stdout.trim()};
}

const app = spawn(process.execPath, [vinextCli, "start", "--hostname", "127.0.0.1", "--port", String(appPort)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PORT: String(appPort) },
});

const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "C:/Users/alekseev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" : "python3");
const workerScript = path.join(root,"..","universal_app","web_worker.py");
let generatorWorker, workerBuffer="", requestSequence=0;
const pending=new Map();
const garCacheFile=path.join(root,"work","gar-addresses.json");
const edoPreferencesFile=path.join(root,"work","edo-preferences.json");
const loadEdoPreferences=()=>{try{return JSON.parse(fs.readFileSync(edoPreferencesFile,"utf8"));}catch{return {};}};
const saveEdoPreferences=value=>{fs.mkdirSync(path.dirname(edoPreferencesFile),{recursive:true});fs.writeFileSync(edoPreferencesFile,JSON.stringify(value,null,2),"utf8");};
const edoPreferenceKey=party=>`${String(party.inn||"").trim()}|${String(party.kpp||"").trim()}`;
const normalizeBoxId=value=>String(value||"").toLowerCase().replace(/@diadoc\.ru$/i,"").replaceAll("-","");
const edoOperator=participantId=>{const prefix=String(participantId||"").trim().slice(0,3).toUpperCase();return ({"2AE":"Калуга Астрал","2BE":"СБИС (Тензор)","2BM":"Контур.Диадок","2PS":"ПС СТ (OFD.ru)","2JD":"НИИАС","2AH":"ИнфоТеКС Интернет Траст","2AD":"Русь-Телеком","2LB":"ЭТП ГПБ","2VO":"Эвотор ОФД","2LT":"Оператор-ЦРПТ","2HU":"Национальный удостоверяющий центр","2BK":"КОРУС Консалтинг СНГ","2BA":"НТЦ СТЭК","2HX":"Криптэкс","2AK":"ТаксНет","2LD":"Э-КОМ","2LJ":"Финтендер-крипто","2LH":"ФораПром (LERADATA)","2CI":"Электронный экспресс (Гарант)","2LG":"Бифит ЭДО","2BV":"МО ПНИЭИ-КрасКрипт","2JM":"Сислинк","2IJ":"Эдисофт","2CA":"Мостинфо-Екатеринбург","2JF":"НТСсофт","2GP":"КДС","2MC":"АТИ-Доки","2BN":"Линк-Сервис"})[prefix]||`Оператор с кодом ${prefix||"не определён"}`;};
let signedEdoEvidenceCache={expiresAt:0,value:new Map(),checked:new Set(),documents:null};
async function loadSignedEdoEvidence(parties=[]){
  if(signedEdoEvidenceCache.expiresAt<=Date.now())signedEdoEvidenceCache={expiresAt:Date.now()+10*60_000,value:new Map(),checked:new Set(),documents:null};
  const targetBoxes=new Set((parties||[]).flatMap(party=>party.options||[]).map(option=>normalizeBoxId(option.boxId)).filter(Boolean));const missing=new Set([...targetBoxes].filter(boxId=>!signedEdoEvidenceCache.checked.has(boxId)));if(!missing.size)return signedEdoEvidenceCache.value;
  const config=konturConfig();const accessToken=await getKonturAccessToken();const months=Math.max(1,Number(process.env.KONTUR_EDO_HISTORY_MONTHS||12));const from=new Date();from.setMonth(from.getMonth()-months);
  const formatDate=date=>`${String(date.getDate()).padStart(2,"0")}.${String(date.getMonth()+1).padStart(2,"0")}.${date.getFullYear()}`;
  if(!signedEdoEvidenceCache.documents){const documents=[];let afterIndexKey="";for(let page=0;page<20;page++){
    const body={DocumentTypeNamedIds:["LogisticsWaybill","LogisticsOrderRequest","LogisticsForwardingOrder"],DocumentCategory:"Any",FromDocumentDate:formatDate(from),SortDirection:"Descending",Count:100,...(afterIndexKey?{AfterIndexKey:afterIndexKey}:{})};const list=await diadocJson(`/V4/GetDocuments?boxId=${encodeURIComponent(config.boxId)}`,accessToken,{method:"POST",body:JSON.stringify(body)});const portion=list.Documents||[];documents.push(...portion);if(portion.length<100)break;afterIndexKey=portion.at(-1)?.IndexKey||"";if(!afterIndexKey)break;
  }const unique=[];const seen=new Set();for(const document of documents){if(document.IsDeleted)continue;const key=`${document.MessageId}:${document.EntityId}`;if(!seen.has(key)){seen.add(key);unique.push(document);}}signedEdoEvidenceCache.documents=unique;
  }
  const relevant=signedEdoEvidenceCache.documents.filter(document=>missing.has(normalizeBoxId(document.CounteragentBoxId)));const messages=await mapLimit(relevant,5,async document=>{try{return {document,message:await diadocJson(`/V3/GetMessage?boxId=${encodeURIComponent(config.boxId)}&messageId=${encodeURIComponent(document.MessageId)}&injectEntityContent=false`,accessToken)};}catch{return {document,message:null};}});const stats=new Map([...missing].map(boxId=>[boxId,{count:0,lastSignedAt:"",documentNumber:""}]));
  for(const {document,message} of messages){const boxId=normalizeBoxId(document.CounteragentBoxId);const signed=(message?.Entities||[]).some(entity=>entity.EntityType==="Signature"&&normalizeBoxId(entity.SignerBoxId)===boxId);if(!signed)continue;const current=stats.get(boxId);current.count++;if(!current.lastSignedAt){current.lastSignedAt=document.CreationTimestamp||document.DocumentDate||"";current.documentNumber=document.DocumentNumber||"";}}
  for(const boxId of missing){const stat=stats.get(boxId);if(stat?.count)signedEdoEvidenceCache.value.set(boxId,stat);signedEdoEvidenceCache.checked.add(boxId);}return signedEdoEvidenceCache.value;
}
const decorateEdoParties=(parties,evidence=new Map())=>{const preferences=loadEdoPreferences();return (parties||[]).map(party=>{const key=edoPreferenceKey(party);const preference=preferences[key];const options=(party.options||[]).map(option=>({...option,operator:edoOperator(option.id),history:evidence.get(normalizeBoxId(option.boxId))||null}));const confirmed=options.filter(option=>option.history).sort((left,right)=>right.history.count-left.history.count);const historyChoice=confirmed.length===1?confirmed[0]:null;const ambiguous=options.length>1;const selectedId=preference?.participantId||historyChoice?.id||(!ambiguous?party.currentId||options[0]?.id||"":"");const history=historyChoice?.history||null;return {...party,options,key,selectedId,selectionSource:preference?"manual":historyChoice?"history":selectedId?"automatic":"unresolved",selectedBy:preference?.selectedBy||"",selectedAt:preference?.selectedAt||"",history};});};
const edoDirectoryParties=()=>{if(!fs.existsSync(sourceFiles.edo()))return [];const groups=new Map();for(const row of parseSemicolonCsv(fs.readFileSync(sourceFiles.edo(),"utf8"))){const inn=String(row["ИНН"]||"").trim(),kpp=String(row["КПП"]||"").trim(),id=String(row["Идентификатор участника ЭДО"]||"").trim();if(!inn||!id)continue;const key=`${inn}|${kpp}`;if(!groups.has(key))groups.set(key,{role:"counterparty",name:String(row["Название организации"]||"").trim(),inn,kpp,currentId:id,options:[]});const group=groups.get(key);if(!group.currentId)group.currentId=id;if(!group.options.some(option=>option.id===id))group.options.push({id,name:String(row["Название организации"]||"").trim(),status:String(row["Статус"]||"").trim(),boxId:String(row["ID ящика"]||"").trim()});}return [...groups.values()].filter(party=>party.options.length>1).sort((left,right)=>left.name.localeCompare(right.name,"ru"));};
let garAddressCache=null;
function loadGarAddressCache(){
  if(garAddressCache)return garAddressCache;
  try{garAddressCache=JSON.parse(fs.readFileSync(garCacheFile,"utf8"));}catch{garAddressCache={};}
  return garAddressCache;
}
function saveGarAddressCache(){fs.mkdirSync(path.dirname(garCacheFile),{recursive:true});fs.writeFileSync(garCacheFile,JSON.stringify(garAddressCache,null,2),"utf8");}
const normalizeAddressKey=value=>String(value||"").toLowerCase().replace(/\s+/g," ").trim();
function sendGeneratorRequest(payload,timeoutMs=60_000){
  return new Promise(resolve=>{
    const requestId=++requestSequence;payload={...payload,requestId};
    if(!generatorWorker||generatorWorker.exitCode!==null||generatorWorker.killed)startGeneratorWorker();
    const timeout=setTimeout(()=>{const item=pending.get(requestId);if(item){pending.delete(requestId);item({requestId,error:"Генератор XML не ответил за 60 секунд"});}},timeoutMs);
    pending.set(requestId,result=>{clearTimeout(timeout);resolve(result);});
    generatorWorker.stdin.write(JSON.stringify(payload)+"\n");
  });
}
function failPendingDocuments(message){
  for(const [id,item] of pending){pending.delete(id);item({requestId:id,error:message});}
}
function startGeneratorWorker(){
  workerBuffer="";
  generatorWorker=spawn(python,[workerScript],{cwd:path.dirname(workerScript),stdio:["pipe","pipe","inherit"],env:{...process.env,
    AGR_COMPANIES_FILE:process.env.AGR_COMPANIES_FILE||path.join(referenceRoot,"companies.xlsx"),
    AGR_EDO_FILE:process.env.AGR_EDO_FILE||path.join(referenceRoot,"counteragents.csv"),
    AGR_VEHICLES_FILE:process.env.AGR_VEHICLES_FILE||path.join(referenceRoot,"vehicles.xlsx"),
    AGR_DRIVERS_FILE:process.env.AGR_DRIVERS_FILE||path.join(referenceRoot,"drivers.xlsx"),
    AGR_POINTS_FILE:process.env.AGR_POINTS_FILE||path.join(referenceRoot,"route-points.xlsx"),
    AGR_CONTRACTS_FILE:process.env.AGR_CONTRACTS_FILE||path.join(referenceRoot,"contracts.json")}});
  generatorWorker.stdout.setEncoding("utf8");
  generatorWorker.stdout.on("data",chunk=>{
    workerBuffer+=chunk; const lines=workerBuffer.split(/\r?\n/); workerBuffer=lines.pop()||"";
    for(const line of lines){if(!line.trim())continue;try{const result=JSON.parse(line);if(result.ready)continue;const item=pending.get(result.requestId);if(item){pending.delete(result.requestId);item(result);}}catch{}}
  });
  generatorWorker.on("error",error=>failPendingDocuments("Не удалось запустить генератор XML: "+error.message));
  generatorWorker.on("exit",code=>{if(code)failPendingDocuments("Генератор XML остановился с кодом "+code);});
}
function restartGeneratorWorker(){
  failPendingDocuments("Справочники обновляются, повторите формирование");
  if(generatorWorker) generatorWorker.kill(); startGeneratorWorker();
}
startGeneratorWorker();

const types = { ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".map":"application/json", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".woff2":"font/woff2" };

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/api/kontur/status") {
    const config=konturConfig(); const tokens=loadKonturTokens();
    response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    response.end(JSON.stringify({configured:Boolean(config.clientId&&config.clientSecret&&config.redirectUri&&config.boxId),connected:Boolean(tokens?.access_token),boxId:config.boxId||null,user:konturUserInfo(tokens),permissions:konturPermissionLabels()})); return;
  }
  if (request.method === "GET" && url.pathname === "/api/kontur/login") {
    const config=konturConfig();
    if(!config.clientId||!config.clientSecret||!config.redirectUri||!config.boxId){response.writeHead(503,{"Content-Type":"text/plain; charset=utf-8"});response.end("Интеграция Контур не настроена на сервере");return;}
    const state=randomBytes(24).toString("hex"); const nonce=randomBytes(24).toString("hex");const returnTo=url.searchParams.get("returnTo")==="/control"?"/control":"/workspace";
    const target=new URL(`${konturIdentityUrl}/connect/authorize`);
    target.search=new URLSearchParams({response_type:"code",client_id:config.clientId,scope:konturScopes,redirect_uri:config.redirectUri,state,nonce}).toString();
    response.writeHead(302,{Location:target.toString(),"Set-Cookie":[konturStateCookie(state),konturReturnCookie(returnTo)],"Cache-Control":"no-store"}); response.end(); return;
  }
  if (request.method === "GET" && url.pathname === "/api/kontur/callback") {
    void (async()=>{
      const cookies=requestCookies(request);const state=url.searchParams.get("state")||""; const expectedState=cookies.kontur_oauth_state||"";const returnTo=cookies.kontur_return_to==="/control"?"/control":"/workspace";
      let receivedNewTokens=false;
      try {
        if(url.searchParams.get("error")) throw new Error(url.searchParams.get("error_description")||url.searchParams.get("error"));
        if(!state||!expectedState||state!==expectedState) throw new Error("Проверка state не пройдена или время входа истекло");
        const code=url.searchParams.get("code"); if(!code) throw new Error("Контур не вернул код авторизации");
        const tokens=await exchangeKonturToken({grant_type:"authorization_code",code,redirect_uri:konturConfig().redirectUri});
        receivedNewTokens=true;
        await verifyKonturBox(tokens.access_token);
        response.writeHead(302,{Location:`${returnTo}?kontur=connected`,"Set-Cookie":[konturStateCookie("",0),konturReturnCookie("",0)],"Cache-Control":"no-store"}); response.end();
      } catch(error){if(receivedNewTokens)try{fs.unlinkSync(konturTokenFile);}catch{}response.writeHead(302,{Location:`${returnTo}?kontur=error&message=${encodeURIComponent(error.message||"Ошибка авторизации")}`,"Set-Cookie":[konturStateCookie("",0),konturReturnCookie("",0)],"Cache-Control":"no-store"});response.end();}
    })(); return;
  }
  if (request.method === "POST" && url.pathname === "/api/kontur/draft") {
    const chunks=[]; let received=0;
    request.on("data",chunk=>{received+=chunk.length;if(received>15_000_000){response.writeHead(413,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:"XML превышает допустимый размер"}));request.destroy();return;}chunks.push(chunk);});
    request.on("end",()=>{
      try {
        if(response.writableEnded)return;
        const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if(!["cargo","empty","order"].includes(payload.kind)) throw new Error("Неизвестный вид документа");
        if(!payload.content||typeof payload.content!=="string") throw new Error("XML документа не передан");
        const jobId=randomBytes(16).toString("hex");
        konturDraftJobs.set(jobId,{state:"queued",phase:"queued",message:"Операция поставлена в очередь",createdAt:Date.now(),updatedAt:Date.now()});
        void createKonturDraft(jobId,payload);
        response.writeHead(202,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify({ok:true,jobId}));
      }catch(error){response.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Не удалось запустить создание черновика"}));}
    }); return;
  }
  if(request.method==="GET"&&url.pathname==="/api/kontur/draft-status"){
    const jobId=url.searchParams.get("jobId")||""; const job=konturDraftJobs.get(jobId);
    if(!job){response.writeHead(404,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:"Операция передачи не найдена. Возможно, сервер был перезапущен."}));return;}
    response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify(job));return;
  }
  if(request.method==="GET"&&url.pathname==="/api/kontur/signing-control"){
    void(async()=>{try{const force=url.searchParams.get("refresh")==="1";if(force||!signingControlCache.value||signingControlCache.expiresAt<Date.now()){signingControlCache.value=await loadSigningControl();signingControlCache.expiresAt=Date.now()+5*60_000;}response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify(signingControlCache.value));}catch(error){const unauthorized=["Сначала подключите","Сеанс Контур","invalid_grant","Invalid auth token"].some(text=>error.message?.includes(text));response.writeHead(unauthorized?401:502,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify({error:unauthorized?"Сеанс Контур истёк. Выполните вход повторно":error.message||"Не удалось получить статусы документов из Контур"}));}})();return;
  }
  if(request.method==="POST"&&url.pathname==="/api/kontur/forwarding-revoke"){
    const chunks=[];request.on("data",chunk=>chunks.push(chunk));request.on("end",()=>void(async()=>{try{
      const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));const required=["messageId","entityId","reason","terminationDate","signerLastName","signerFirstName"];for(const key of required)if(!String(payload[key]||"").trim())throw new Error(`Не заполнено поле: ${key}`);
      const config=konturConfig();const accessToken=await getKonturAccessToken();const flowResult=await diadocJson(`/V5/GetDocflows?boxId=${encodeURIComponent(config.boxId)}`,accessToken,{method:"POST",body:JSON.stringify({Requests:[{DocumentId:{MessageId:payload.messageId,EntityId:payload.entityId}}]})});const flow=flowResult.Documents?.[0];const info=flow?.DocumentInfo;if(!flow||info?.DocumentType?.TypeNamedId&&info.DocumentType.TypeNamedId!=="LogisticsForwardingOrder")throw new Error("Поручение не найдено");const titles=flow.Docflow?.Titles||[];if(!titles.some(title=>Number(title.TitleIndex)===1&&title.AuthorSigning?.IsFinished===true))throw new Error("Отзыв возможен только после подписанного Т2 экспедитора");if(titles.some(title=>Number(title.TitleIndex)===2))throw new Error("Т3 для этого поручения уже сформирован");
      const sourceXml=await diadocEntityText(accessToken,config.boxId,payload.sourceMessageId||payload.messageId,payload.sourceEntityId||payload.entityId);const orderId=xmlAttribute(sourceXml,"УИД_ПорЭксп")||xmlAttribute(sourceXml,"ForwardingOrderId")||xmlAttribute(sourceXml,"ИдПорЭксп")||xmlAttribute(sourceXml,"ИдентПорЭксп")||(sourceXml.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)||[])[0];if(!orderId)throw new Error("В исходном поручении не найден УИД");const middle=payload.signerMiddleName?` MiddleName="${xmlEscape(payload.signerMiddleName)}"`:"";const position=payload.signerPosition?`<Position PositionSource="Manual">${xmlEscape(payload.signerPosition)}</Position>`:"";const expenses=String(payload.actualExpenses||"").replace(",",".").trim();if(expenses&&!/^\d+(?:\.\d{1,2})?$/.test(expenses))throw new Error("Сумма расходов должна быть числом с двумя знаками после запятой");const contractDate=value=>{const match=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);return match?`${match[3]}.${match[2]}.${match[1]}`:String(value||"")};const userXml=`<?xml version="1.0" encoding="utf-8"?><LogisticsForwardingOrderRevokedTitle><RevokedOrderInfo ForwardingOrderId="${xmlEscape(orderId)}" RevokedDate="${xmlEscape(contractDate(payload.revokedDate||new Date().toISOString().slice(0,10)))}" ExecutionTerminationDate="${xmlEscape(contractDate(payload.terminationDate))}"${payload.terminationTime?` ExecutionTerminationTime="${xmlEscape(payload.terminationTime)}"`:""} RevocationReason="${xmlEscape(payload.reason)}"${expenses?` ActualExpensesSum="${expenses}"`:""}${payload.cargoInstructions?` CargoInstructions="${xmlEscape(payload.cargoInstructions)}"`:""}/><Signers><Signer SignerPowersConfirmationMethod="1"><Fio LastName="${xmlEscape(payload.signerLastName)}" FirstName="${xmlEscape(payload.signerFirstName)}"${middle}/>${position}</Signer></Signers></LogisticsForwardingOrderRevokedTitle>`;
      const generateUrl=`${diadocApiUrl}/GenerateTitleXml?boxId=${encodeURIComponent(config.boxId)}&documentTypeNamedId=LogisticsForwardingOrder&documentFunction=default&documentVersion=kl_porek_wt3_05_02_01&titleIndex=2&letterId=${encodeURIComponent(payload.messageId)}&documentId=${encodeURIComponent(payload.entityId)}`;const generated=await fetch(generateUrl,{method:"POST",headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/xml; charset=utf-8"},body:userXml,signal:AbortSignal.timeout(45_000)});const bytes=Buffer.from(await generated.arrayBuffer());if(!generated.ok)throw new Error(new TextDecoder().decode(bytes)||`Диадок вернул HTTP ${generated.status}`);response.writeHead(200,{"Content-Type":"application/xml","Content-Disposition":`attachment; filename="forwarding-revoke-${payload.entityId}.xml"`});response.end(bytes);
    }catch(error){response.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Не удалось сформировать Т3"}));}})());return;
  }
  if(request.method==="POST"&&url.pathname==="/api/kontur/forwarding-revoke/send"){
    const chunks=[];request.on("data",chunk=>chunks.push(chunk));request.on("end",()=>void(async()=>{try{
      const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));for(const key of ["messageId","parentEntityId","contentBase64","signatureBase64"])if(!String(payload[key]||"").trim())throw new Error(`Не заполнено поле: ${key}`);const content=Buffer.from(payload.contentBase64,"base64");const signature=Buffer.from(payload.signatureBase64,"base64");if(!content.length||content.length>2_000_000)throw new Error("Некорректный размер XML");if(!signature.length||signature.length>1_000_000)throw new Error("Некорректный размер подписи");const xml=content.toString("utf8");if(!xml.includes("СодИнфОтз")||!xml.includes("ПричОтз="))throw new Error("Передан не титул отзыва поручения");const config=konturConfig();const accessToken=await getKonturAccessToken();const flowResult=await diadocJson(`/V5/GetDocflows?boxId=${encodeURIComponent(config.boxId)}`,accessToken,{method:"POST",body:JSON.stringify({Requests:[{DocumentId:{MessageId:payload.messageId,EntityId:payload.parentEntityId}}]})});const flow=flowResult.Documents?.[0];if(!flow||flow.DocumentInfo?.DocumentType?.TypeNamedId!=="LogisticsForwardingOrder")throw new Error("Исходное поручение не найдено");const titles=flow.Docflow?.Titles||[];if(!titles.some(title=>Number(title.TitleIndex)===1&&title.AuthorSigning?.IsFinished===true))throw new Error("Т2 экспедитора ещё не подписан");if(titles.some(title=>Number(title.TitleIndex)===2))throw new Error("Т3 уже отправлен");const patch=await diadocJson("/V4/PostMessagePatch",accessToken,{method:"POST",body:JSON.stringify({BoxId:config.boxId,MessageId:payload.messageId,RecipientTitles:[{ParentEntityId:payload.parentEntityId,TitleIndex:2,SignedContent:{Content:payload.contentBase64,Signature:payload.signatureBase64}}]})});signingControlCache.value=null;response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify({ok:true,messageId:patch.MessageId,patchId:patch.PatchId}));
    }catch(error){response.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Не удалось отправить Т3"}));}})());return;
  }
  if(request.method==="POST"&&url.pathname==="/api/kontur/sync-counteragents"){
    response.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache"});const send=payload=>response.write(JSON.stringify(payload)+"\n");void(async()=>{try{const result=await runCounteragentSync(event=>send({type:"progress",...event}));send({type:"complete",result});}catch(error){send({type:"error",error:error.message||"Не удалось обновить контрагентов из Диадока"});}finally{response.end();}})();return;
  }
  if(request.method==="GET"&&url.pathname==="/api/version"){
    response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    response.end(JSON.stringify({version:appPackage.version,build:appBuild}));return;
  }
  if (request.method === "GET" && url.pathname === "/api/tms-status") {
    const configured=Boolean((process.env.TMS_LOGIN&&process.env.TMS_PASSWORD)||fs.existsSync(credentialsFile));
    response.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
    response.end(JSON.stringify({configured,sources:sourceStatus()})); return;
  }
  if (request.method === "GET" && url.pathname === "/api/source-cache") {
    const kind=url.searchParams.get("kind");
    const getFile=sourceFiles[kind||""];
    const file=getFile?.();
    if(!file||!fs.existsSync(file)){response.writeHead(404);response.end();return;}
    const isCsv=kind==="edo";response.writeHead(200,{"Content-Type":isCsv?"text/csv; charset=utf-8":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="${kind}.${isCsv?"csv":"xlsx"}"`}); fs.createReadStream(file).pipe(response); return;
  }
  if (request.method === "POST" && url.pathname === "/api/tms-update") {
    let body=""; request.setEncoding("utf8"); request.on("data",chunk=>body+=chunk); request.on("end",async()=>{
      response.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache"});
      const send=(payload)=>response.write(JSON.stringify(payload)+"\n");
      try {
        const supplied=body?JSON.parse(body):{}; const credentials=supplied.login&&supplied.password?supplied:readTmsCredentials();
        if(!credentials) throw new Error("Укажите логин и пароль TMS");
        fs.mkdirSync(referenceRoot,{recursive:true});
        const result=await syncTms({...credentials,cacheDir:cacheRoot,referenceDir:referenceRoot,onStatus:(key,state,message,details={})=>send({type:"status",key,state,message,...details})});
        send({type:"status",key:"apply",state:"working",message:"Перезагружаем справочники…"}); restartGeneratorWorker();
        send({type:"status",key:"apply",state:"saved",message:"Справочники применены"}); send({type:"complete",result}); response.end();
      } catch(error){send({type:"fatal",error:error.message||"Не удалось обновить данные из TMS"});response.end();}
    }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/cache-source") {
    const kind = url.searchParams.get("kind");
    if (!["cargo","auto","points","contracts","edo"].includes(kind || "")) { response.writeHead(400); response.end(); return; }
    const chunks=[]; request.on("data",chunk=>chunks.push(chunk)); request.on("end",()=>{
      try {
        const cache=cacheRoot; fs.mkdirSync(cache,{recursive:true}); fs.mkdirSync(referenceRoot,{recursive:true});
        const target=kind==="contracts"?path.join(referenceRoot,"contracts.json"):kind==="edo"?path.join(referenceRoot,"counteragents.csv"):path.join(cache,kind+".xlsx");
        const incoming=Buffer.concat(chunks);let normalizedIncoming=incoming;
        if(kind==="contracts"){
          let parsed;
          if(incoming[0]===0x50&&incoming[1]===0x4b){
            const workbook=XLSX.read(incoming,{type:"buffer",cellDates:true});
            const sheet=workbook.Sheets["LIST_CONTRACTS"]||workbook.Sheets[workbook.SheetNames[0]];
            parsed=contractRowsToCatalog(XLSX.utils.sheet_to_json(sheet,{defval:"",raw:true}));
            if(!parsed.length)throw new Error("В реестре LIST_CONTRACTS не найдены действующие договоры");
            normalizedIncoming=Buffer.from(JSON.stringify(parsed,null,2)+"\n","utf8");
          }else parsed=JSON.parse(incoming.toString("utf8").replace(/^\uFEFF/,""));
          if(!Array.isArray(parsed)||parsed.some(item=>!(item.client||item.carrier||item.counterparty)||!item.number)) throw new Error("Некорректный справочник договоров");
        }
        if(kind==="edo"){
          const header=incoming.toString("utf8").replace(/^\uFEFF/,"").split(/\r?\n/,1)[0]||"";
          for(const required of ["ИНН","КПП","Идентификатор участника ЭДО"]){if(!header.split(";").map(item=>item.replace(/^"|"$/g,"").trim()).includes(required))throw new Error(`В CSV отсутствует колонка «${required}»`);}
        }
        const unchanged=fs.existsSync(target) && fs.readFileSync(target).equals(normalizedIncoming);
        if(!unchanged) fs.writeFileSync(target,normalizedIncoming);
        if((kind==="contracts"||kind==="edo")&&!unchanged) restartGeneratorWorker();
        response.writeHead(200,{"Content-Type":"application/json"}); response.end(JSON.stringify({ok:true,unchanged}));
      } catch(error){response.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Не удалось сохранить справочник"}));}
    }); return;
  }
  if(request.method==="POST"&&url.pathname==="/api/edo-options"){
    let body="";request.setEncoding("utf8");request.on("data",chunk=>body+=chunk);request.on("end",()=>{void(async()=>{try{const payload=JSON.parse(body);const result=await sendGeneratorRequest({...payload,action:"edo_options"});if(result.error)throw new Error(result.error);let evidence=new Map();try{evidence=await loadSignedEdoEvidence(result.parties);}catch{}response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify({parties:decorateEdoParties(result.parties,evidence)}));}catch(error){response.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Не удалось получить варианты ID ЭДО"}));}})();});return;
  }
  if(request.method==="GET"&&url.pathname==="/api/edo-directory"){
    void(async()=>{try{const parties=edoDirectoryParties();let evidence=new Map();try{evidence=await loadSignedEdoEvidence(parties);}catch{}response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify({parties:decorateEdoParties(parties,evidence),generatedAt:new Date().toISOString()}));}catch(error){response.writeHead(502,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Не удалось загрузить настройки ID ЭДО"}));}})();return;
  }
  if(request.method==="POST"&&url.pathname==="/api/edo-preference"){
    let body="";request.setEncoding("utf8");request.on("data",chunk=>body+=chunk);request.on("end",()=>{try{const payload=JSON.parse(body);const key=String(payload.key||"").trim();const participantId=String(payload.participantId||"").trim();if(!/^\d{10,12}\|/.test(key)||!participantId)throw new Error("Некорректный участник ЭДО");const preferences=loadEdoPreferences();preferences[key]={participantId,selectedBy:String(payload.selectedBy||"Пользователь").trim(),selectedAt:new Date().toISOString()};saveEdoPreferences(preferences);response.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({ok:true,preference:preferences[key]}));}catch(error){response.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Не удалось сохранить выбор ID ЭДО"}));}});return;
  }
  if (request.method === "POST" && url.pathname === "/api/generate") {
    let body=""; request.setEncoding("utf8"); request.on("data",chunk=>{body+=chunk;}); request.on("end",()=>{void(async()=>{
      try {
        const payload=JSON.parse(body);
        const edoOptions=await sendGeneratorRequest({...payload,action:"edo_options"});
        if(edoOptions.error)throw new Error(edoOptions.error);
        let evidence=new Map();try{evidence=await loadSignedEdoEvidence(edoOptions.parties);}catch{}
        const decoratedEdoParties=decorateEdoParties(edoOptions.parties,evidence);const unresolvedEdoParties=decoratedEdoParties.filter(party=>!party.selectedId);if(unresolvedEdoParties.length){const missing=unresolvedEdoParties.filter(party=>!(party.options||[]).length);const prefix=missing.length?"Нет ID в справочнике ЭДО для":"Выберите ID ЭДО для";throw new Error(`${prefix}: ${[...new Set(unresolvedEdoParties.map(party=>party.name))].join(", ")}`);}payload.edoOverrides=Object.fromEntries(decoratedEdoParties.map(party=>[party.role,party.selectedId]));
        if(payload.kind==="order"){
          const addresses=await sendGeneratorRequest({...payload,action:"resolve_order_addresses"});
          if(addresses.error)throw new Error(addresses.error);
          const [loading,delivery]=await Promise.all([resolveGarAddress(addresses.loading),resolveGarAddress(addresses.delivery)]);
          payload.garAddresses={loading,delivery};
          const garWarnings=[];
          if(!loading)garWarnings.push("Для адреса погрузки не определён код ФИАС. Скорректируйте адрес вручную в заявке перед подписанием.");
          if(!delivery)garWarnings.push("Для адреса выгрузки не определён код ФИАС. Скорректируйте адрес вручную в заявке перед подписанием.");
          if(garWarnings.length&&!payload.confirmWarnings){
            response.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
            response.end(JSON.stringify({requiresConfirmation:true,warnings:garWarnings}));
            return;
          }
        }
        const result=await sendGeneratorRequest(payload);
        response.writeHead(result.error?400:200,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify(result));
      } catch(error){response.writeHead(400,{"Content-Type":"application/json; charset=utf-8"});response.end(JSON.stringify({error:error.message||"Некорректный запрос"}));}
    })();}); return;
  }
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const staticFile = path.join(clientRoot, relativePath);
  if (relativePath && staticFile.startsWith(clientRoot) && fs.existsSync(staticFile) && fs.statSync(staticFile).isFile()) {
    response.writeHead(200, { "Content-Type": types[path.extname(staticFile)] || "application/octet-stream", "Cache-Control":"no-cache" });
    fs.createReadStream(staticFile).pipe(response);
    return;
  }
  const proxy = http.request({ hostname:"127.0.0.1", port:appPort, path:request.url, method:request.method, headers:request.headers }, (upstream) => {
    const headers = { ...upstream.headers };
    if (headers.location) {
      headers.location = headers.location.replace(`127.0.0.1:${appPort}`, request.headers.host || `127.0.0.1:${publicPort}`);
    }
    response.writeHead(upstream.statusCode || 502, headers);
    upstream.pipe(response);
  });
  proxy.on("error", () => { response.writeHead(503, {"Content-Type":"text/plain; charset=utf-8"}); response.end("AGR is starting. Refresh the page in a few seconds."); });
  request.pipe(proxy);
});

server.listen(publicPort, "0.0.0.0", () => console.log(`AGR local website: http://127.0.0.1:${publicPort}`));
const dailyCounteragentSync=()=>{const file=sourceFiles.edo();const fresh=fs.existsSync(file)&&Date.now()-fs.statSync(file).mtimeMs<24*60*60_000;if(!fresh&&loadKonturTokens()?.access_token)void runCounteragentSync(()=>{}).catch(error=>console.error("Daily counteragent sync:",error.message));};
setTimeout(dailyCounteragentSync,20_000);const counteragentTimer=setInterval(dailyCounteragentSync,60*60_000);counteragentTimer.unref();
const stop = () => { server.close(); app.kill(); if(generatorWorker) generatorWorker.kill(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.on("exit", (code) => { if (code) process.exitCode = code; server.close(); });
