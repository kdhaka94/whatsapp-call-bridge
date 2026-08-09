declare module "qrcode" {
  export function toFile(
    path: string,
    text: string,
    options?: { width?: number; margin?: number; color?: { dark?: string; light?: string } },
  ): Promise<void>;
  export function toDataURL(text: string, options?: { width?: number; margin?: number }): Promise<string>;
  const _default: { toFile: typeof toFile; toDataURL: typeof toDataURL };
  export default _default;
}
