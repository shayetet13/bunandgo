package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

var requestMagic = [4]byte{'L', 'D', 'B', '1'}
var responseMagic = [4]byte{'L', 'D', 'R', '1'}

const maxBinaryDispatchBody = 16 << 20

type binaryDispatchRequest struct {
	Method  string
	URL     string
	Headers map[string][]string
	Body    []byte
}

func handleBinaryDispatch(w http.ResponseWriter, r *http.Request) {
	handlerStart := time.Now()
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBinaryDispatchBody)
	wire, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "reading binary request: "+err.Error(), http.StatusBadRequest)
		return
	}
	reqBody, err := decodeBinaryDispatchRequest(wire)
	if err != nil {
		http.Error(w, "invalid binary dispatch: "+err.Error(), http.StatusBadRequest)
		return
	}

	outReq, err := http.NewRequestWithContext(
		r.Context(),
		reqBody.Method,
		reqBody.URL,
		bytes.NewReader(reqBody.Body),
	)
	if err != nil {
		http.Error(w, "invalid outbound request: "+err.Error(), http.StatusBadRequest)
		return
	}
	for key, values := range reqBody.Headers {
		for _, value := range values {
			outReq.Header.Add(key, value)
		}
	}

	prepNs := time.Since(handlerStart).Nanoseconds()
	start := time.Now()
	resp, err := doWithGoAwayRetry(outReq)
	if err != nil {
		http.Error(w, "upstream: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "reading upstream response: "+err.Error(), http.StatusBadGateway)
		return
	}
	// Include body delivery in upstream time. Stopping at response headers
	// misattributes delayed LINE body bytes to our Bun/Go processing time.
	tookNs := time.Since(start).Nanoseconds()

	wireResponse, err := encodeBinaryDispatchResponse(resp.StatusCode, tookNs, prepNs, resp.Header, respBody)
	if err != nil {
		http.Error(w, "encoding binary response: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", intString(len(wireResponse)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(wireResponse)
}

func decodeBinaryDispatchRequest(data []byte) (binaryDispatchRequest, error) {
	r := bufio.NewReader(bytes.NewReader(data))
	magic := make([]byte, len(requestMagic))
	if _, err := io.ReadFull(r, magic); err != nil || !bytes.Equal(magic, requestMagic[:]) {
		return binaryDispatchRequest{}, errors.New("bad magic")
	}
	method, err := readString16(r)
	if err != nil {
		return binaryDispatchRequest{}, err
	}
	url, err := readString32(r)
	if err != nil {
		return binaryDispatchRequest{}, err
	}
	headerCount, err := readU16(r)
	if err != nil {
		return binaryDispatchRequest{}, err
	}
	headers := make(map[string][]string, int(headerCount))
	for i := 0; i < int(headerCount); i++ {
		key, err := readString16(r)
		if err != nil {
			return binaryDispatchRequest{}, err
		}
		value, err := readString32(r)
		if err != nil {
			return binaryDispatchRequest{}, err
		}
		headers[key] = append(headers[key], value)
	}
	body, err := readBytes32(r)
	if err != nil {
		return binaryDispatchRequest{}, err
	}
	if _, err := r.ReadByte(); err != io.EOF {
		return binaryDispatchRequest{}, errors.New("trailing data")
	}
	return binaryDispatchRequest{Method: method, URL: url, Headers: headers, Body: body}, nil
}

func encodeBinaryDispatchResponse(
	status int,
	tookNs int64,
	prepNs int64,
	headers http.Header,
	body []byte,
) ([]byte, error) {
	if status < 0 || status > 0xffff || tookNs < 0 || prepNs < 0 || len(headers) > 0xffff {
		return nil, errors.New("response field out of range")
	}
	var out bytes.Buffer
	out.Write(responseMagic[:])
	writeU16(&out, uint16(status))
	_ = binary.Write(&out, binary.BigEndian, uint64(tookNs))
	_ = binary.Write(&out, binary.BigEndian, uint64(prepNs))
	writeU16(&out, uint16(len(headers)))
	for key, values := range headers {
		if err := writeString16(&out, strings.ToLower(key)); err != nil {
			return nil, err
		}
		if len(values) > 0xffff {
			return nil, errors.New("too many header values")
		}
		writeU16(&out, uint16(len(values)))
		for _, value := range values {
			if err := writeString32(&out, value); err != nil {
				return nil, err
			}
		}
	}
	if err := writeBytes32(&out, body); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func readU16(r io.Reader) (uint16, error) {
	var value uint16
	err := binary.Read(r, binary.BigEndian, &value)
	return value, err
}

func readU32(r io.Reader) (uint32, error) {
	var value uint32
	err := binary.Read(r, binary.BigEndian, &value)
	return value, err
}

func readString16(r io.Reader) (string, error) {
	length, err := readU16(r)
	if err != nil {
		return "", err
	}
	data := make([]byte, int(length))
	_, err = io.ReadFull(r, data)
	return string(data), err
}

func readString32(r io.Reader) (string, error) {
	data, err := readBytes32(r)
	return string(data), err
}

func readBytes32(r io.Reader) ([]byte, error) {
	length, err := readU32(r)
	if err != nil {
		return nil, err
	}
	if length > maxBinaryDispatchBody {
		return nil, errors.New("field too large")
	}
	data := make([]byte, int(length))
	_, err = io.ReadFull(r, data)
	return data, err
}

func writeU16(w io.Writer, value uint16) {
	_ = binary.Write(w, binary.BigEndian, value)
}

func writeString16(w io.Writer, value string) error {
	if len(value) > 0xffff {
		return errors.New("string too large")
	}
	writeU16(w, uint16(len(value)))
	_, err := io.WriteString(w, value)
	return err
}

func writeString32(w io.Writer, value string) error {
	return writeBytes32(w, []byte(value))
}

func writeBytes32(w io.Writer, value []byte) error {
	if uint64(len(value)) > uint64(^uint32(0)) {
		return errors.New("byte field too large")
	}
	_ = binary.Write(w, binary.BigEndian, uint32(len(value)))
	_, err := w.Write(value)
	return err
}

func intString(value int) string {
	if value == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for value > 0 {
		i--
		buf[i] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[i:])
}
