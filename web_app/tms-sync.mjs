import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

const BASE = "https://bln-log02.ylrus.com";

const cargoFields = {
  ID: "Номер записи",
  CREATE_DATE: "Дата создания строки",
  UNIT_NUMBER: "Грузовая единица",
  ORDER_COMPANY_CLIENT_NAME: "Клиент",
  ORDER_COMPANY_PARTNER_NAME: "Партнер",
  CONTAINER_STOCK_NAME: "Контейнерный сток",
  EMPTY_RETURN_INSTRUCTION: "Инструкция на сдачу порожнего",
  EMPTY_RETURN_REDIRECTION: "Перенаправление сдачи порожнего",
  EMPTY_RETURN_INSTRUCTION_VALIDITY_DATE: "Срок действия инструкции на сдачу порожнего",
  EMPTY_RETURN_DATE: "Дата сдачи порожнего",
  SEAL_NUMBER: "Номер пломбы",
  SEAL_NUMBER2: "Номер пломбы 2",
  GROUP_UNIT_TOTAL_GROSS_WEIGHT: "Вес брутто (кг)",
  LAST_AUTO_END_WAREHOUSE_NAME: "Место доставки на склад",
  LAST_AUTO_POINT_END_EXPECTED_DATETIME: "Планируемая дата доставки на склад",
  LAST_AUTO_DOC_COMPANY_EXECUTOR_NAME: "Перевозчик",
  LAST_AUTO_DOC_DRIVER_FULL_NAME: "Водитель",
  LAST_AUTO_DOC_DRIVER_PHONES_COMMA: "Телефон водителя",
  LAST_AUTO_DOC_AUTO_GOS_NUMBER: "Номер автомашины",
  LAST_AUTO_DOC_HOOK_GOS_NUMBER: "Номер прицепа",
  LAST_STATUS_ROUTE: "Маршрут груза",
};

const companyFields = {
  ID:"Номер записи", LIST_COMPANY_NAME:"Наименование", LIST_COMPANY_NAME_LARGE:"Полное наименование",
  LIST_COMPANY_NAME_SMALL:"Краткое наименование", INN:"ИНН", KPP:"КПП", EMAIL:"E-mail", PHONE:"Телефон",
  PHONE2:"Телефон (раб.)", ROLES_NAMES:"Роли", FIRST_UR_COMPANY_ADDRESS_ADDRESS_TEXT:"Юридический адрес",
  FIRST_ACTUAL_COMPANY_ADDRESS_ADDRESS_TEXT:"Фактический адрес",
};
const vehicleFields = {
  ID:"Номер записи", GOS_NUMBER_AUTO:"Государственный номер", LIST_COMPANY_NAME:"Автоперевозчик",
  LIST_TYPE_MODEL_AUTO_NAME:"Марка", LIST_TYPE_VAN_NAME:"Тип кузова", CHASSIS_NUMBER_AUTO:"Номер шасси",
  VIN_NUMBER_AUTO:"VIN номер", NOTE:"Примечание",
};
const driverFields = {
  ID:"Номер записи", FULL_NAME:"Полное имя", DRIVER_NAME:"Имя", SURNAME:"Фамилия", PATRONYMIC:"Отчество",
  LIST_COMPANY_NAME:"Автоперевозчик", PHONE1:"Телефон 1", PHONE2:"Телефон 2", DOC_DATE:"Дата выдачи паспорта",
  DOC_INFO:"Кем выдан паспорт", DOC_NUMBER:"Номер паспорта", DOC_SERIAL:"Серия паспорта",
  TRADE_DRIVERS_DOC_NUMBER:"Номер водительского удостоверения", TRADE_DRIVERS_DOC_SERIAL:"Серия водительского удостоверения",
};
const driverDateFieldCandidates = [
  "TRUST_DATE",
  "TRADE_DRIVERS_DOC_DATE",
  "TRADE_DRIVERS_DATE_DOC",
  "TRADE_DRIVERS_LICENSE_DATE",
  "TRADE_DRIVERS_LICENSE_ISSUE_DATE",
  "TRADE_DRIVERS_DATE_END",
  "TRADE_DRIVERS_PROXY_DATE_END",
  "TRADE_DRIVERS_DATE_END_PROXY",
  "TRADE_DRIVERS_PROXY_END_DATE",
  "DRIVER_PROXY_DATE_END",
  "PROXY_DATE_END",
  "DATE_END_PROXY",
  "PROXY_END_DATE",
  "DATE_END_POWER_OF_ATTORNEY",
  "POWER_OF_ATTORNEY_END_DATE",
];
const warehouseFields = {
  ID:"Номер записи", WAREHOUSE_NUMBER_AND_NAME:"Номер склада и название", LIST_CITY_NAME:"Город",
  LIST_COUNTRY_NAME:"Страна", LIST_REGION_NAME:"Регион", COORDS_ADDRESS:"Адрес", LIST_WAREHOUSE_NAME:"Название",
  ROLE_NAMES:"Роли", LIST_WAREHOUSE_NAME_ENG:"Название (англ)", ADDRESS_RUS:"Адрес на русском языке",
  ADDRESS_ENG:"Адрес на английском языке", PERSON_PHONE:"Номер телефона", UNLOCODE:"UN/LOCODE", ITN:"ИНН",
};
const cargoOrderFieldCandidates=["ORDER_NUMBER","NUMBER_ORDER","ORDER_NUM","ORDER_CODE","DOC_PARENT_ORDER_NUMBER","ID_ORDER"];
const warehousePostalCodeFieldCandidates = [
  "POSTAL_CODE",
  "POST_CODE",
  "ZIP_CODE",
  "ZIP",
  "POST_INDEX",
  "ADDRESS_INDEX",
  "INDEX_ADDRESS",
];

