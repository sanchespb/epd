export const forwardingDraftDisabledMessage = "Автоматическая передача поручений в Контур временно отключена: документы могут не пройти обработку в Контур.Логистике. Скачайте XML и загрузите его вручную.";

export function assertDraftTransferAllowed(kind) {
  if (kind === "forwarding") throw new Error(forwardingDraftDisabledMessage);
}

export function draftMessageToPost({fromBoxId, recipientBoxId, kind, content, format}) {
  if (kind === "forwarding" && !recipientBoxId) {
    throw new Error("Для поручения не найден ящик ЭДО перевозчика. Обновите справочник ЭДО и проверьте выбранный ID.");
  }
  return {
    FromBoxId: fromBoxId,
    ...(recipientBoxId ? {ToBoxId: recipientBoxId} : {}),
    IsDraft: true,
    StrictDraftValidation: kind === "forwarding",
    DocumentAttachments: [{SignedContent: {Content: content}, ...format}],
  };
}

export function savedDraftDocument(result, expectedRecipientBoxId = "") {
  const document = result?.Entities?.find(item => item.EntityType === "Attachment");
  if (!result?.MessageId || !document?.EntityId || !result.IsDraft) {
    throw new Error("Диадок не подтвердил создание черновика. Проверьте ответ API перед повторной отправкой.");
  }
  const normalizeBoxId = value => String(value || "").replace(/@diadoc\.ru$/i, "").replaceAll("-", "").toLowerCase();
  if (expectedRecipientBoxId && normalizeBoxId(result.ToBoxId) !== normalizeBoxId(expectedRecipientBoxId)) {
    throw new Error("Диадок сохранил черновик без выбранного ящика ЭДО перевозчика. Проверьте документ по ID операции.");
  }
  return document;
}
