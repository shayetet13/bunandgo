// Vendored shim replacing the JSR-only `@evex/loose-types` package.
// Upstream linejs uses this as a deliberately loose escape hatch inside
// the generated thrift struct code (packages/types), not application code,
// so `any` here is intentional rather than a style violation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseType = any;
