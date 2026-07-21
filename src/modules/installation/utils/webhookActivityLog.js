const WebhookLog = require("../../../models/WebhookLog");
const StoreWebhookEvent = require("../../../models/StoreWebhookEvent");
const StoreWebhook = require("../../../models/StoreWebhook");
const { WEBHOOK_LOG_STEPS_SET } = require("../../../models/constants");

function buildWebhookTraceId(storeHash, eventHash) {
  if (!storeHash || !eventHash) {
    return null;
  }

  return `webhook-${storeHash}-${eventHash}`;
}

function buildBurstTraceId(storeHash, burstKey) {
  return `webhook-burst-${storeHash}-${burstKey}`;
}

function resolveTraceId({ traceId, storeHash, eventHash }) {
  return traceId || buildWebhookTraceId(storeHash, eventHash) || `webhook-${storeHash}-${Date.now()}`;
}

async function nextWebhookLogContext(traceId, storeHash, eventHash) {
  if (storeHash && eventHash) {
    const event = await StoreWebhookEvent.findOneAndUpdate(
      { store_hash: storeHash, event_hash: eventHash },
      { $inc: { log_sequence: 1 } },
      { returnDocument: "after" }
    )
      .select({ log_sequence: 1, user_id: 1 })
      .lean();
    if (event) {
      return {
        sequence: event.log_sequence,
        webhookEventId: event._id,
        userId: event.user_id || null,
      };
    }
  }

  const lastLog = await WebhookLog.findOne({ trace_id: traceId })
    .sort({ sequence: -1 })
    .select({ sequence: 1 })
    .lean();

  return {
    sequence: (lastLog?.sequence || 0) + 1,
    webhookEventId: null,
    userId: null,
  };
}

async function appendWebhookLog({
  traceId = null,
  storeHash,
  eventHash = null,
  scope = null,
  productId = null,
  imageId = null,
  logType = "info",
  step = null,
  message,
  meta = {},
}) {
  if (!storeHash || !message) {
    return { error: "storeHash and message are required for webhook activity log" };
  }

  if (step && !WEBHOOK_LOG_STEPS_SET.has(step)) {
    return { error: `Invalid webhook log step: ${step}` };
  }

  try {
    const resolvedTraceId = resolveTraceId({ traceId, storeHash, eventHash });
    const { sequence, webhookEventId, userId } = await nextWebhookLogContext(
      resolvedTraceId,
      storeHash,
      eventHash
    );

    await WebhookLog.create({
      user_id: userId,
      webhook_event_id: webhookEventId,
      trace_id: resolvedTraceId,
      store_hash: storeHash,
      event_hash: eventHash,
      scope,
      product_id: productId,
      image_id: imageId,
      log_type: logType,
      step,
      sequence,
      message: String(message),
      meta,
    });
    return { error: null };
  } catch (err) {
    console.error("[appendWebhookLog]", err.message, {
      traceId,
      storeHash,
      step,
      logType,
    });
    return { error: err.message };
  }
}

async function upsertWebhookEvent({
  traceId = null,
  storeHash,
  eventHash,
  scope = null,
  productId = null,
  storeId = null,
  status = "received",
  payload = null,
  errorMessage = null,
}) {
  if (!storeHash || !eventHash) {
    return { error: "storeHash and eventHash are required for webhook event" };
  }

  try {
    const registration = scope
      ? await StoreWebhook.findOne({ store_hash: storeHash, scope })
          .select({ _id: 1, user_id: 1 })
          .lean()
      : null;
    await StoreWebhookEvent.findOneAndUpdate(
      { store_hash: storeHash, event_hash: eventHash },
      {
        $set: {
          ...(registration?.user_id ? { user_id: registration.user_id } : {}),
          ...(registration?._id ? { webhook_id: registration._id } : {}),
          trace_id: resolveTraceId({ traceId, storeHash, eventHash }),
          store_hash: storeHash,
          event_hash: eventHash,
          scope,
          product_id: productId,
          store_id: storeId,
          status,
          payload,
          error_message: errorMessage,
          received_at: new Date(),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).lean();
    return { error: null };
  } catch (err) {
    console.error("[upsertWebhookEvent]", err.message, {
      traceId,
      storeHash,
      eventHash,
      status,
    });
    return { error: err.message };
  }
}

module.exports = {
  appendWebhookLog,
  upsertWebhookEvent,
  buildWebhookTraceId,
  buildBurstTraceId,
  resolveTraceId,
};
