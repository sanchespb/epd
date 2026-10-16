const containerPattern = /(?<![A-Z0-9])[A-Z]{4}\d{7}(?![A-Z0-9])/gi;

export function containsContainer(value, container) {
  return [...String(value || "").matchAll(containerPattern)]
    .some(match => match[0].toUpperCase() === container);
}

export function activeForwardingDrafts(events) {
  // GetDocflowEvents is requested newest first. Keep only the latest state of
  // each draft so a later recycle event cannot look like an active document.
  const latest = new Map();
  for (const event of events) {
    const id = event.DocumentId || event.Document?.DocumentId || {};
    if (!id.MessageId || !id.EntityId) continue;
    const key = `${id.MessageId}:${id.EntityId}`;
    if (!latest.has(key)) latest.set(key, event);
  }
  return [...latest.values()].flatMap(event => {
    const document = event.Document || {};
    const info = document.DocumentInfo || {};
    if (info.MessageType !== "Draft" || info.FullVersion?.TypeNamedId !== "LogisticsForwardingOrder"
        || info.IsDeleted || !info.DraftInfo || info.DraftInfo.IsRecycled) return [];
    const participants = info.Participants?.Participants || [];
    if (!participants.some(participant => participant.Type === "Recipient")) return [];
    const metadata = Object.fromEntries((info.Metadata || []).map(item => [item.Key, item.Value]));
    const id = event.DocumentId || document.DocumentId;
    return [{messageId:id.MessageId, entityId:id.EntityId, number:String(metadata.DocumentNumber || "")}];
  });
}
