// @overnight/bee: the only place in the product that talks to Bee.
export { beeBinaryInPackage, defaultBeeBinary } from "./binary.ts";
export { createBeeGateway, DEFAULT_STREAM_TYPES, DEFAULT_TIMEOUT_MS } from "./gateway.ts";
export type { BeeClientLike, BeeGatewayOptions, DisposableBeeGateway } from "./gateway.ts";
