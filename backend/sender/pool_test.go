package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"testing"
)

func TestDoWithGoAwayRetrySucceedsOnSecondAttempt(t *testing.T) {
	previousClient := sharedClient
	defer func() { sharedClient = previousClient }()

	attempts := 0
	sharedClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "payload" {
			t.Fatalf("body not preserved on attempt %d: %q", attempts, body)
		}
		if attempts == 1 {
			return nil, errors.New("http2: server sent GOAWAY and closed the connection; LastStreamID=25, ErrCode=NO_ERROR, debug=\"\"")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(nil))}, nil
	})}

	req, err := http.NewRequest(http.MethodPost, "https://line.test/CA5", bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}

	resp, err := doWithGoAwayRetry(req)
	if err != nil {
		t.Fatalf("expected retry to succeed, got error: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if attempts != 2 {
		t.Fatalf("attempts=%d, want 2 (one failure + one retry)", attempts)
	}
}

func TestDoWithGoAwayRetryDoesNotRetryOtherErrors(t *testing.T) {
	previousClient := sharedClient
	defer func() { sharedClient = previousClient }()

	attempts := 0
	sharedClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		_, _ = io.ReadAll(req.Body)
		return nil, errors.New("connection refused")
	})}

	req, err := http.NewRequest(http.MethodPost, "https://line.test/CA5", bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := doWithGoAwayRetry(req); err == nil {
		t.Fatal("expected error to propagate")
	}
	if attempts != 1 {
		t.Fatalf("attempts=%d, want 1 (non-GOAWAY errors must not retry)", attempts)
	}
}

func TestDoWithGoAwayRetryGivesUpAfterOneRetry(t *testing.T) {
	previousClient := sharedClient
	defer func() { sharedClient = previousClient }()

	attempts := 0
	goAwayErr := errors.New("http2: server sent GOAWAY and closed the connection; LastStreamID=25, ErrCode=NO_ERROR, debug=\"\"")
	sharedClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		_, _ = io.ReadAll(req.Body)
		return nil, goAwayErr
	})}

	req, err := http.NewRequest(http.MethodPost, "https://line.test/CA5", bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := doWithGoAwayRetry(req); err == nil {
		t.Fatal("expected error to propagate after exhausting the single retry")
	}
	if attempts != 2 {
		t.Fatalf("attempts=%d, want 2 (one retry, then give up)", attempts)
	}
}
