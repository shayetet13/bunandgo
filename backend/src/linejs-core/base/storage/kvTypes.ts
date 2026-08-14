/**
 * Known storage's key and value types
 */
export interface KeyValues {
	cert: string;
	qrCert: string;
	/**
	 * Most recent access token, including the rotations LINE hands back via
	 * the `x-line-next-access` response header. Persisting it is what lets a
	 * bot come back online after a restart without a fresh QR scan.
	 */
	authToken: string;
	refreshToken: string;
	expire: number;
	reqseq: Record<string, number>;
	"e2eeKeys:${keyId}": string;
	"e2eePublicKeys:${keyId}": string;
	"e2eeGroupKeys:${chatMid}": string;
}
