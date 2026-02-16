interface PluginApi {
    pluginConfig?: Record<string, any>;
    logger?: {
        info?: (...a: any[]) => void;
        warn?: (...a: any[]) => void;
        error?: (...a: any[]) => void;
    };
    registerService: (service: {
        id: string;
        start: (ctx: any) => Promise<void>;
        stop?: (ctx: any) => Promise<void>;
    }) => void;
    registerCommand: (cmd: {
        name: string;
        description: string;
        acceptsArgs?: boolean;
        requireAuth?: boolean;
        handler: (ctx: any) => any;
    }) => void;
    registerHook: (events: string | string[], handler: (...args: any[]) => any, opts?: {
        name: string;
        description?: string;
    }) => void;
}
declare const plugin: {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
};
export default plugin;
