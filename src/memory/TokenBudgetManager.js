/**
 * TokenBudgetManager
 *
 * NOTE: This file is intentionally left as a stub in memory/.
 *
 * Token budget management is the responsibility of ContextBuilder (ai/),
 * not the memory layer. ContextMemoryService stores and retrieves raw data.
 * ContextBuilder fetches that data via getAll() and then trims it to fit
 * the LLM's token budget before building the prompt.
 *
 * TokenBudgetManager will be implemented in ai/TokenBudgetManager.js
 * and used exclusively by ai/ContextBuilder.js.
 *
 * This stub exists only to document that decision.
 */