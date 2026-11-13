package commands

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"edge-agent/internal/client"
	"edge-agent/internal/proto"
)

type signer struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

func newSigner(t *testing.T) signer {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{priv, pub}
}

// cmd builds a command the way the Worker sends it (args through JSON, numbers as json.Number).
func (s signer) cmd(t *testing.T, agent, id, op, tier, argsJSON string, expires int64) client.Command {
	var args any
	if err := proto.DecodeJSON([]byte(argsJSON), &args); err != nil {
		t.Fatal(err)
	}
	msg, err := proto.CommandString(agent, id, op, args, expires)
	if err != nil {
		t.Fatal(err)
	}
	return client.Command{ID: id, Op: op, Args: args, Tier: tier, Expires: json.Number(itoa(expires)),
		Sig: proto.B64.EncodeToString(ed25519.Sign(s.priv, []byte(msg)))}
}

func itoa(i int64) string { b, _ := json.Marshal(i); return string(b) }

func verifier(s signer) *Verifier {
	return &Verifier{Agent: "ag_gaming-pc", Key: s.pub, Seen: OpenSeen(""), Now: time.Now}
}

func refusedWith(t *testing.T, err error, want string) {
	t.Helper()
	var r *Refusal
	if !errors.As(err, &r) || !strings.Contains(r.Why, want) {
		t.Fatalf("want refusal %q, got %v", want, err)
	}
}

func TestCheck(t *testing.T) {
	s := newSigner(t)
	exp := time.Now().Add(time.Minute).UnixMilli()
	env := Env{Version: "test", WolTargets: map[string]string{"gaming-pc": "02:00:00:00:00:A1"}} // scrub-check: allow (made-up test address)

	v := verifier(s)
	op, args, err := v.Check(s.cmd(t, "ag_gaming-pc", "cmd_1", "agent.ping", "safe", `{}`, exp), env)
	if err != nil || op.Name != "agent.ping" || len(args) != 0 {
		t.Fatalf("valid ping refused: %v", err)
	}
	_, _, err = v.Check(s.cmd(t, "ag_gaming-pc", "cmd_1", "agent.ping", "safe", `{}`, exp), env)
	refusedWith(t, err, "already seen")

	// signed for another agent
	_, _, err = verifier(s).Check(s.cmd(t, "ag_other", "cmd_2", "agent.ping", "safe", `{}`, exp), env)
	refusedWith(t, err, "signature")

	// signed by another key
	_, _, err = verifier(s).Check(newSigner(t).cmd(t, "ag_gaming-pc", "cmd_3", "agent.ping", "safe", `{}`, exp), env)
	refusedWith(t, err, "signature")

	// args changed after signing
	c := s.cmd(t, "ag_gaming-pc", "cmd_4", "pc.wake", "safe", `{"target":"gaming-pc"}`, exp)
	c.Args = map[string]any{"target": "other"}
	_, _, err = verifier(s).Check(c, env)
	refusedWith(t, err, "signature")

	// expired
	_, _, err = verifier(s).Check(s.cmd(t, "ag_gaming-pc", "cmd_5", "agent.ping", "safe", `{}`, time.Now().Add(-time.Second).UnixMilli()), env)
	refusedWith(t, err, "expired")

	// not in the allow-list
	_, _, err = verifier(s).Check(s.cmd(t, "ag_gaming-pc", "cmd_6", "shell.run", "safe", `{"cmd":"calc"}`, exp), env)
	refusedWith(t, err, "not allowed")

	// pc.wake only where targets are configured
	_, _, err = verifier(s).Check(s.cmd(t, "ag_gaming-pc", "cmd_7", "pc.wake", "safe", `{"target":"gaming-pc"}`, exp), Env{})
	refusedWith(t, err, "not allowed")

	// a destructive op sent as "safe" (skipping the admin's confirmation) is refused
	ops := registry["pc.shutdown"]
	registry["test.destructive"] = Op{Name: "test.destructive", Tier: "destructive", Available: func(Env) bool { return true }, Run: ops.Run}
	defer delete(registry, "test.destructive")
	_, _, err = verifier(s).Check(s.cmd(t, "ag_gaming-pc", "cmd_8", "test.destructive", "safe", `{}`, exp), env)
	refusedWith(t, err, "destructive here")
	if _, _, err = verifier(s).Check(s.cmd(t, "ag_gaming-pc", "cmd_9", "test.destructive", "destructive", `{}`, exp), env); err != nil {
		t.Fatalf("confirmed destructive refused: %v", err)
	}
}

func TestArgs(t *testing.T) {
	ctx := context.Background()
	env := Env{WolTargets: map[string]string{"gaming-pc": "02:00:00:00:00:A1"}} // scrub-check: allow (made-up test address)
	if _, err := registry["agent.ping"].Run(ctx, env, map[string]any{"x": 1}); err == nil {
		t.Fatal("ping took an unknown argument")
	}
	if _, err := registry["pc.wake"].Run(ctx, env, map[string]any{"target": "fridge"}); err == nil {
		t.Fatal("woke an unknown target")
	}
	if _, err := registry["pc.wake"].Run(ctx, env, map[string]any{"target": "gaming-pc", "mac": "00:11:22:33:44:55"}); err == nil { // scrub-check: allow (made-up test address)
		t.Fatal("accepted a MAC from the Worker")
	}
	for _, bad := range []string{`{"delay_s":5}`, `{"delay_s":301}`, `{"delay_s":1.5}`, `{"delay_s":"10"}`, `{"force":true}`} {
		var a map[string]any
		_ = proto.DecodeJSON([]byte(bad), &a)
		// only invalid arguments are tried: they must be refused before anything runs, on every OS
		var r *Refusal
		if _, err := registry["pc.shutdown"].Run(ctx, env, a); !errors.As(err, &r) {
			t.Fatalf("pc.shutdown %s: want refusal, got %v", bad, err)
		}
	}
}

func TestMagicPacket(t *testing.T) {
	p, err := MagicPacket("02-00-00-00-00-A1")
	if err != nil || len(p) != 102 || p[0] != 0xff || p[6] != 0x02 || p[101] != 0xa1 {
		t.Fatalf("%v % x", err, p[:12])
	}
	if _, err := MagicPacket("not a mac"); err == nil {
		t.Fatal("accepted junk")
	}
}
