"use client";
import {useEffect,useState} from "react";
import {CertificateOption,listCertificates,signDetached} from "./cades";
import styles from "./revoke-dialog.module.css";

type DocumentToSign={number:string;documentType:string;messageId:string;entityId:string;documentUrl:string|null};
type PowerOfAttorney={fullId:{RegistrationNumber:string;IssuerInn:string;RepresentativeInn:string};isDefault:boolean;issuerName:string;representativeName:string};
type SignableTitle={canSign:boolean;reason?:string;titleIndex?:number;titleEntityId?:string;contentBase64?:string;contentSha256?:string};
type Props={item:DocumentToSign;onClose:()=>void;onSigned:()=>void|Promise<void>};

export default function SignDialog({item,onClose,onSigned}:Props){
  const [title,setTitle]=useState<SignableTitle|null>(null),[certificates,setCertificates]=useState<CertificateOption[]>([]),[powers,setPowers]=useState<PowerOfAttorney[]>([]);
  const [thumbprint,setThumbprint]=useState(""),[powerId,setPowerId]=useState(""),[busy,setBusy]=useState(true),[error,setError]=useState("");
  useEffect(()=>{let active=true;void Promise.allSettled([
    fetch(`/api/kontur/signable-title?messageId=${encodeURIComponent(item.messageId)}&entityId=${encodeURIComponent(item.entityId)}`,{cache:"no-store"}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось проверить титул");return result as SignableTitle;}),
    listCertificates(),
    fetch("/api/kontur/powers-of-attorney",{cache:"no-store"}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось получить МЧД");return result.items as PowerOfAttorney[];}),
  ]).then(([titleResult,certificateResult,powerResult])=>{if(!active)return;
    if(titleResult.status==="fulfilled")setTitle(titleResult.value);else setError(titleResult.reason instanceof Error?titleResult.reason.message:"Не удалось проверить титул");
    if(certificateResult.status==="fulfilled"){setCertificates(certificateResult.value);setThumbprint(certificateResult.value[0]?.thumbprint||"");}else setError(certificateResult.reason instanceof Error?certificateResult.reason.message:"Не удалось получить сертификаты");
    if(powerResult.status==="fulfilled"){setPowers(powerResult.value);setPowerId(powerResult.value.find(value=>value.isDefault)?.fullId.RegistrationNumber||"");}
  }).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[item.messageId,item.entityId]);
  const selected=certificates.find(value=>value.thumbprint===thumbprint),selectedPower=powers.find(value=>value.fullId.RegistrationNumber===powerId);
  const submit=async()=>{if(!title?.canSign||!title.contentBase64||!selected||busy)return;
    if(!window.confirm(`Подписать ${item.documentType.toLowerCase()} №${item.number} сертификатом «${selected.displayName}» и отправить подпись в Контур? Это юридически значимое действие.`))return;
    setBusy(true);setError("");try{
      const signatureBase64=await signDetached(title.contentBase64,selected.thumbprint);
      const response=await fetch("/api/kontur/sign-document",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messageId:item.messageId,entityId:item.entityId,titleIndex:title.titleIndex,titleEntityId:title.titleEntityId,contentSha256:title.contentSha256,signatureBase64,powerOfAttorney:selectedPower?{fullId:selectedPower.fullId}:null})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||"Контур не принял подпись");
      await onSigned();onClose();window.alert("Подпись отправлена в Контур. Обновите статус документа после обработки.");
    }catch(value){setError(value instanceof Error?value.message:"Не удалось подписать документ");}finally{setBusy(false);}
  };
  return <div className={styles.backdrop} role="presentation"><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="sign-title"><header className={styles.header}><div><h2 id="sign-title">Подписать {item.documentType.toLowerCase()} №{item.number}</h2><p>Подписание выбранным сертификатом прямо из сервиса</p></div><button className={styles.close} type="button" onClick={onClose} aria-label="Закрыть">×</button></header><div className={styles.form}>
    {busy&&!title&&!error&&<p>Проверяем доступность титула и сертификатов…</p>}
    {title?.canSign&&<><p className={styles.wide}>Готов к подписи титул Т{Number(title.titleIndex)+1}. Подпись будет отправлена в Контур после подтверждения.</p><label className={`${styles.field} ${styles.wide}`}><span>Сертификат</span><select value={thumbprint} onChange={event=>setThumbprint(event.target.value)} disabled={busy}>{certificates.map(certificate=><option key={certificate.thumbprint} value={certificate.thumbprint}>{certificate.displayName} · {certificate.organization||"организация не указана"} · до {certificate.validTo}</option>)}</select></label><label className={`${styles.field} ${styles.wide}`}><span>Машиночитаемая доверенность</span><select value={powerId} onChange={event=>setPowerId(event.target.value)} disabled={busy}><option value="">Без МЧД</option>{powers.map(power=><option key={power.fullId.RegistrationNumber} value={power.fullId.RegistrationNumber}>{power.issuerName} → {power.representativeName}{power.isDefault?" · по умолчанию":""}</option>)}</select></label><small className={styles.wide}>Проверьте полномочия подписанта и необходимость МЧД перед отправкой.</small></>}
    {title&&!title.canSign&&<p className={styles.wide}>{title.reason||"Документ пока недоступен для подписи из сервиса."} {item.documentUrl&&<a href={item.documentUrl} target="_blank" rel="noreferrer">Открыть документ в Контуре ↗</a>}</p>}
    {error&&<div className={styles.error} role="alert">{error}</div>}
  </div><footer className={styles.footer}><button className={styles.cancel} type="button" onClick={onClose}>Закрыть</button><button className={styles.send} type="button" onClick={()=>void submit()} disabled={busy||!title?.canSign||!selected}>{busy?"Подождите…":"Подписать и отправить"}</button></footer></section></div>;
}
