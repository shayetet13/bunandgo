package main

import (
	"crypto/tls"
	"net"
	"net/http"
	"strings"
	"time"
)

// sharedClient is a single package-level *http.Client reused across every
// /dispatch call. Its Transport keeps warm, pooled connections per host so
// repeat sends to the same LINE endpoint skip DNS/TCP/TLS/HTTP-2 setup.
// No per-call Timeout here: LINE's own long-poll RPCs (QR-scan check,
// talk sync) legitimately hold a connection open for up to ~180s, and the
// real deadline is the caller's AbortSignal.timeout(...), which arrives
// as this request's context (see dispatch_handler.go) and cancels the
// outbound call the moment the Bun side gives up. This value is only a
// backstop against a runaway connection with no caller-supplied deadline.
const requestBackstop = 200 * time.Second

// A cold connection to LINE costs a full TCP+TLS handshake: measured
// +117ms to legy.line-apps.com and +236ms to gf.line.naver.jp — several
// times the warm round trip itself. For a race-to-answer bot that sits
// idle waiting for one message, that handshake is the single largest
// avoidable cost, so idle conns are held far longer than Go's 90s default
// and the Bun side re-warms them on an interval (see dispatch/warmer.ts).
const idleConnTimeout = 300 * time.Second

var sharedClient = &http.Client{
	Timeout: requestBackstop,
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 50,
		MaxConnsPerHost:     0,
		IdleConnTimeout:     idleConnTimeout,
		TLSHandshakeTimeout: 10 * time.Second,
		// Go's crypto/tls does not cache or resume TLS sessions unless a
		// ClientSessionCache is configured explicitly — without this every
		// reconnect (GOAWAY, idle eviction, fresh boot) pays the full cold
		// handshake this package's own comment above measures at +117ms to
		// +236ms, instead of a cheaper abbreviated one. A handful of LINE
		// hosts share this client, so 64 entries is generous headroom.
		TLSClientConfig: &tls.Config{
			ClientSessionCache: tls.NewLRUClientSessionCache(64),
		},
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    false,
	},
}

// doWithGoAwayRetry sends req and, if the pooled HTTP/2 connection dies from
// a server-initiated GOAWAY, retries exactly once on a fresh connection.
//
// LINE's servers routinely GOAWAY idle pooled connections as ordinary
// housekeeping (see idleConnTimeout above), and a request can race one
// arriving just as it's dispatched. Go's own http2 transport does not
// auto-retry this case: its retry allowlist (shouldRetryRequest/
// canRetryError in golang.org/x/net/http2) only covers errClientConnUnusable
// and ErrCodeRefusedStream, not GoAwayError, so without this wrapper the
// caller sees a hard transport error on a connection LINE closed for
// completely routine reasons. The stdlib vendors http2 as an unexported
// internal package, so the error type isn't available to check with
// errors.As; matching on the message is the only option, but it's this
// package's own already-well-known message format ("http2: server sent
// GOAWAY and closed the connection"), not third-party API surface that can
// silently change shape.
//
// The retry is safe because every caller here builds req with
// bytes.NewReader, which makes http.NewRequestWithContext set req.GetBody
// automatically — rewinding the body costs nothing and loses no data.
func doWithGoAwayRetry(req *http.Request) (*http.Response, error) {
	resp, err := sharedClient.Do(req)
	if err == nil || req.GetBody == nil || !strings.Contains(err.Error(), "GOAWAY") {
		return resp, err
	}
	body, bodyErr := req.GetBody()
	if bodyErr != nil {
		return resp, err
	}
	retryReq := req.Clone(req.Context())
	retryReq.Body = body
	return sharedClient.Do(retryReq)
}
