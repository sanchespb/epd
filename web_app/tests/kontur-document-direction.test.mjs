import test from "node:test";
import assert from "node:assert/strict";
import {forwardingDirection} from "../kontur-document-direction.mjs";

test("реальное поле DocumentDirection разделяет входящие и исходящие",()=>{
  assert.equal(forwardingDirection({DocumentDirection:"Inbound"}),"incoming");
  assert.equal(forwardingDirection({DocumentDirection:"Outbound"}),"outgoing");
});

test("отсутствующее направление нельзя считать исходящим",()=>{
  assert.throws(()=>forwardingDirection({IsIncoming:true}),/не указал направление/);
});