const contractFieldCandidates = {
  "Дата договора": ["DATE_CONTRACT", "CONTRACT_DATE", "DATE_BEGIN", "CONTRACT_BEGIN_DATE", "Дата договора"],
  "Срок действия до": ["DATE_END", "CONTRACT_DATE_END", "VALID_TO"],
  "Организация 1": ["LIST_COMPANY_NAME", "COMPANY1_NAME", "COMPANY_1_NAME", "COMPANY_NAME_1", "LIST_COMPANY1_NAME", "LIST_COMPANY_NAME1", "LIST_COMPANY_NAME_1", "FIRST_COMPANY_NAME", "FIRST_LIST_COMPANY_NAME", "Организация 1"],
  "Организация 2": ["LIST_COMPANY2_NAME", "COMPANY2_NAME", "COMPANY_2_NAME", "COMPANY_NAME_2", "LIST_COMPANY_NAME2", "LIST_COMPANY_NAME_2", "SECOND_COMPANY_NAME", "SECOND_LIST_COMPANY_NAME", "Организация 2"],
  "Тип договора": ["TYPE_CONTRACT_NAME", "LIST_TYPE_CONTRACT_NAME", "CONTRACT_TYPE_NAME"],
  "Номер договора": ["NUMBER_CONTRACT", "CONTRACT_NUMBER", "NUM_CONTRACT", "CONTRACT_NUM", "NUMBER", "Номер договора"],
  "Тип взаимоотношений": ["TYPE_RELATIONSHIP_NAME", "LIST_TYPE_RELATIONSHIP_NAME", "RELATIONSHIP_TYPE_NAME"],
  "Бессрочный": ["UNLIMITED", "IS_UNLIMITED", "PERPETUAL"],
  "Архивирование договора": ["ARCHIVE_CONTRACT", "CONTRACT_ARCHIVE", "IS_ARCHIVE"],
};

