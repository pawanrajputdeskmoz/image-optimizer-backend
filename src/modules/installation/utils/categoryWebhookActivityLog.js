const CategoryWebhookLog = require("../../../models/CategoryWebhookLog");
const StoreCategoryWebhookEvent = require("../../../models/StoreCategoryWebhookEvent");
const StoreCategoryWebhook = require("../../../models/StoreCategoryWebhook");
const { WEBHOOK_LOG_STEPS_SET } = require("../../../models/constants");

function buildCategoryWebhookTraceId(storeHash, eventHash) {
  if (!storeHash || !eventHash) {
    return null;
  }

  return `category-webhook-${storeHash}-${eventHash}`;
}

function buildCategoryBurstTraceId(storeHash, burstKey) {
  return `category-webhook-burst-${storeHash}-${burstKey}`;
}

function resolveTraceId({ traceId, storeHash, eventHash }) {
  return (
    traceId ||
    buildCategoryWebhookTraceId(storeHash, eventHash) ||
    `category-webhook-${storeHash}-${Date.now()}`
  );
}

async function nextCategoryWebhookLogContext(traceId, storeHash, eventHash) {
  if (storeHash && eventHash) {
    const event = await StoreCategoryWebhookEvent.findOneAndUpdate(
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

  const lastLog = await CategoryWebhookLog.findOne({ trace_id: traceId })
    .sort({ sequence: -1 })
    .select({ sequence: 1 })
    .lean();

  return {
    sequence: (lastLog?.sequence || 0) + 1,
    webhookEventId: null,
    userId: null,
  };
}

async function appendCategoryWebhookLog({
  traceId = null,
  storeHash,
  eventHash = null,
  scope = null,
  categoryId = null,
  logType = "info",
  step = null,
  message,
  meta = {},
}) {
  if (!storeHash || !message) {
    return { error: "storeHash and message are required for category webhook activity log" };
  }

  if (step && !WEBHOOK_LOG_STEPS_SET.has(step)) {
    return { error: `Invalid category webhook log step: ${step}` };
  }

  try {
    const resolvedTraceId = resolveTraceId({ traceId, storeHash, eventHash });
    const { sequence, webhookEventId, userId } =
      await nextCategoryWebhookLogContext(resolvedTraceId, storeHash, eventHash);

    await CategoryWebhookLog.create({
      user_id: userId,
      webhook_event_id: webhookEventId,
      trace_id: resolvedTraceId,
      store_hash: storeHash,
      event_hash: eventHash,
      scope,
      category_id: categoryId,
      log_type: logType,
      step,
      sequence,
      message: String(message),
      meta,
    });
    return { error: null };
  } catch (err) {
    console.error("[appendCategoryWebhookLog]", err.message, {
      traceId,
      storeHash,
      step,
      logType,
    });
    return { error: err.message };
  }
}

async function upsertCategoryWebhookEvent({
  traceId = null,
  storeHash,
  eventHash,
  scope = null,
  categoryId = null,
  storeId = null,
  status = "received",
  payload = null,
  errorMessage = null,
}) {
  if (!storeHash || !eventHash) {
    return { error: "storeHash and eventHash are required for category webhook event" };
  }

  try {
    const registration = scope
      ? await StoreCategoryWebhook.findOne({ store_hash: storeHash, scope })
          .select({ _id: 1, user_id: 1 })
          .lean()
      : null;
    await StoreCategoryWebhookEvent.findOneAndUpdate(
      { store_hash: storeHash, event_hash: eventHash },
      {
        $set: {
          ...(registration?.user_id ? { user_id: registration.user_id } : {}),
          ...(registration?._id ? { webhook_id: registration._id } : {}),
          trace_id: resolveTraceId({ traceId, storeHash, eventHash }),
          store_hash: storeHash,
          event_hash: eventHash,
          scope,
          category_id: categoryId,
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
    console.error("[upsertCategoryWebhookEvent]", err.message, {
      traceId,
      storeHash,
      eventHash,
      status,
    });
    return { error: err.message };
  }
}

module.exports = {
  appendCategoryWebhookLog,
  upsertCategoryWebhookEvent,
  buildCategoryWebhookTraceId,
  buildCategoryBurstTraceId,
  resolveTraceId,
};
