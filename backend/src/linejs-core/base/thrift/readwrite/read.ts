// deno-lint-ignore-file no-explicit-any
// @ts-types="thrift-types"
import * as thrift from "thrift";

import { Buffer } from "node:buffer";
import type { ParsedThrift } from "./declares.ts";

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

function thriftBuffer(data: Uint8Array | Buffer): Buffer {
	return data instanceof Buffer ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * @returns {any}
 */
function readStruct(input: thrift.TCompactProtocol | thrift.TBinaryProtocol): any {
	const Thrift = thrift.Thrift;
	const returnData: Record<PropertyKey, any> = {};
	input.readStructBegin();
	while (true) {
		const { ftype, fid } = input.readFieldBegin();
		if (ftype == Thrift.Type.STOP) {
			break;
		}
		returnData[fid] = readValue(input, ftype);
		input.readFieldEnd();
	}
	input.readStructEnd();
	return returnData;
}

function isBinary(bin: Buffer) {
	try {
		utf8FatalDecoder.decode(bin);
		return false;
	} catch {
		return true;
	}
}

const MIN_SAFE_INTEGER_BIG = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER_BIG = BigInt(Number.MAX_SAFE_INTEGER);

export function bigInt(bin: Buffer): number | bigint {
	const hex = bin.toString("hex");
	// The wire value is the raw 64-bit two's-complement encoding — reading it
	// as a bare unsigned magnitude (the previous `BigInt("0x" + hex)` alone)
	// turned any genuinely negative I64 field into a huge, wrong positive
	// number instead. `asIntN` is the exact inverse of write.ts's
	// `BigInt.asUintN(64, val)` on the encode side.
	const value = BigInt.asIntN(64, BigInt("0x" + hex));
	if (value >= MIN_SAFE_INTEGER_BIG && value <= MAX_SAFE_INTEGER_BIG) {
		return Number(value);
	}
	return value;
}

function readValue(input: thrift.TCompactProtocol | thrift.TBinaryProtocol, ftype: thrift.Thrift.Type): any {
	const Thrift = thrift.Thrift;
	if (ftype == Thrift.Type.STRUCT) {
		return readStruct(input);
	} else if (ftype == Thrift.Type.I32) {
		return input.readI32();
	} else if (ftype == Thrift.Type.I64) {
		return bigInt(input.readI64().buffer);
	} else if (ftype == Thrift.Type.STRING) {
		const bin = input.readBinary();
		if (isBinary(bin)) {
			return bin;
		} else {
			return bin.toString();
		}
	} else if (ftype == Thrift.Type.LIST) {
		const returnData: any[] = [];
		const { size, etype } = input.readListBegin();
		for (let _i = 0; _i < size; ++_i) {
			returnData.push(readValue(input, etype));
		}
		input.readListEnd();
		return returnData;
	} else if (ftype == Thrift.Type.MAP) {
		const returnData: Record<PropertyKey, any> = {};
		const { size, ktype, vtype } = input.readMapBegin();
		for (let _i = 0; _i < size; ++_i) {
			const key = readValue(input, ktype);
			const val = readValue(input, vtype);
			returnData[key] = val;
		}
		input.readMapEnd();
		return returnData;
	} else if (ftype == Thrift.Type.SET) {
		const returnData: any[] = [];
		const { size, etype } = input.readSetBegin();
		for (let _i = 0; _i < size; ++_i) {
			returnData.push(readValue(input, etype));
		}
		input.readSetEnd();
		return returnData;
	} else if (ftype == Thrift.Type.BOOL) {
		return input.readBool();
	} else if (ftype == Thrift.Type.DOUBLE) {
		return input.readDouble();
	} else if (ftype == 16) {
		return input.readString();
	} else if (ftype == 17) {
		return input.readString();
	} else {
		input.skip(ftype);
		return;
	}
}

function _readThrift(
	data: Uint8Array | Buffer,
	Protocol: typeof thrift.TCompactProtocol | typeof thrift.TBinaryProtocol = thrift.TCompactProtocol,
): ParsedThrift {
	const bufTrans = new thrift.TFramedTransport(thriftBuffer(data));
	const proto = new Protocol(bufTrans);
	const msg_info = proto.readMessageBegin();
	const tdata = readStruct(proto);
	proto.readMessageEnd();
	return { data: tdata, _info: msg_info };
}

export function readThrift(
	data: Uint8Array | Buffer,
	Protocol: typeof thrift.TCompactProtocol | typeof thrift.TBinaryProtocol = thrift.TCompactProtocol,
): ParsedThrift {
	return _readThrift(data, Protocol);
}

export function readThriftStruct(
	data: Uint8Array | Buffer,
	Protocol: typeof thrift.TCompactProtocol | typeof thrift.TBinaryProtocol = thrift.TCompactProtocol,
): any {
	const bufTrans = new thrift.TFramedTransport(thriftBuffer(data));
	const proto = new Protocol(bufTrans);
	return readStruct(proto);
}

/**
 * Fast path for callers that only need to know whether a Thrift RPC
 * succeeded. The success payload is skipped without allocating its object
 * tree; errors return false so the normal parser can produce full details.
 */
export function isSuccessfulThriftResponse(
	data: Uint8Array | Buffer,
	Protocol: typeof thrift.TCompactProtocol | typeof thrift.TBinaryProtocol = thrift.TCompactProtocol,
): boolean {
	// Square uses TCompactProtocol. Its reply envelope starts with the
	// standard compact message header followed by result field 0 (success)
	// or field 1 (exception). Reading that first field directly avoids
	// constructing transport/protocol/parser objects for a payload the bot
	// deliberately discards.
	if (Protocol === thrift.TCompactProtocol) {
		try {
			if (data[0] !== 0x82 || data.length < 5) return false;
			let offset = 2;
			const readVarint = (): number => {
				let value = 0;
				let shift = 0;
				for (let i = 0; i < 5; i++) {
					const byte = data[offset++];
					if (byte === undefined) throw new RangeError("compact ACK truncated");
					value |= (byte & 0x7f) << shift;
					if ((byte & 0x80) === 0) return value >>> 0;
					shift += 7;
				}
				throw new RangeError("compact ACK varint too long");
			};
			readVarint(); // sequence id
			const methodLength = readVarint();
			offset += methodLength;
			const fieldHeader = data[offset++];
			if (fieldHeader === undefined || (fieldHeader & 0x0f) !== 0x0c) return false;
			// A delta in the high nibble means field id > 0, i.e. exception.
			if (fieldHeader >>> 4 !== 0) return false;
			// Delta zero is followed by the zig-zag encoded field id. Success is 0.
			return readVarint() === 0;
		} catch {
			return false;
		}
	}
	try {
		const transport = new thrift.TFramedTransport(thriftBuffer(data));
		const proto = new Protocol(transport);
		proto.readMessageBegin();
		proto.readStructBegin();
		let success = false;
		let error = false;
		while (true) {
			const { ftype, fid } = proto.readFieldBegin();
			if (ftype === thrift.Thrift.Type.STOP) break;
			if (fid === 0) success = true;
			else error = true;
			proto.skip(ftype);
			proto.readFieldEnd();
		}
		proto.readStructEnd();
		proto.readMessageEnd();
		return success && !error;
	} catch {
		return false;
	}
}
