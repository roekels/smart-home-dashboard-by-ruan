// Package client talks to the dashboard Worker's agent API (PROTOCOL.md). Every request except enrolment is
// signed; when an Access service token is configured it is sent too, so Cloudflare Access lets the request through.
package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"edge-agent/internal/keys"
	"edge-agent/internal/proto"
)

// Access is a Cloudflare Access service token (CF-Access-Client-Id / -Secret).
type Access struct {
	ID     string `json:"id"`
	Secret string `json:"secret"`
}

// Client is one agent's connection to the Worker.
type Client struct {
	Server    string // https://home.example.com
	Agent     string
	Key       keys.Signer
	Access    *Access
	UserAgent string
	HTTP      *http.Client

	skewMs atomic.Int64 // server time minus local time, from X-Server-Ts
}

// New returns a client with TLS 1.2+ (Cloudflare negotiates 1.3), the system trust store and short timeouts.
func New(server, agent string, key keys.Signer, access *Access, version string) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	tr.Proxy = http.ProxyFromEnvironment
	return &Client{
		Server: server, Agent: agent, Key: key, Access: access,
		UserAgent: "edge-agent/" + version,
		HTTP: &http.Client{Timeout: 30 * time.Second, Transport: tr,
			// never follow a redirect with signed headers to somewhere else
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

// HTTPError is a non-2xx reply.
type HTTPError struct {
	Status int
	Body   string
}

// StatusCode lets other packages check the HTTP status without importing this one.
func (e *HTTPError) StatusCode() int { return e.Status }

func (e *HTTPError) Error() string { return fmt.Sprintf("server said %d: %s", e.Status, e.Body) }

// IsAuth reports whether err is a 401/403: unknown, pending (not approved yet) or revoked agent, or a bad signature.
func IsAuth(err error) bool {
	var h *HTTPError
	return errors.As(err, &h) && (h.Status == 401 || h.Status == 403)
}

// Skew is the measured server-minus-local clock difference.
func (c *Client) Skew() time.Duration { return time.Duration(c.skewMs.Load()) * time.Millisecond }

func (c *Client) do(ctx context.Context, method, path string, body []byte, sign bool, out any) error {
	raw, err := c.send(ctx, c.HTTP, method, path, body, sign, 1<<20)
	if err != nil || out == nil {
		return err
	}
	return proto.DecodeJSON(raw, out)
}

func (c *Client) send(ctx context.Context, hc *http.Client, method, path string, body []byte, sign bool, limit int64) ([]byte, error) {
	u, err := url.Parse(c.Server + path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.UserAgent)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Access != nil && c.Access.ID != "" {
		req.Header.Set("CF-Access-Client-Id", c.Access.ID)
		req.Header.Set("CF-Access-Client-Secret", c.Access.Secret)
	}
	if sign {
		ts := strconv.FormatInt(time.Now().UnixMilli()+c.skewMs.Load(), 10)
		n := make([]byte, 18)
		if _, err := rand.Read(n); err != nil {
			return nil, err
		}
		nonce := proto.B64.EncodeToString(n)
		msg := proto.RequestString(method, u.EscapedPath(), c.Agent, ts, nonce, body)
		sig, err := c.Key.Sign([]byte(msg))
		if err != nil {
			return nil, fmt.Errorf("sign: %w", err)
		}
		req.Header.Set("X-Agent-Id", c.Agent)
		req.Header.Set("X-Agent-Ts", ts)
		req.Header.Set("X-Agent-Nonce", nonce)
		req.Header.Set("X-Agent-Sig", proto.B64.EncodeToString(sig))
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if st := res.Header.Get("X-Server-Ts"); st != "" {
		if ms, err := strconv.ParseInt(st, 10, 64); err == nil {
			c.skewMs.Store(ms - time.Now().UnixMilli())
		}
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 && res.StatusCode < 400 && strings.Contains(res.Header.Get("Location"), "cloudflareaccess.com") {
		return nil, &HTTPError{Status: 403, Body: "Cloudflare Access sent this request to its login page: the service token is missing or not accepted " +
			"(the agent API's Access policy must use the action Service Auth and include this machine's token)"}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		msg := string(raw)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &HTTPError{Status: res.StatusCode, Body: msg}
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("reply larger than %d bytes", limit)
	}
	return raw, nil
}

// EnrolReply is the Worker's answer to enrolment.
type EnrolReply struct {
	Status      string `json:"status"` // "pending"
	Fingerprint string `json:"fingerprint"`
	CommandKey  struct {
		Alg string `json:"alg"`
		X   string `json:"x"`
	} `json:"command_key"`
}

// Enrol posts the public key with the one-time code. Not signed: the code is the credential.
func (c *Client) Enrol(ctx context.Context, code string) (*EnrolReply, error) {
	body, _ := json.Marshal(map[string]string{
		"agent": c.Agent, "code": code, "pubkey": proto.B64.EncodeToString(c.Key.PublicRaw()),
	})
	var r EnrolReply
	if err := c.do(ctx, "POST", "/api/agents/enrol", body, false, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Record is one entry of an ingest batch.
type Record struct {
	Kind string         `json:"kind"`
	TS   int64          `json:"ts"` // Unix ms
	Data map[string]any `json:"data"`
}

// IngestReply says how many records were stored and how many commands wait.
type IngestReply struct {
	OK       bool        `json:"ok"`
	Accepted json.Number `json:"accepted"`
	Commands json.Number `json:"commands"`
	// Refused lists kinds the dashboard dropped because agents may not store them.
	Refused []string `json:"refused,omitempty"`
}

// Ingest sends one batch.
func (c *Client) Ingest(ctx context.Context, recs []Record) (*IngestReply, error) {
	body, err := json.Marshal(map[string]any{"v": 1, "records": recs})
	if err != nil {
		return nil, err
	}
	var r IngestReply
	if err := c.do(ctx, "POST", "/api/agents/ingest", body, true, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// Command is one queued command as the Worker hands it out.
type Command struct {
	ID      string      `json:"id"`
	Op      string      `json:"op"`
	Args    any         `json:"args"`
	Tier    string      `json:"tier"`
	Expires json.Number `json:"expires"`
	Sig     string      `json:"sig"`
}

// Commands fetches this agent's queued commands (each is handed out once).
func (c *Client) Commands(ctx context.Context) ([]Command, error) {
	var r struct {
		Commands []Command `json:"commands"`
	}
	if err := c.do(ctx, "GET", "/api/agents/commands", nil, true, &r); err != nil {
		return nil, err
	}
	return r.Commands, nil
}

// Result reports the outcome of one command, once.
func (c *Client) Result(ctx context.Context, id string, ok bool, output any) error {
	body, err := json.Marshal(map[string]any{"ok": ok, "output": output})
	if err != nil {
		return err
	}
	return c.do(ctx, "POST", "/api/agents/commands/"+url.PathEscape(id)+"/result", body, true, nil)
}
