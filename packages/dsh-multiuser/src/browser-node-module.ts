/** Match upstream web boot: the browser loader never enters Node internals. */
export const createRequire = (): never => {
  throw new Error("node:module is not available in the browser");
};
