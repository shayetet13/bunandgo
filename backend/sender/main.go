package main

import (
	"log"
	"net/http"
	"os"
)

// requireToken guards /dispatch so that other local processes on the same
// machine can't silently use this loopback relay as an open HTTP proxy —
// it forwards whatever request bytes it's handed, so only the Bun backend
// (which shares this token via env) should be able to reach it.
func requireToken(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Dispatch-Token") != token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func main() {
	token := os.Getenv("DISPATCH_TOKEN")
	if token == "" {
		log.Fatal("DISPATCH_TOKEN env var is required (shared secret with the Bun backend)")
	}

	addr := os.Getenv("DISPATCH_ADDR")
	if addr == "" {
		addr = "127.0.0.1:4790"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/dispatch", requireToken(token, handleDispatch))
	mux.HandleFunc("/dispatch-bin", requireToken(token, handleBinaryDispatch))
	mux.HandleFunc("/warm", requireToken(token, handleWarm))

	log.Printf("sender: listening on %s (loopback dispatch relay, no LINE-protocol knowledge)", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
