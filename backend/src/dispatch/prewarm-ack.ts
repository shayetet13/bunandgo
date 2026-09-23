/**
 * The in-RAM responses the prewarm transport answers with while the outbound
 * send path is compiled against the exact encoder it will use for real.
 *
 * These live here, once, because three copies previously drifted: the two on
 * the transport side lost the trailing struct/message stop bytes that the
 * reference copy in `SquareService.prewarmSendMessage` kept. A short ACK still
 * satisfies `isSuccessfulResponse`, so `fastAck` callers never noticed, while
 * every full-parse caller on `/SQ1` — the poller's `fetchSquareChatEvents`,
 * and `sendMessage` without `fastAck` — hit `InputBufferUnderrunError`.
 */

/** Compact Talk replies are a length-prefixed success byte, not Thrift. */
export const PREWARM_TALK_ACK = Uint8Array.of(1);

/**
 * `sendMessage` reply envelope: version+type, method name, an empty success
 * struct at field 0, then the struct stop and the message stop. Truncating
 * either stop byte makes this unparseable.
 */
export const PREWARM_SQUARE_ACK = Uint8Array.from([
	0x82, 0x21, 0x00, 0x0b, 0x73, 0x65, 0x6e, 0x64, 0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x0c, 0x00, 0x00, 0x00,
]);
