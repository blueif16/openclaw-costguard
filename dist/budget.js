"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBudget = checkBudget;
const db_js_1 = require("./db.js");
function check(spend, limit, type, warnThreshold) {
    const percent = limit > 0 ? spend / limit : 0;
    if (percent >= 1) {
        return {
            level: "exceeded",
            type,
            currentSpend: spend,
            limit,
            percent,
            message: `${type === "daily" ? "Daily" : "Monthly"} budget exceeded: $${spend.toFixed(2)} / $${limit.toFixed(2)}`,
        };
    }
    if (percent >= warnThreshold) {
        return {
            level: "warning",
            type,
            currentSpend: spend,
            limit,
            percent,
            message: `${type === "daily" ? "Daily" : "Monthly"} budget ${(percent * 100).toFixed(0)}%: $${spend.toFixed(2)} / $${limit.toFixed(2)}`,
        };
    }
    return null;
}
function checkBudget(config) {
    const warnThreshold = config.warnThreshold ?? 0.8;
    if (config.dailyLimitUsd != null) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const daily = (0, db_js_1.getCostSince)(startOfDay.getTime());
        const result = check(daily.totalCost, config.dailyLimitUsd, "daily", warnThreshold);
        if (result)
            return result;
    }
    if (config.monthlyLimitUsd != null) {
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        const monthly = (0, db_js_1.getCostSince)(startOfMonth.getTime());
        const result = check(monthly.totalCost, config.monthlyLimitUsd, "monthly", warnThreshold);
        if (result)
            return result;
    }
    return { level: "ok", currentSpend: 0, limit: 0, percent: 0, message: "" };
}