const autoFields = {
  ID: "Номер записи",
  CREATE_DATE: "Дата создания строки",
  ID_OPERATION_TYPE: "Тип операции",
  UNITS_NUMBERS: "Номера грузовых единиц",
  DOC_PARENT_ORDER_COMPANY_CLIENT_NAME: "Клиент",
  DOC_PARENT_ORDER_COMPANY_PARTNER_NAME: "Партнер",
  COMPANY_EXECUTOR_NAME: "Исполнитель",
  ARRIVAL_POINT_NAMES: "Маршрут",
  DRIVER_FULL_NAME: "Водитель",
  DRIVER_PHONE: "Телефон водителя",
  AUTO_GOS_NUMBER_AUTO: "Номер автомашины",
  HOOK_GOS_NUMBER_HOOK: "Номер прицепа",
  EXPECTED_DATE_START: "Плановая дата отправления",
  ACTUAL_DEPARTURE_DATE_START: "Фактическая дата отправления",
  EXPECTED_DATE_END: "Плановая дата прибытия",
  ACTUAL_DATE_END: "Фактическая дата прибытия",
  CONTAINER_STOCK_NAME: "Контейнерный сток",
  EMPTY_RETURN_INSTRUCTION: "Инструкция на сдачу порожнего",
  EMPTY_RETURN_REDIRECTION: "Перенаправление сдачи порожнего",
  EMPTY_RETURN_DATE: "Дата сдачи порожнего",
  UNITS_GROSS_WEIGHT: "Вес брутто",
  STOCK_NAME: "Место прибытия",
};
const autoConsigneeFieldCandidates=[
  "DOC_PARENT_COMPANY_CONSIGNEE_NAME",
  "DOC_PARENT_ORDER_COMPANY_CONSIGNEE_NAME",
  "DOC_PARENT_ORDER_LIST_COMPANY_CONSIGNEE_NAME",
  "DOC_PARENT_ORDER_CONSIGNEE_COMPANY_NAME",
  "DOC_PARENT_ORDER_COMPANY_CARGO_CONSIGNEE_NAME",
  "DOC_PARENT_ORDER_CARGO_CONSIGNEE_NAME",
  "DOC_PARENT_ORDER_COMPANY_RECEIVER_NAME",
  "DOC_PARENT_ORDER_COMPANY_RECIPIENT_NAME",
  "DOC_PARENT_ORDER_CONSIGNEE_NAME",
  "DOC_PARENT_ORDER_RECEIVER_NAME",
  "DOC_PARENT_ORDER_RECIPIENT_NAME",
  "COMPANY_CONSIGNEE_NAME",
  "CONSIGNEE_COMPANY_NAME",
  "COMPANY_CARGO_CONSIGNEE_NAME",
  "COMPANY_RECEIVER_NAME",
  "RECEIVER_COMPANY_NAME",
  "CONSIGNEE_NAME",
  "Грузополучатель",
];

