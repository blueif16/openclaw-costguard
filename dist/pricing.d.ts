export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
}
export declare function refreshPricing(): Promise<{
    count: number;
    source: string;
}>;
export declare function estimateCost(model: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number): {
    cost: number;
    matchedModel: string | null;
};
export declare function getKnownModels(): string[];
export declare function isPricingLoaded(): boolean;
