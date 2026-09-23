package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

type dispatchRequest struct {
	Method     string              `json:"method"`
	URL        string              `json:"url"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"bodyBase64"`
}

type dispatchResponse struct {
	Status     int                 `json:"status"`
	Headers    map[string][]string `json:"headers"`
	BodyBase64 string              `json:"bodyBase64"`
	TookNs     int64               `json:"tookNs"`
	Error      string              `json:"error,omitempty"`
}

// handleDispatch has zero LINE-protocol knowledge: it replays a fully
// pre-built request (already thrift-encoded / LEGY-encrypted / E2EE'd by
// the TypeScript side) over the shared pooled transport and hands back
// the raw response bytes untouched, timing only the network round trip.
func handleDispatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var reqBody dispatchRequest
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		writeJSON(w, http.StatusBadRequest, dispatchResponse{Error: "invalid json: " + err.Error()})
		return
	}
	if reqBody.Method == "" || reqBody.URL == "" {
		writeJSON(w, http.StatusBadRequest, dispatchResponse{Error: "method and url are required"})
		return
	}

	bodyBytes, err := base64.StdEncoding.DecodeString(reqBody.BodyBase64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, dispatchResponse{Error: "invalid bodyBase64: " + err.Error()})
		return
	}

	outReq, err := http.NewRequestWithContext(r.Context(), reqBody.Method, reqBody.URL, bytes.NewReader(bodyBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, dispatchResponse{Error: "invalid outbound request: " + err.Error()})
		return
	}
	for key, values := range reqBody.Headers {
		for _, v := range values {
			outReq.Header.Add(key, v)
		}
	}

	start := time.Now()
	resp, err := doWithGoAwayRetry(outReq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, dispatchResponse{Error: err.Error(), TookNs: time.Since(start).Nanoseconds()})
		return
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, dispatchResponse{Error: "reading upstream response: " + err.Error(), TookNs: time.Since(start).Nanoseconds()})
		return
	}
	// Include body delivery in upstream time. Stopping at response headers
	// misattributes delayed LINE body bytes to our Bun/Go processing time.
	tookNs := time.Since(start).Nanoseconds()

	respHeaders := make(map[string][]string, len(resp.Header))
	for k, v := range resp.Header {
		respHeaders[k] = v
	}

	writeJSON(w, http.StatusOK, dispatchResponse{
		Status:     resp.StatusCode,
		Headers:    respHeaders,
		BodyBase64: base64.StdEncoding.EncodeToString(respBytes),
		TookNs:     tookNs,
	})
}

func writeJSON(w http.ResponseWriter, status int, body dispatchResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