function cookiesFrom(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function login(loginName, password) {
  const first = await fetch(`${BASE}/login`, { redirect: "manual" });
  let cookie = cookiesFrom(first.headers);
  const body = new URLSearchParams({ deviceType: "desktop", login: loginName, password });
  const response = await fetch(`${BASE}/login`, { method: "POST", body, headers: { Cookie: cookie }, redirect: "manual" });
  cookie = [cookie, cookiesFrom(response.headers)].filter(Boolean).join("; ");
  const result = await response.json().catch(() => ({}));
  if (!cookie.includes("token=") || result?.result?.status === "error") throw new Error("TMS не приняла логин или пароль");
  const token = /(?:^|;\s*)token=([^;]+)/.exec(cookie)?.[1] || "";
  return { cookie, token };
}

function tmsDateTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  const russian = /^(\d{1,2})[.](\d{1,2})[.](\d{4})/.exec(text);
  if (russian) return Date.UTC(Number(russian[3]), Number(russian[2]) - 1, Number(russian[1]));
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

const wait = (milliseconds) => new Promise(resolve=>setTimeout(resolve,milliseconds));
async function fetchTmsTable(url,options) {
  let response;
  for(let attempt=0;attempt<4;attempt+=1) {
    response=await fetch(url,options);
    if(![429,502,503,504].includes(response.status)) return response;
    if(attempt<3) {
      try { await response.body?.cancel(); } catch {}
      await wait(750*(2**attempt));
    }
  }
  return response;
}

async function getRows(session, table, fields, filters, createdSince = "", onProgress = () => {}) {
  const keys = Object.keys(fields);
  const minimumCreatedAt = createdSince ? Date.parse(createdSince + "T00:00:00Z") : NaN;
  const all = [];
  const pageSize = table === "OPERATION_SUB_DOC" ? 1000 : table === "OPERATION_UNIT" ? 2000 : 4000;
  const maxRows = ({OPERATION_UNIT:16000,OPERATION_SUB_DOC:24000,LIST_COMPANY:50000,LIST_AUTO:50000,LIST_DRIVERS:50000,LIST_WAREHOUSE:50000})[table] || 50000;
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const data = { viewedFields: keys, offset, limit: pageSize, sort: [{ ID: -1 }], ...(filters ? { filters } : {}) };
    const body = new URLSearchParams({ json: JSON.stringify(data) });
    const response = await fetchTmsTable(`${BASE}/api/table/get/${table}`, {
      method: "POST", body,
      headers: { Cookie: session.cookie, Autorization: session.token, "TableApi2-method": "get" },
    });
    if (!response.ok) {
      if (offset === 0 && Object.hasOwn(fields, "CREATE_DATE")) {
        const compatibleFields = { ...fields };
        delete compatibleFields.CREATE_DATE;
        return getRows(session, table, compatibleFields, filters, "");
      }
      throw new Error(`TMS вернула ошибку ${response.status} для ${table}`);
    }
    const json = await response.json();
    if (json?.result?.status !== "success" || !Array.isArray(json?.result?.rows)) {
      // Some TMS installations do not expose CREATE_DATE in these registries.
      // Retry without that optional field so an update is not blocked completely.
      if (offset === 0 && Object.hasOwn(fields, "CREATE_DATE")) {
        const compatibleFields = { ...fields };
        delete compatibleFields.CREATE_DATE;
        return getRows(session, table, compatibleFields, filters, "");
      }
      const details = json?.result?.message || json?.result?.error || json?.message || "";
      throw new Error(`Не удалось прочитать ${table}${details ? `: ${details}` : ""}`);
    }
    for (const values of json.result.rows) {
      const row = {};
      keys.forEach((key, index) => { row[fields[key]] = values[index] ?? ""; });
      if (table === "OPERATION_SUB_DOC" && String(row["Тип операции"]) !== "1") continue;
      const createdAt = tmsDateTimestamp(row["Дата создания строки"]);
      if (Number.isFinite(minimumCreatedAt) && Number.isFinite(createdAt) && createdAt < minimumCreatedAt) continue;
      const route = String(row["Маршрут"] || "");
      const points = route.split(/\s*(?:->|→|—>)\s*/);
      row["Место отправления"] = points[0] || "";
      row["Место прибытия"] ||= points.at(-1) || "";
      all.push(row);
    }
    onProgress(all.length,`Получено ${all.length.toLocaleString("ru-RU")} строк`,Math.min(95,Math.max(5,Math.round(all.length/maxRows*95))));
    if (json.result.rows.length < pageSize) break;
  }
  return all;
}

async function supportsField(session,table,fieldName){
  const body=new URLSearchParams({json:JSON.stringify({viewedFields:["ID",fieldName],offset:0,limit:1,sort:[{ID:-1}]})});
  const response=await fetchTmsTable(`${BASE}/api/table/get/${table}`,{method:"POST",body,headers:{Cookie:session.cookie,Autorization:session.token,"TableApi2-method":"get"}});
  if(!response.ok)return false;const json=await response.json().catch(()=>({}));return json?.result?.status==="success"&&Array.isArray(json?.result?.rows);
}

async function firstSupportedField(session,table,candidates){
  for(const fieldName of candidates){if(await supportsField(session,table,fieldName))return fieldName;}
  return "";
}

async function getContractRows(session,onProgress){
  const fields={ID:"Номер записи"};
  for(const [label,candidates] of Object.entries(contractFieldCandidates)){
    const fieldName=await firstSupportedField(session,"LIST_CONTRACTS",candidates);
    if(fieldName)fields[fieldName]=label;
  }
  for(const required of ["Организация 1","Номер договора"]){
    if(!Object.values(fields).includes(required))throw new Error("TMS не предоставила поле «"+required+"» реестра договоров");
  }
  return getRows(session,"LIST_CONTRACTS",fields,null,"",onProgress);
}

async function getAutoRows(session,filters,createdSince,onProgress){
  const supported=[];
  for(const fieldName of autoConsigneeFieldCandidates){
    if(await supportsField(session,"OPERATION_SUB_DOC",fieldName))supported.push(fieldName);
  }
  if(!supported.length)return getRows(session,"OPERATION_SUB_DOC",autoFields,filters,createdSince,onProgress);
  const fields={...autoFields};
  supported.forEach((fieldName,index)=>{fields[fieldName]=`Грузополучатель (${index+1})`;});
  const rows=await getRows(session,"OPERATION_SUB_DOC",fields,filters,createdSince,onProgress);
  return rows.map(row=>{
    row["Грузополучатель"]=supported.map((_,index)=>String(row[`Грузополучатель (${index+1})`]||"").trim()).find(Boolean)||"";
    supported.forEach((_,index)=>delete row[`Грузополучатель (${index+1})`]);
    return row;
  });
}

