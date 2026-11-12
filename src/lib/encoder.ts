/** Names of the GPU video encoders the backend can report. */
export const ENCODER_NAME = { nvenc: "NVENC", amf: "AMD AMF", qsv: "Intel Quick Sync" } as const;
export type Encoder = keyof typeof ENCODER_NAME;
