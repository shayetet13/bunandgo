package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestBinaryDispatchRoundTrip(t *testing.T) {
	previousClient := sharedClient
	defer func() { sharedClient = previousClient }()

	sharedClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if req.Method != http.MethodPost || req.URL.String() != "https://line.test/CA5" {
			t.Fatalf("unexpected outbound request: %s %s", req.Method, req.URL)
		}
		if req.Header.Get("X-Line-Access") != "token" || string(body) != "payload" {
			t.Fatalf("outbound data was not preserved")
		}
		return &http.Response{
			StatusCode: http.StatusCreated,
			Header:     http.Header{"X-Line-Next-Access": []string{"next"}},
			Body:       io.NopCloser(bytes.NewReader([]byte("answer"))),
		}, nil
	})}

	var wire bytes.Buffer
	wire.Write(requestMagic[:])
	_ = writeString16(&wire, http.MethodPost)
	_ = writeString32(&wire, "https://line.test/CA5")
	writeU16(&wire, 1)
	_ = writeString16(&wire, "x-line-access")
	_ = writeString32(&wire, "token")
	_ = writeBytes32(&wire, []byte("payload"))

	req := httptest.NewRequest(http.MethodPost, "/dispatch-bin", bytes.NewReader(wire.Bytes()))
	recorder := httptest.NewRecorder()
	handleBinaryDispatch(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("relay status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	r := bytes.NewReader(recorder.Body.Bytes())
	magic := make([]byte, 4)
	_, _ = io.ReadFull(r, magic)
	if !bytes.Equal(magic, responseMagic[:]) {
		t.Fatal("bad response magic")
	}
	status, _ := readU16(r)
	if status != http.StatusCreated {
		t.Fatalf("upstream status=%d", status)
	}
	var tookNs uint64
	_ = binary.Read(r, binary.BigEndian, &tookNs)
	var prepNs uint64
	_ = binary.Read(r, binary.BigEndian, &prepNs)
	headerCount, _ := readU16(r)
	if headerCount != 1 {
		t.Fatalf("header count=%d", headerCount)
	}
	key, _ := readString16(r)
	valueCount, _ := readU16(r)
	value, _ := readString32(r)
	if key != "x-line-next-access" || valueCount != 1 || value != "next" {
		t.Fatalf("response headers were not preserved")
	}
	body, _ := readBytes32(r)
	if string(body) != "answer" {
		t.Fatalf("response body=%q", body)
	}
}
