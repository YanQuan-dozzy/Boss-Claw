// 声明类型缺失的第三方模块（mammoth 未自带可用的 TS 类型）
declare module 'mammoth' {
  export interface ExtractRawTextResult {
    value: string;
    messages: unknown[];
  }
  export interface InputOptions {
    arrayBuffer?: ArrayBuffer;
    path?: string;
    buffer?: Buffer;
  }
  export function extractRawText(options: InputOptions): Promise<ExtractRawTextResult>;
  export function convertToHtml(options: InputOptions): Promise<{ value: string; messages: unknown[] }>;
}

// mammoth 官方浏览器打包版（UMD）
declare module 'mammoth/mammoth.browser.js' {
  export function extractRawText(options: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
  const _default: { extractRawText: (options: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string; messages: unknown[] }> };
  export default _default;
}
