const { imageOptimizationQueue, QUEUE_NAME } = require("../../queue/imageOptimizationQueue");

/**
 * Fastify routes for enqueueing jobs.
 *
 * Route required by prompt:
 * - POST /add-job
 */
async function queueRoutes(app) {
  app.post("/add-job", async (request) => {
    // Accept any JSON payload as job data (or an empty object).
    const data = request.body && typeof request.body === "object" ? request.body : {};

    // Add a job to the BullMQ queue.
    const job = await imageOptimizationQueue.add("optimize-image", data, {
      removeOnComplete: 200,
      removeOnFail: 500,
    });

    return {
      ok: true,
      queue: QUEUE_NAME,
      jobId: job.id,
    };
  });
}

module.exports = { queueRoutes };

