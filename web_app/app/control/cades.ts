type CadesPlugin={
  CreateObjectAsync:(name:string)=>Promise<any>;
  CAPICOM_CURRENT_USER_STORE:number;
  CAPICOM_MY_STORE:string;
  CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED:number;
  CADESCOM_BASE64_TO_BINARY:number;
  CADESCOM_CADES_BES:number;
  then?:(resolve:()=>void,reject:(error:unknown)=>void)=>void;
};

declare global { interface Window { cadesplugin?:CadesPlugin } }

export type CertificateOption={thumbprint:string;subject:string;displayName:string;organization:string;validFrom:string;validTo:string};

const subjectValue=(subject:string,key:string)=>{const match=subject.match(new RegExp(`(?:^|,\\s*)${key}=(?:"([^"]*)"|([^,]*))`,"i"));return (match?.[1]||match?.[2]||"").trim();};

const pluginUrl="https://www.cryptopro.ru/sites/default/files/products/cades/cadesplugin_api.js";
export async function loadCadesPlugin(){
  if(!window.cadesplugin)await new Promise<void>((resolve,reject)=>{const existing=document.querySelector<HTMLScriptElement>(`script[src="${pluginUrl}"]`);if(existing){existing.addEventListener("load",()=>resolve(),{once:true});existing.addEventListener("error",()=>reject(new Error("Не удалось загрузить модуль КриптоПро")),{once:true});return;}const script=document.createElement("script");script.src=pluginUrl;script.onload=()=>resolve();script.onerror=()=>reject(new Error("Не удалось загрузить модуль КриптоПро"));document.head.appendChild(script);});
  const bridge=window.cadesplugin;
  if(!bridge)throw new Error("Установите КриптоПро ЭЦП Browser plug-in и его расширение для браузера");
  if(typeof bridge.then==="function")await new Promise<void>((resolve,reject)=>bridge.then?.(resolve,reject));
  if(typeof bridge.CreateObjectAsync!=="function")throw new Error("КриптоПро загружен, но расширение браузера не отвечает");
  return {CreateObjectAsync:bridge.CreateObjectAsync.bind(bridge),CAPICOM_CURRENT_USER_STORE:bridge.CAPICOM_CURRENT_USER_STORE,CAPICOM_MY_STORE:bridge.CAPICOM_MY_STORE,CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED:bridge.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED,CADESCOM_BASE64_TO_BINARY:bridge.CADESCOM_BASE64_TO_BINARY,CADESCOM_CADES_BES:bridge.CADESCOM_CADES_BES};
}

async function openStore(plugin:CadesPlugin){const store=await plugin.CreateObjectAsync("CAdESCOM.Store");await store.Open(plugin.CAPICOM_CURRENT_USER_STORE,plugin.CAPICOM_MY_STORE,plugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED);return store;}

export async function listCertificates():Promise<CertificateOption[]>{const plugin=await loadCadesPlugin();const store=await openStore(plugin);try{const certificates=await store.Certificates;const count=await certificates.Count;const result:CertificateOption[]=[];const now=Date.now();for(let index=1;index<=count;index++){const certificate=await certificates.Item(index);const validFromDate=new Date(await certificate.ValidFromDate);const validToDate=new Date(await certificate.ValidToDate);const hasPrivateKey=typeof certificate.HasPrivateKey==="function"?await certificate.HasPrivateKey():Boolean(await certificate.HasPrivateKey);if(!hasPrivateKey||validFromDate.getTime()>now||validToDate.getTime()<now)continue;const subject=String(await certificate.SubjectName);const family=subjectValue(subject,"SN");const given=subjectValue(subject,"G");result.push({thumbprint:String(await certificate.Thumbprint).replace(/\s/g,""),subject,displayName:[family,given].filter(Boolean).join(" ")||subjectValue(subject,"CN")||"Подписант не указан",organization:subjectValue(subject,"O"),validFrom:validFromDate.toLocaleDateString("ru-RU"),validTo:validToDate.toLocaleDateString("ru-RU")});}return result.sort((a,b)=>a.displayName.localeCompare(b.displayName,"ru"));}finally{await store.Close();}}

export async function signDetached(contentBase64:string,thumbprint:string){const plugin=await loadCadesPlugin();const store=await openStore(plugin);try{const certificates=await store.Certificates;const found=await certificates.Find(0,thumbprint);if(Number(await found.Count)!==1)throw new Error("Выбранный сертификат не найден");const certificate=await found.Item(1);const signer=await plugin.CreateObjectAsync("CAdESCOM.CPSigner");await signer.propset_Certificate(certificate);await signer.propset_CheckCertificate(true);const signedData=await plugin.CreateObjectAsync("CAdESCOM.CadesSignedData");await signedData.propset_ContentEncoding(plugin.CADESCOM_BASE64_TO_BINARY);await signedData.propset_Content(contentBase64);return String(await signedData.SignCades(signer,plugin.CADESCOM_CADES_BES,true)).replace(/\s/g,"");}finally{await store.Close();}}
