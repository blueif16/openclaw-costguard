import type { UsageRecord } from "./db.js";
export interface LoopConfig {
    windowSize: number;
    repeatThreshold: number;
    action: "warn" | "pause";
}
export interface ContextSpikeConfig {
    growthPercent: number;
    absoluteMin: number;
    action: "warn" | "pause";
}
export interface CostVelocityConfig {
    windowMinutes: number;
    multiplier: number;
    action: "warn" | "pause";
}
export interface HeartbeatDriftConfig {
    lookbackRuns: number;
    driftPercent: number;
    action: "warn" | "pause";
}
export interface SentinelConfig {
    loopDetection?: LoopConfig;
    contextSpike?: ContextSpikeConfig;
    costVelocity?: CostVelocityConfig;
    heartbeatDrift?: HeartbeatDriftConfig;
    alertChannel?: string;
}
export interface SentinelAlert {
    detector: string;
    severity: "warn" | "critical";
    sessionKey: string;
    message: string;
    action: "warn" | "pause";
    data: Record<string, any>;
}
export declare function checkAfterEvent(record: UsageRecord, config: SentinelConfig): SentinelAlert[];
export declare function sendAlert(alert: SentinelAlert, channel: string | undefined, ctx: any): void;
