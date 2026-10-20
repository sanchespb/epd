export function forwardingDirection(document){
  if(document?.DocumentDirection==="Inbound")return "incoming";
  if(document?.DocumentDirection==="Outbound")return "outgoing";
  throw new Error("Диадок не указал направление поручения");
}
