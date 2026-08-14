package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type warmRequest struct {
	Hosts []string `json:"hosts"`
}

type warmHostResult struct {
	Host   string `json:"host"`
	TookMs int64  `json:"tookMs"`
	Status int    `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}

type warmResponse struct {
	Results []warmHostResult `json:"results"`
}

// warmTimeout is deliberately short: a warm-up that takes longer than this
// is not warming anything useful, and the next tick will try again anyway.
const warmTimeout = 8 * time.Second

// handleWarm forces sharedClient to hold a live pooled connection to each
// named host. Go owns the connection pool, so the warm-up has to originate
// here — a keep-alive fired from the Bun side would only warm Bun's pool
// and leave the leg that actually reaches LINE cold.
//
// A bare HEAD to the host root is enough: the pool is keyed by host, and
// Go only retains a connection as idle-reusable after a completed HTTP
// exchange, so the response status is irrelevant (a 400/404 warms the
// connection exactly as well as a 200). No LINE API is called and no
// credentials are involved.
func handleWarm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var reqBody warmRequest
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(reqBody.Hosts) == 0 {
		http.Error(w, "hosts is required", http.StatusBadRequest)
		return
	}

	results := make([]warmHostResult, len(reqBody.Hosts))
	var wg sync.WaitGroup
	for i, host := range reqBody.Hosts {
		wg.Add(1)
		go func(idx int, host string) {
			defer wg.Done()
			results[idx] = warmHost(r.Context(), host)
		}(i, host)
	}
	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(warmResponse{Results: results})
}

func warmHost(parent context.Context, host string) warmHostResult {
	ctx, cancel := context.WithTimeout(parent, warmTimeout)
	defer cancel()

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, "https://"+host+"/", nil)
	if err != nil {
		return warmHostResult{Host: host, Error: err.Error()}
	}

	resp, err := sharedClient.Do(req)
	tookMs := time.Since(start).Milliseconds()
	if err != nil {
		return warmHostResult{Host: host, TookMs: tookMs, Error: err.Error()}
	}
	// Draining and closing is what returns the connection to the idle pool —
	// an unread body would leak the connection instead of warming it.
	_ = resp.Body.Close()

	return warmHostResult{Host: host, TookMs: tookMs, Status: resp.StatusCode}
}
