import test from "node:test";
import assert from "node:assert/strict";
import { draftMessageToPost, savedDraftDocument } from "../kontur-draft.mjs";
import { konturDocumentUrl, logisticsIdFromCustomData, verifiedForwardingUrl } from "../kontur-document-links.mjs";
import { activeForwardingDrafts } from "../kontur-document-presence.mjs";

test("forwarding draft includes recipient and enables strict validation", () => {
  const message = draftMessageToPost({fromBoxId:"sender",recipientBoxId:"carrier@diadoc.ru",kind:"forwarding",content:"xml",format:{TypeNamedId:"LogisticsForwardingOrder"}});
  assert.equal(message.ToBoxId,"carrier@diadoc.ru");
  assert.equal(message.StrictDraftValidation,true);
  assert.throws(() => draftMessageToPost({fromBoxId:"sender",kind:"forwarding",content:"xml",format:{}}),/ящик ЭДО перевозчика/);
});

test("a successful API response must contain an actual draft attachment", () => {
  assert.equal(savedDraftDocument({MessageId:"message",IsDraft:true,Entities:[{EntityType:"Attachment",EntityId:"entity"}]}).EntityId,"entity");
  assert.throws(() => savedDraftDocument({MessageId:"message",Entities:[]}),/не подтвердил/);
  assert.equal(savedDraftDocument({MessageId:"message",IsDraft:true,ToBoxId:"aabb@diadoc.ru",Entities:[{EntityType:"Attachment",EntityId:"entity"}]},"aa-bb").EntityId,"entity");
  assert.throws(() => savedDraftDocument({MessageId:"message",IsDraft:true,Entities:[{EntityType:"Attachment",EntityId:"entity"}]},"aa-bb"),/без выбранного ящика/);
});

test("links use kl-id only for Logistics and Diadoc IDs otherwise", () => {
  const box="box";
  assert.equal(konturDocumentUrl(box,"message","entity","LogisticsForwardingOrder","kl-document"),"https://logist.kontur.ru/box/consignor/sign/forwardingOrder/kl-document");
  assert.equal(konturDocumentUrl(box,"message","entity","LogisticsForwardingOrder"),"https://diadoc.kontur.ru/box/Document/Show?letterId=message&documentId=entity");
  assert.equal(konturDocumentUrl(box,"message","entity","LogisticsOrderRequest"),"https://diadoc.kontur.ru/box/Document/Show?letterId=message&documentId=entity");
  assert.equal(konturDocumentUrl(box,"message","entity","LogisticsForwardingOrder","","Draft"),null);
  assert.equal(logisticsIdFromCustomData([{Key:"kl-id",Value:"kl-document"}]),"kl-document");
  const known="https://logist.kontur.ru/box/consignor/sign/forwardingOrder/150e2b6e-f56f-42cb-85d6-24db41c92a49";
  assert.equal(verifiedForwardingUrl({CICU6864819:{url:known}},"CICU6864819","box"),known);
  assert.equal(verifiedForwardingUrl({CICU6864819:{url:known}},"CICU6864819","other-box"),null);
});

test("unaddressed forwarding drafts do not count as available", () => {
  const makeEvent = recipients => ({DocumentId:{MessageId:"message",EntityId:"entity"},Document:{DocumentInfo:{MessageType:"Draft",FullVersion:{TypeNamedId:"LogisticsForwardingOrder"},DraftInfo:{IsRecycled:false},Participants:{Participants:recipients},Metadata:[{Key:"DocumentNumber",Value:"CICU6864819"}]}}});
  assert.deepEqual(activeForwardingDrafts([makeEvent([{Type:"Sender"}])]),[]);
  assert.equal(activeForwardingDrafts([makeEvent([{Type:"Sender"},{Type:"Recipient"}])]).length,1);
});
