// DEAD-03: this file provides ambient type declarations for the project.
// It does NOT shadow types from src/core/types.ts (different file name, no overlap).
// Currently declares the qrcode-terminal module which has no bundled @types package.

// Type declarations for modules without bundled types

declare module "qrcode-terminal" {
  function generate(qr: string, options?: { small?: boolean }): void;
  export { generate };
  export default { generate };
}
