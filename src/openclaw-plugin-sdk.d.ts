declare module "openclaw/plugin-sdk" {
  export function onDiagnosticEvent(listener: (evt: any) => void): () => void;
}
