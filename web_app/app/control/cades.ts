type CadesPlugin={
  CreateObjectAsync:(name:string)=>Promise<any>;
  CAPICOM_CURRENT_USER_STORE:number;
  CAPICOM_MY_STORE:string;
  CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED:number;
  CADESCOM_BASE64_TO_BINARY:number;
  CADESCOM_CADES_BES:number;
};

declare global { interface Window { cadesplugin?:CadesPlugin } }

export type CertificateOption={thumbprint:string;subject:string;validFrom:string;validTo:string};

const pluginUrl="https://www.cryptopro.ru/sites/default/files/products/cades/cadesplugin_api.js";
export async function loadCadesPlugin(){
  if(window.cadesplugin)return window.cadesplugin;
  await new Promise<void>((resolve,reject)=>{const existing=document.querySelector<HTMLScriptElement>(`script[src="${pluginUrl}"]`);if(existing){existing.addEventListener("load",()=>resolve(),{once:true});existing.addEventListener("error",()=>reject(new Error("Не удалось загрузить модуль КриптоПро")),{once:true});return;}const script=document.createElement("script");script.src=pluginUrl;script.onload=()=>resolve();script.onerror=()=>reject(new Error("Не удалось загрузить модуль КриптоПро"));document.head.appendChild(script);});
  if(!window.cadesplugin)throw new Error("Установите КриптоПро ЭЦП Browser plug-in и его расширение для браузера");
  return window.cadesplugin;
}

async function openStore(plugin:CadesPlugin){const store=await plugin.CreateObjectAsync("CAdESCOM.Store");await store.Open(plugin.CAPICOM_CURRENT_USER_STORE,plugin.CAPICOM_MY_STORE,plugin.CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED);return store;}

export async function listCertificates():Promise<CertificateOption[]>{const plugin=await loadCadesPlugin();const store=await openStore(plugin);try{const certificates=await store.Certificates;const count=await certificates.Count;const result:CertificateOption[]=[];for(let index=1;index<=count;index++){const certificate=await certificates.Item(index);result.push({thumbprint:String(await certificate.Thumbprint).replace(/\s/g,""),subject:String(await certificate.SubjectName),validFrom:new Date(await certificate.ValidFromDate).toLocaleDateString("ru-RU"),validTo:new Date(await certificate.ValidToDate).toLocaleDateString("ru-RU")});}return result;}finally{await store.Close();}}

export async function signDetached(contentBase64:string,thumbprint:string){const plugin=await loadCadesPlugin();const store=await openStore(plugin);try{const certificates=await store.Certificates;const found=await certificates.Find(0,thumbprint);if(Number(await found.Count)!==1)throw new Error("Выбранный сертификат не найден");const certificate=await found.Item(1);const signer=await plugin.CreateObjectAsync("CAdESCOM.CPSigner");await signer.propset_Certificate(certificate);await signer.propset_CheckCertificate(true);const signedData=await plugin.CreateObjectAsync("CAdESCOM.CadesSignedData");await signedData.propset_ContentEncoding(plugin.CADESCOM_BASE64_TO_BINARY);await signedData.propset_Content(contentBase64);return String(await signedData.SignCades(signer,plugin.CADESCOM_CADES_BES,true)).replace(/\s/g,"");}finally{await store.Close();}}
