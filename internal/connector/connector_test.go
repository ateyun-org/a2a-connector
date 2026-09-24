package connector_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/a2a-connector/internal/connector"
	"example.com/a2a-connector/internal/tunnel"
	"github.com/coder/websocket"
)

func TestConnectorDiscoversAndForwards(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer local-secret" {
			t.Errorf("wrong local authorization: %s", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/.well-known/agent-card.json":
			json.NewEncoder(w).Encode(map[string]string{"name": "Local Agent"})
		case "/a2a":
			body, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	defer local.Close()
	result := make(chan string, 1)
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connect" || r.Header.Get("Authorization") != "Bearer agent-secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		writer := &tunnel.Writer{Conn: conn}
		if writer.Send(ctx, tunnel.Frame{Type: "request.start", ID: "one", Method: "POST", Path: "/a2a?test=1",
			Headers: http.Header{"Authorization": {"Bearer dsh-secret"}, "Content-Type": {"application/json"}}}) != nil {
			return
		}
		if writer.Body(ctx, "request", "one", []byte(`{"method":"SendMessage"}`)) != nil {
			return
		}
		var status int
		var body string
		for {
			frame, err := tunnel.Read(ctx, conn)
			if err != nil {
				return
			}
			switch frame.Type {
			case "response.start":
				status = frame.Status
			case "response.body":
				body += string(frame.Body)
			case "response.end":
				if status == http.StatusOK {
					result <- body
				}
				return
			}
		}
	}))
	defer relay.Close()
	client, err := connector.New(connector.Config{RelayURL: "ws" + strings.TrimPrefix(relay.URL, "http") + "/connect",
		LocalURL: local.URL, Token: "agent-secret", LocalToken: "local-secret", AllowInsecure: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go client.Run(ctx)
	select {
	case body := <-result:
		if body != `{"method":"SendMessage"}` {
			t.Fatalf("unexpected response: %s", body)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("connector did not forward request")
	}
}
