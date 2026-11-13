// Package commands is the agent's compiled-in allow-list and the checks every command passes before it runs.
//
// A command runs only if all of these hold:
//  1. its signature verifies with the dashboard's command key pinned at enrolment, over agent, id, op, args and expiry;
//  2. it is addressed to this agent and has not expired;
//  3. its id has not been seen before;
//  4. its op is in the list in ops.go, available on this OS and configured on this machine;
//  5. its args match the op's exact shape (unknown fields are refused);
//  6. the tier the dashboard sent is not lower than this list's tier for the op (a dashboard bug that queued a
//     destructive op as "safe", skipping the admin's confirmation, is refused here).
//
// There is no shell, no script runner and no plugin: adding an op means building a new agent.
package commands

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"edge-agent/internal/client"
	"edge-agent/internal/proto"
)

// Tiers, lowest first, as in modules/edge-agents/ops.ts.
var tierRank = map[string]int{"safe": 1, "destructive": 2}

// Env is what an op may use.
type Env struct {
	Version      string
	WolTargets   map[string]string
	WolBroadcast string
}

// Op is one allowed command.
type Op struct {
	Name string
	Tier string
	// Available reports whether this machine can run the op (OS, configuration).
	Available func(Env) bool
	// Run validates args (already checked to be a JSON object) and does the work.
	Run func(ctx context.Context, env Env, args map[string]any) (any, error)
}

var registry = map[string]Op{}

func register(o Op) { registry[o.Name] = o }

// Ops lists the ops this machine can run, for `status`.
func Ops(env Env) []string {
	var out []string
	for n, o := range registry {
		if o.Available(env) {
			out = append(out, n+" ("+o.Tier+")")
		}
	}
	sort.Strings(out)
	return out
}

// Verifier checks commands for one agent.
type Verifier struct {
	Agent string
	Key   ed25519.PublicKey
	Seen  *Seen
	Now   func() time.Time // server time (local clock + measured skew)
}

// Refusal is a command that failed a check; it is reported to the Worker as failed and never run.
type Refusal struct{ Why string }

func (r *Refusal) Error() string { return "refused: " + r.Why }

func refuse(format string, a ...any) error { return &Refusal{Why: fmt.Sprintf(format, a...)} }

// Check runs checks 1 to 6 and returns the op and its args.
func (v *Verifier) Check(c client.Command, env Env) (Op, map[string]any, error) {
	exp, err := strconv.ParseInt(c.Expires.String(), 10, 64)
	if err != nil {
		return Op{}, nil, refuse("bad expiry")
	}
	msg, err := proto.CommandString(v.Agent, c.ID, c.Op, c.Args, exp)
	if err != nil {
		return Op{}, nil, refuse("args not canonical JSON")
	}
	sig, err := proto.B64.DecodeString(c.Sig)
	if err != nil || len(v.Key) != ed25519.PublicKeySize || !ed25519.Verify(v.Key, []byte(msg), sig) {
		return Op{}, nil, refuse("signature does not verify with the pinned command key")
	}
	if v.Now().UnixMilli() >= exp {
		return Op{}, nil, refuse("expired")
	}
	if !v.Seen.Add(c.ID, exp) {
		return Op{}, nil, refuse("already seen")
	}
	op, ok := registry[c.Op]
	if !ok || !op.Available(env) {
		return Op{}, nil, refuse("op %q is not allowed on this machine", c.Op)
	}
	args, ok := c.Args.(map[string]any)
	if c.Args == nil {
		args, ok = map[string]any{}, true
	}
	if !ok {
		return Op{}, nil, refuse("args must be an object")
	}
	need := op.Tier
	sent, ok := tierRank[c.Tier]
	if !ok || sent < tierRank[need] {
		return Op{}, nil, refuse("op %q is %s here, the dashboard sent it as %q", c.Op, need, c.Tier)
	}
	return op, args, nil
}

// Execute checks, runs and reports one command. It never returns early without reporting, so the Worker's record
// always ends as done or failed.
func (v *Verifier) Execute(ctx context.Context, cl *client.Client, c client.Command, env Env) error {
	op, args, err := v.Check(c, env)
	var out any
	if err == nil {
		rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		out, err = op.Run(rctx, env, args)
		cancel()
	}
	if err != nil {
		return errors.Join(err, cl.Result(ctx, c.ID, false, map[string]any{"error": err.Error()}))
	}
	return cl.Result(ctx, c.ID, true, out)
}

// ---------- argument helpers: exact shapes, nothing extra ----------

func onlyKeys(args map[string]any, allowed ...string) error {
	ok := map[string]bool{}
	for _, a := range allowed {
		ok[a] = true
	}
	for k := range args {
		if !ok[k] {
			return refuse("unknown argument %q", k)
		}
	}
	return nil
}

func intArg(args map[string]any, name string, def, lo, hi int64) (int64, error) {
	v, present := args[name]
	if !present {
		return def, nil
	}
	n, ok := v.(json.Number)
	if !ok {
		return 0, refuse("%s must be a number", name)
	}
	i, err := strconv.ParseInt(n.String(), 10, 64)
	if err != nil || i < lo || i > hi {
		return 0, refuse("%s must be a whole number from %d to %d", name, lo, hi)
	}
	return i, nil
}

func stringArg(args map[string]any, name string) (string, error) {
	s, ok := args[name].(string)
	if !ok || s == "" || len(s) > 64 {
		return "", refuse("%s must be a short string", name)
	}
	return s, nil
}
