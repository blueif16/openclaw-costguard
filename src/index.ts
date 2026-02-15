import { estimateCost } from "./pricing.js";
import { insertUsage } from "./db.js";
import { parseSessionKey } from "./attribution.js";
import { checkBudget, type BudgetConfig } from "./budget.js";
import { formatCostReport } from "./formatter.js";

interface CostguardConfig {
  enabled?: boolean;
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  budgetAction?: "warn" | "block";
}

/**
 * OpenClaw Plugin Entry Point
 *
 * Hooks into diagnostics.usage to record every model invocation,
 * enforces budget limits, and exposes a /cost slash command.
 */
export default function costguardPlugin(context: any) {
  const config: CostguardConfig = context.config ?? {};

  if (config.enabled === false) return;

  const budgetConfig: BudgetConfig = {
    dailyLimitUsd: config.dailyLimitUsd,
    monthlyLimitUsd: config.monthlyLimitUsd,
    action: config.budgetAction ?? "warn",
  };

  // --- Hook: Diagnostics Usage Event ---
  context.hooks.on("diagnostics.usage", (event: any) => {
    try {
      const { source, jobId } = parseSessionKey(event.sessionKey ?? "");

      const costUsd = estimateCost(
        event.model ?? "",
        event.inputTokens ?? 0,
        event.outputTokens ?? 0,
        event.cacheReadTokens ?? 0,
        event.cacheWriteTokens ?? 0
      );

      insertUsage({
        timestamp: event.timestamp ?? Date.now(),
        sessionKey: event.sessionKey ?? "unknown",
        agentId: event.agentId ?? "unknown",
        source,
        jobId,
        model: event.model ?? "unknown",
        provider: event.provider ?? "unknown",
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheWriteTokens: event.cacheWriteTokens ?? 0,
        costUsd,
        durationMs: event.durationMs ?? 0,
      });

      // Budget check
      const check = checkBudget(budgetConfig);
      if (check.exceeded) {
        context.log?.warn?.(check.message);
      }
    } catch (err) {
      context.log?.error?.("costguard: failed to record usage", err);
    }
  });

  // --- Slash Command: /cost ---
  context.commands?.register?.({
    name: "cost",
    description: "Show cost summary",
    handler: (args: string) => {
      const period = args?.trim() || "today";
      const validPeriods = ["today", "24h", "week", "month"];
      const selectedPeriod = validPeriods.includes(period) ? period : "today";
      return formatCostReport(selectedPeriod);
    },
  });

  context.log?.info?.("costguard: initialized");
}
