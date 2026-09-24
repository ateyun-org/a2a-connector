package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

const (
	MaxBody   = 16 << 20
	ChunkSize = 32 << 10
)

type Frame struct {
	Type    string      `json:"type"`
	ID      string      `json:"requestId"`
	Method  string      `json:"method,omitempty"`
	Path    string      `json:"path,omitempty"`
	Headers http.Header `json:"headers,omitempty"`
	Status  int         `json:"status,omitempty"`
	Body    []byte      `json:"body,omitempty"`
}

type Writer struct {
	Conn *websocket.Conn
	Mu   sync.Mutex
}

func (w *Writer) Send(ctx context.Context, f Frame) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	w.Mu.Lock()
	defer w.Mu.Unlock()
	return w.Conn.Write(ctx, websocket.MessageText, data)
}

func (w *Writer) Body(ctx context.Context, kind, id string, body []byte) error {
	for len(body) > 0 {
		n := min(len(body), ChunkSize)
		if err := w.Send(ctx, Frame{Type: kind + ".body", ID: id, Body: body[:n]}); err != nil {
			return err
		}
		body = body[n:]
	}
	return w.Send(ctx, Frame{Type: kind + ".end", ID: id})
}

func Read(ctx context.Context, conn *websocket.Conn) (Frame, error) {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return Frame{}, err
	}
	var frame Frame
	if err := json.Unmarshal(data, &frame); err != nil {
		return Frame{}, err
	}
	if frame.ID == "" || frame.Type == "" {
		return Frame{}, errors.New("invalid tunnel frame")
	}
	return frame, nil
}

func CopyHeaders(dst, src http.Header) {
	for key, values := range src {
		switch http.CanonicalHeaderKey(key) {
		case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade", "Host", "Content-Length", "Authorization":
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