async function getDriverRows(session,onProgress=()=>{}) {
  const fieldName = await firstSupportedField(session,"LIST_DRIVERS",driverDateFieldCandidates);
  if (!fieldName) return getRows(session,"LIST_DRIVERS",driverFields,null,"",onProgress);
  return getRows(session,"LIST_DRIVERS",{...driverFields,[fieldName]:"Дата окончания доверенности"},null,"",onProgress);
}

async function getCargoRows(session,filters,createdSince,onProgress){
  const fieldName=await firstSupportedField(session,"OPERATION_UNIT",cargoOrderFieldCandidates);
  return getRows(session,"OPERATION_UNIT",fieldName?{...cargoFields,[fieldName]:"Номер заказа"}:cargoFields,filters,createdSince,onProgress);
}

async function getWarehouseRows(session,onProgress=()=>{}) {
  const fields={...warehouseFields};
  const postalField=await firstSupportedField(session,"LIST_WAREHOUSE",warehousePostalCodeFieldCandidates);
  if(postalField)fields[postalField]="Индекс";
  return getRows(session,"LIST_WAREHOUSE",fields,null,"",onProgress);
}

const cleanText=value=>String(value??"").replace(/\s+/g," ").trim();
const normalizedName=value=>cleanText(value).toLocaleUpperCase("ru-RU").replace(/[«»"'\x60]/g,"").replace(/\b(?:ООО|АО|ПАО|ЗАО|ИП|ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ)\b/g,"").replace(/[^A-ZА-Я0-9]+/g,"");
const compactDate=value=>{if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);if(typeof value==="number"&&Number.isFinite(value)){const parsed=new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000);if(!Number.isNaN(parsed.getTime()))return parsed.toISOString().slice(0,10);}const text=cleanText(value);const match=text.match(/^(\d{4})-(\d{2})-(\d{2})/);if(match)return [match[1],match[2],match[3]].join("-");const russian=text.match(/^(\d{1,2})[.](\d{1,2})[.](\d{4})/);if(russian)return [russian[3],russian[2].padStart(2,"0"),russian[1].padStart(2,"0")].join("-");const slash=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);if(slash){const year=slash[3].length===2?"20"+slash[3]:slash[3];return [year,slash[1].padStart(2,"0"),slash[2].padStart(2,"0")].join("-");}return "";};
const truthy=value=>["1","true","да","yes"].includes(cleanText(value).toLowerCase());

export function contractRowsToCatalog(rows){
  const today=new Date().toISOString().slice(0,10);
  return rows.flatMap(row=>{
    const number=cleanText(row["Номер договора"]),company1=cleanText(row["Организация 1"]),company2=cleanText(row["Организация 2"]);
    const taglex=normalizedName("ООО Таглекс"),company1IsTaglex=normalizedName(company1)===taglex,company2IsTaglex=normalizedName(company2)===taglex;
    const counterparty=company1IsTaglex&&company2?company2:company2IsTaglex&&company1?company1:company2||company1;
    if(!number||!counterparty||truthy(row["Архивирование договора"]))return [];
    const endDate=compactDate(row["Срок действия до"]);
    if(endDate&&!truthy(row["Бессрочный"])&&endDate<today)return [];
    const relationship=cleanText(row["Тип взаимоотношений"]).toLowerCase(),type=cleanText(row["Тип договора"]);
    const carrier=/подряд|поставщ|перевоз/.test(relationship+" "+type.toLowerCase());
    return [{[carrier?"carrier":"client"]:counterparty,aliases:[counterparty],number,date:compactDate(row["Дата договора"]),title:type||"Договор"}];
  });
}

function writeContractCatalog(target,rows){
  let existing=[];try{existing=JSON.parse(fs.readFileSync(target,"utf8").replace(/^\uFEFF/,""));}catch{}
  const merged=new Map();
  for(const item of [...existing,...contractRowsToCatalog(rows)]){
    const party=item.carrier||item.client||item.counterparty||"";
    const key=(item.carrier?"carrier":"client")+"|"+normalizedName(party)+"|"+cleanText(item.number).toUpperCase();
    if(party&&item.number)merged.set(key,item);
  }
  fs.writeFileSync(target,JSON.stringify([...merged.values()],null,2)+"\n");
}

