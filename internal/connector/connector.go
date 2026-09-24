package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"example.com/a2a-connector/internal/tunnel"
	"github.com/coder/websocket"
)

type Config struct {
	RelayURL      string
	LocalURL      string
	Token         string
	LocalToken    string
	AllowInsecure bool
	MaxDelay      time.Duration
}

type Connector struct {
	config Config
	local  *url.URL
	client *http.Client
}

func New(config Config) (*Connector, error) {
	relay, err := url.Parse(config.RelayURL)
	if err != nil || relay.Host == "" || (relay.Scheme != "wss" && relay.Scheme != "ws") {
		return nil, errors.New("relay must be a WS(S) URL")
	}
	if relay.Scheme != "wss" && !config.AllowInsecure {
		return nil, errors.New("relay requires WSS unless allow-insecure is set")
	}
	local, err := url.Parse(config.LocalURL)
	if err != nil || local.Host == "" || (local.Scheme != "http" && local.Scheme != "https") || local.Path != "" {
		return nil, errors.New("local must be an HTTP(S) origin without a path")
	}
	if config.Token == "" {
		return nil, errors.New("connector token is required")
	}
	if config.MaxDelay <= 0 {
		config.MaxDelay = 30 * time.Second
	}
	return &Connector{config: config, local: local, client: &http.Client{
		Timeout:       60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext},
	}}, nil
}

func (c *Connector) Run(ctx context.Context) error {
	delay := time.Second
	for ctx.Err() == nil {
		if err := c.discover(ctx); err != nil {
			slog.Warn("local Agent Card unavailable", "error", err)
		} else {
			connected, err := c.connect(ctx)
			if err != nil {
				slog.Warn("relay connection ended", "error", err)
			}
			if connected {
				delay = time.Second
			}
		}
		jitter := time.Duration(rand.Int63n(int64(delay / 4)))
		select {
		case <-time.After(delay + jitter):
		case <-ctx.Done():
			return nil
		}
		delay = min(delay*2, c.config.MaxDelay)
	}
	return nil
}

func (c *Connector) discover(ctx context.Context) error {
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.local.String()+"/.well-known/agent-card.json", nil)
	if c.config.LocalToken != "" {
		request.Header.Set("Authorization", "Bearer "+c.config.LocalToken)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Agent Card status %d", response.StatusCode)
	}
	var card struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&card); err != nil {
		return err
	}
	if card.Name == "" {
		return errors.New("Agent Card has no name")
	}
	slog.Info("local Agent Card discovered", "name", card.Name)
	return nil
}

func (c *Connector) connect(ctx context.Context) (bool, error) {
	headers := http.Header{"Authorization": {"Bearer " + c.config.Token}}
	conn, response, err := websocket.Dial(ctx, c.config.RelayURL, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		if response != nil {
			return false, fmt.Errorf("relay status %d: %w", response.StatusCode, err)
		}
		return false, err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(128 << 10)
	writer := &tunnel.Writer{Conn: conn}
	requests := make(map[string]*incoming)
	var workers sync.WaitGroup
	defer workers.Wait()
	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				probe, cancel := context.WithTimeout(pingCtx, 10*time.Second)
				if err := conn.Ping(probe); err != nil {
					conn.CloseNow()
				}
				cancel()
			case <-pingCtx.Done():
				return
			}
		}
	}()
	for {
		frame, err := tunnel.Read(ctx, conn)
		if err != nil {
			return true, err
		}
		switch frame.Type {
		case "request.start":
			if frame.Method != "GET" && frame.Method != "POST" && frame.Method != "PUT" && frame.Method != "DELETE" && frame.Method != "PATCH" {
				continue
			}
			requests[frame.ID] = &incoming{start: frame}
		case "request.body":
			if item := requests[frame.ID]; item != nil {
				if item.body.Len()+len(frame.Body) > tunnel.MaxBody {
					delete(requests, frame.ID)
					workers.Add(1)
					go func(id string) {
						defer workers.Done()
						c.respondError(ctx, writer, id, http.StatusRequestEntityTooLarge)
					}(frame.ID)
				} else {
					item.body.Write(frame.Body)
				}
			}
		case "request.end":
			if item := requests[frame.ID]; item != nil {
				delete(requests, frame.ID)
				workers.Add(1)
				go func(id string, item *incoming) {
					defer workers.Done()
					c.forward(ctx, writer, id, item)
				}(frame.ID, item)
			}
		}
	}
}

type incoming struct {
	start tunnel.Frame
	body  bytes.Buffer
}

func (c *Connector) forward(ctx context.Context, writer *tunnel.Writer, id string, item *incoming) {
	path, err := url.ParseRequestURI(item.start.Path)
	if err != nil || !strings.HasPrefix(item.start.Path, "/") || path.IsAbs() {
		c.respondError(ctx, writer, id, http.StatusBadRequest)
		return
	}
	target := *c.local
	target.Path = path.Path
	target.RawPath = path.RawPath
	target.RawQuery = path.RawQuery
	request, err := http.NewRequestWithContext(ctx, item.start.Method, target.String(), bytes.NewReader(item.body.Bytes()))
	if err != nil {
		c.respondError(ctx, writer, id, http.StatusBadRequest)
		return
	}
	tunnel.CopyHeaders(request.Header, item.start.Headers)
	if c.config.LocalToken != "" {
		request.Header.Set("Authorization", "Bearer "+c.config.LocalToken)
	}
	response, err := c.client.Do(request)
	if err != nil {
		c.respondError(ctx, writer, id, http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, tunnel.MaxBody+1))
	if err != nil || len(body) > tunnel.MaxBody {
		c.respondError(ctx, writer, id, http.StatusBadGateway)
		return
	}
	headers := make(http.Header)
	tunnel.CopyHeaders(headers, response.Header)
	if err := writer.Send(ctx, tunnel.Frame{Type: "response.start", ID: id, Status: response.StatusCode, Headers: headers}); err == nil {
		writer.Body(ctx, "response", id, body)
	}
	slog.Info("local request completed", "requestId", id, "status", response.StatusCode, "bytes", len(body))
}

func (c *Connector) respondError(ctx context.Context, writer *tunnel.Writer, id string, status int) {
	if writer.Send(ctx, tunnel.Frame{Type: "response.start", ID: id, Status: status,
		Headers: http.Header{"Content-Type": {"application/json"}}}) == nil {
		writer.Body(ctx, "response", id, []byte(fmt.Sprintf(`{"error":"local_agent_error","status":%d}`, status)))
	}
}
