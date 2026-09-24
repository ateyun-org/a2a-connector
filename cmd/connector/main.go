package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"

	"example.com/a2a-connector/internal/connector"
)

func main() {
	relayURL := flag.String("relay", "", "relay WSS /connect URL")
	localURL := flag.String("local", "", "local A2A HTTP origin")
	token := flag.String("token", "", "per-agent connector token (prefer A2A_CONNECTOR_TOKEN env)")
	localToken := flag.String("local-token", "", "local Agent bearer token (prefer A2A_LOCAL_TOKEN env)")
	allowInsecure := flag.Bool("allow-insecure", false, "permit WS relay for local development")
	flag.Parse()
	if *token == "" {
		*token = os.Getenv("A2A_CONNECTOR_TOKEN")
	}
	if *localToken == "" {
		*localToken = os.Getenv("A2A_LOCAL_TOKEN")
	}
	client, err := connector.New(connector.Config{RelayURL: *relayURL, LocalURL: *localURL, Token: *token,
		LocalToken: *localToken, AllowInsecure: *allowInsecure})
	if err != nil {
		slog.Error("invalid config", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := client.Run(ctx); err != nil {
		slog.Error("connector stopped", "error", err)
		os.Exit(1)
	}
}
