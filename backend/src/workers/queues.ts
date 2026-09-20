import { Queue } from "bullmq";
import { env } from "../config/env";

const connection = { url: env.redisUrl };

/**
 * Decoupled queues for heavy/rate-limited SP-API work. Each module publishes
 * jobs here instead of calling SP-API inline from an HTTP request, so a slow
 * report or a throttled endpoint never blocks a web request.
 */
export const reportIngestionQueue = new Queue("report-ingestion", { connection });
export const feedProcessingQueue = new Queue("feed-processing", { connection });
export const pricingPollQueue = new Queue("pricing-poll", { connection });
