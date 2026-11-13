package proto_test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"os"
	"testing"

	"edge-agent/internal/client"
	"edge-agent/internal/proto"
)

type vectors struct {
	CommandKey string `json:"command_key"`
	Commands   []struct {
		Agent     string `json:"agent"`
		Wire      string `json:"wire"`
		Canonical string `json:"canonical"`
		String    string `json:"string"`
		Sig       string `json:"sig"`
	} `json:"commands"`
	Fingerprint struct {
		Pubkey      string `json:"pubkey"`
		Fingerprint string `json:"fingerprint"`
	} `json:"fingerprint"`
}

func load(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("../../testdata/worker-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The Worker's own sign.ts made these values; the agent must reproduce them byte for byte.
func TestWorkerCommandVectors(t *testing.T) {
	v := load(t)
	pub, err := proto.B64.DecodeString(v.CommandKey)
	if err != nil || len(pub) != 32 {
		t.Fatalf("command key: %v", err)
	}
	for _, c := range v.Commands {
		var cmd client.Command
		if err := proto.DecodeJSON([]byte(c.Wire), &cmd); err != nil {
			t.Fatal(err)
		}
		cj, err := proto.CanonicalJSON(cmd.Args)
		if err != nil {
			t.Fatal(err)
		}
		if cj != c.Canonical {
			t.Errorf("%s canonical JSON\n got %s\nwant %s", cmd.ID, cj, c.Canonical)
		}
		exp, _ := cmd.Expires.Int64()
		s, err := proto.CommandString(c.Agent, cmd.ID, cmd.Op, cmd.Args, exp)
		if err != nil || s != c.String {
			t.Errorf("%s command string\n got %q\nwant %q", cmd.ID, s, c.String)
		}
		sig, _ := proto.B64.DecodeString(c.Sig)
		if !ed25519.Verify(pub, []byte(s), sig) {
			t.Errorf("%s: Worker signature does not verify", cmd.ID)
		}
	}
}

func TestFingerprint(t *testing.T) {
	v := load(t)
	raw, _ := proto.B64.DecodeString(v.Fingerprint.Pubkey)
	if got := proto.Fingerprint(raw); got != v.Fingerprint.Fingerprint {
		t.Fatalf("got %s want %s", got, v.Fingerprint.Fingerprint)
	}
}

func TestRequestString(t *testing.T) {
	got := proto.RequestString("post", "/api/agents/ingest", "ag_family-laptop", "1794236400000", "nonce", []byte(`{"v":1,"records":[]}`))
	h := sha256.Sum256([]byte(`{"v":1,"records":[]}`))
	want := "agent-v1\nPOST\n/api/agents/ingest\nag_family-laptop\n1794236400000\nnonce\n" + hexs(h[:])
	if got != want {
		t.Fatalf("got %q", got)
	}
	if g := proto.RequestString("GET", "/p", "a", "1", "n", nil); g[len(g)-64:] != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" { // scrub-check: allow (sha256 of nothing)
		t.Fatalf("empty body hash: %q", g)
	}
}

func hexs(b []byte) string {
	const d = "0123456789abcdef"
	out := make([]byte, 0, 2*len(b))
	for _, c := range b {
		out = append(out, d[c>>4], d[c&15])
	}
	return string(out)
}

func TestCanonicalJSONGoValues(t *testing.T) {
	got, err := proto.CanonicalJSON(map[string]any{"b": 1, "a": []any{float64(1.5), int64(2), "x<y"}, "c": nil})
	if err != nil || got != `{"a":[1.5,2,"x<y"],"b":1,"c":null}` {
		t.Fatalf("got %s %v", got, err)
	}
}
