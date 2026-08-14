// deno-lint-ignore-file no-explicit-any
import type { ParsedThrift } from "../readwrite/declares.ts";

function isStruct(obj: any): obj is any[] {
	return obj && Array.isArray(obj);
}

export class ThriftRenameParser {
	def: Record<string, Record<string, string> | any[]> = {};

	#fid2name(structName: string, fid: string): any {
		const struct = this.def[structName];
		if (struct && Array.isArray(struct)) {
			const result = struct.findIndex((e: any) => {
				return e.fid == fid;
			});
			if (result === -1) {
				return { name: fid, fid: fid };
			} else {
				return struct[result];
			}
		} else {
			return { name: fid, fid: fid };
		}
	}

	rename_thrift(structName: string, object: any): any {
		const newObject: any = {};
		if (typeof object !== "object") return object;
		for (const fid in object) {
			const value = object[fid];
			const finfo = this.#fid2name(structName, fid);
			if (typeof value === "undefined") {
				continue;
			}
			if (
				finfo.struct && (typeof value === "object" || typeof value === "number")
			) {
				if (isStruct(this.def[finfo.struct])) {
					newObject[finfo.name] = this.rename_thrift(finfo.struct, value);
				} else if (this.def[finfo.struct]) {
					newObject[finfo.name] = (this.def[finfo.struct] as any)[value] ||
						value;
				} else {
					newObject[finfo.name] = value;
				}
			} else if (typeof finfo.list === "string" && typeof value === "object") {
				newObject[finfo.name] = [];
				value.forEach((e: any, i: number) => {
					newObject[finfo.name][i] = this.rename_thrift(finfo.list, e);
				});
			} else if (typeof finfo.map === "string" && typeof value === "object") {
				newObject[finfo.name] = {};
				for (const key in value) {
					const e = value[key];
					newObject[finfo.name][key] = this.rename_thrift(finfo.map, e);
				}
			} else if (typeof finfo.set === "string" && typeof value === "object") {
				newObject[finfo.name] = [];
				value.forEach((e: any, i: number) => {
					newObject[finfo.name][i] = this.rename_thrift(finfo.set, e);
				});
			} else {
				newObject[finfo.name] = value;
			}
		}
		return newObject;
	}

	rename_data(data: ParsedThrift, square?: boolean): ParsedThrift {
		const name = data._info.fname;
		const struct_name = (square ? "SquareService_" : "") + name + "_result";
		data.data = this.rename_thrift(struct_name, data.data);
		return data;
	}
}
