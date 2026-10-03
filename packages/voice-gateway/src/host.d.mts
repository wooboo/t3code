export interface VoiceGatewayHandle {
  readonly origin: string;
  readonly closed: boolean;
  readonly close: () => Promise<void>;
}
export function startVoiceGateway(options: {
  workerUrl?: URL | undefined;
  getToken: () => Promise<string>;
  dataDirectory: string;
  templateDirectory: string;
  origin: string;
  configFile?: string | undefined;
  port?: number | undefined;
  publicBasePath?: string | undefined;
  publicOrigin?: string | undefined;
}): Promise<VoiceGatewayHandle>;
