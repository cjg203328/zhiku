declare module "opencc-js" {
  export function Converter(options: { from: string; to: string }): (input: string) => string;
}

declare module "opencc-js/t2cn" {
  export function Converter(options: { from: string; to: string }): (input: string) => string;
}

declare module "opencc-js/cn2t" {
  export function Converter(options: { from: string; to: string }): (input: string) => string;
}