function writeWorkbook(target, sheetName, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), sheetName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  XLSX.writeFile(workbook, target, { compression: true });
}
function writeGeneratorCache(target,rows) {
  fs.writeFileSync(target,JSON.stringify(rows));
}

export async function syncTms({ login: loginName, password, cacheDir, referenceDir, onStatus = () => {} }) {
  onStatus("login","working","Входим в TMS…");
  let session;
  try { session = await login(loginName, password); onStatus("login","saved","Вход выполнен"); }
  catch(error) { onStatus("login","error","TMS недоступна или не приняла данные входа"); throw error; }
  const fourMonthsAgo = new Date();
  fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
  const createdSince = fourMonthsAgo.toISOString().slice(0, 10);
  // CREATE_DATE is not accepted as a server-side filter by every TMS table.
  // Keep the API request compatible and apply the four-month limit locally.
  const autoFilter = { tryNewFilterFormat: true, value: [["ID_OPERATION_TYPE", "=", 1]] };
  const tasks = [
    ["cargo","OPERATION_UNIT",cargoFields,null,cacheDir,"cargo.xlsx",createdSince],
    ["auto","OPERATION_SUB_DOC",autoFields,autoFilter,cacheDir,"auto.xlsx",createdSince],
    ["companies","LIST_COMPANY",companyFields,null,referenceDir,"companies.xlsx",""],
    ["vehicles","LIST_AUTO",vehicleFields,null,referenceDir,"vehicles.xlsx",""],
    ["drivers","LIST_DRIVERS",driverFields,null,referenceDir,"drivers.xlsx",""],
    ["points","LIST_WAREHOUSE",warehouseFields,null,referenceDir,"route-points.xlsx",""],
    ["contracts","LIST_CONTRACTS",null,null,referenceDir,"contracts.xlsx",""],
  ];
  const counts = {};
  const runTask = async ([key,table,fields,filter,targetDir,filename,minimumDate]) => {
    onStatus(key,"working","Получаем данные…");
    try {
      const progress=(count,message,progressValue)=>onStatus(key,"working",message,{count,progress:progressValue});
      const rows=key==="drivers"?await getDriverRows(session,progress):key==="points"?await getWarehouseRows(session,progress):key==="auto"?await getAutoRows(session,filter,minimumDate,progress):key==="cargo"?await getCargoRows(session,filter,minimumDate,progress):key==="contracts"?await getContractRows(session,progress):await getRows(session,table,fields,filter,minimumDate,progress);
      if(!rows.length) throw new Error("реестр пуст");
      const target=path.join(targetDir,filename);
      writeWorkbook(target,table,rows);
      if(key==="contracts")writeContractCatalog(path.join(referenceDir,"contracts.json"),rows);
      else writeGeneratorCache(target.replace(/\.xlsx$/i,".json"),rows);
      counts[key]=rows.length; onStatus(key,"saved",rows.length.toLocaleString("ru-RU")+" строк");
    } catch(error) {
      if(key==="contracts"){
        const saved=path.join(referenceDir,"contracts.json");
        if(fs.existsSync(saved)){
          let count=0;try{count=JSON.parse(fs.readFileSync(saved,"utf8").replace(/^\uFEFF/,"")).length;}catch{}
          counts.contracts=count;onStatus(key,"saved","Используется сохранённый справочник: "+count.toLocaleString("ru-RU")+" договоров. "+(error.message||""));return;
        }
        counts.contracts=0;
        onStatus(key,"saved","Реестр договоров временно недоступен. Остальные справочники обновлены; договоры можно загрузить отдельно.");
        return;
      }
      onStatus(key,"error",error.message||"Ошибка");throw error;
    }
  };
  // The two transport registries are the heaviest TMS queries. Run them one
  // after another to avoid temporary 503 responses from the shared server.
  for(const task of tasks.slice(0,2)) await runTask(task);
  await Promise.all(tasks.slice(2).map(runTask));
  return { ...counts, updatedAt: new Date().toISOString() };
}
