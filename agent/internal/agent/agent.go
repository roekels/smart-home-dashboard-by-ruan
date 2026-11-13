// Package agent is the main loop: sample every interval, keep samples in the spool, send them in batches, and
// fetch and run commands. Everything is outbound: nothing on this machine listens.
package agent

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"edge-agent/internal/client"
	"edge-agent/internal/collect"
	"edge-agent/internal/commands"
	"edge-agent/internal/keys"
	"edge-agent/internal/proto"
	"edge-agent/internal/secret"
	"edge-agent/internal/spool"
	"edge-agent/internal/state"
)

// Agent holds everything the loop needs.
type Agent struct {
	State   *state.State
	Key     keys.Signer
	Client  *client.Client
	Spool   *spool.Spool
	Collect collect.Collector
	Verify  *commands.Verifier
	Env     commands.Env
	Log     *log.Logger

	pollNow chan struct{}
	mu      sync.Mutex
	authErr bool
	refused string
}

// Open loads the enrolled agent from its folder.
func Open(version string, logger *log.Logger) (*Agent, error) {
	st, err := state.Load()
	if err != nil {
		return nil, err
	}
	kp, err := state.Path(state.KeyFile)
	if err != nil {
		return nil, err
	}
	key, err := keys.Load(kp)
	if err != nil {
		return nil, err
	}
	access, err := LoadAccess()
	if err != nil {
		return nil, err
	}
	ck, err := proto.B64.DecodeString(st.CommandKey)
	if err != nil || len(ck) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("agent.json: command_key is not a 32-byte Ed25519 key")
	}
	dir, err := state.Dir()
	if err != nil {
		return nil, err
	}
	sp, err := spool.Open(dir + "/" + state.SpoolDir)
	if err != nil {
		return nil, err
	}
	seenPath, _ := state.Path(state.SeenFile)
	cl := client.New(st.Server, st.Agent, key, access, version)
	a := &Agent{
		State: st, Key: key, Client: cl, Spool: sp, Log: logger,
		Collect: collect.New(collect.Options{HideProcs: st.HideProcs}),
		Env:     commands.Env{Version: version, WolTargets: st.WolTargets, WolBroadcast: st.WolBroadcast},
		pollNow: make(chan struct{}, 1),
	}
	a.Verify = &commands.Verifier{Agent: st.Agent, Key: ed25519.PublicKey(ck), Seen: commands.OpenSeen(seenPath),
		Now: func() time.Time { return time.Now().Add(cl.Skew()) }}
	return a, nil
}

// LoadAccess reads the optional Access service token.
func LoadAccess() (*client.Access, error) {
	p, err := state.Path(state.AccessFile)
	if err != nil {
		return nil, err
	}
	b, err := secret.ReadFile(p)
	if err != nil || b == nil {
		return nil, err
	}
	var a client.Access
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, fmt.Errorf("access token file: %w", err)
	}
	return &a, nil
}

// Sample collects once, stamps the agent's own health on the host record and spools it.
func (a *Agent) Sample(ctx context.Context) {
	recs := a.Collect.Collect(ctx)
	for i := range recs {
		if recs[i].Kind == "metrics.host" {
			recs[i].Data["agentVersion"] = a.Env.Version
			recs[i].Data["spool"] = a.Spool.Len()
		}
	}
	if err := a.Spool.Append(recs...); err != nil {
		a.Log.Printf("spool: %v", err)
	}
}

// Flush sends spooled batches until the spool is empty or a request fails.
func (a *Agent) Flush(ctx context.Context) error {
	for {
		recs, commit, err := a.Spool.Batch()
		if err != nil {
			return err
		}
		if len(recs) == 0 {
			return nil
		}
		r, err := a.Client.Ingest(ctx, recs)
		a.noteAuth(err)
		if err != nil {
			return err
		}
		if err := commit(); err != nil {
			return err
		}
		a.noteRefused(r.Refused)
		if r.Commands.String() != "" && r.Commands.String() != "0" {
			select {
			case a.pollNow <- struct{}{}:
			default:
			}
		}
	}
}

// Poll fetches and runs queued commands.
func (a *Agent) Poll(ctx context.Context) error {
	cmds, err := a.Client.Commands(ctx)
	a.noteAuth(err)
	if err != nil {
		return err
	}
	for _, c := range cmds {
		if err := a.Verify.Execute(ctx, a.Client, c, a.Env); err != nil {
			a.Log.Printf("command %s %s: %v", c.ID, c.Op, err)
		} else {
			a.Log.Printf("command %s %s: done", c.ID, c.Op)
		}
	}
	return nil
}

// noteRefused logs when the dashboard starts dropping kinds of records this agent sends.
func (a *Agent) noteRefused(kinds []string) {
	k := strings.Join(kinds, ", ")
	a.mu.Lock()
	defer a.mu.Unlock()
	if k != a.refused && k != "" {
		a.Log.Printf("the dashboard drops these kinds from this agent: %s", k)
	}
	a.refused = k
}

func (a *Agent) noteAuth(err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	was := a.authErr
	a.authErr = client.IsAuth(err)
	if a.authErr && !was {
		a.Log.Printf("the dashboard refuses this agent (not approved yet, revoked, or clock off by more than 2 min): %v", err)
	}
	if was && err == nil {
		a.Log.Printf("the dashboard accepts this agent again")
	}
}

// Run loops until ctx ends.
func (a *Agent) Run(ctx context.Context) {
	interval := time.Duration(a.State.IntervalS) * time.Second
	poll := time.Duration(a.State.PollS) * time.Second
	a.Log.Printf("edge-agent %s: %s as %s, every %s", a.Env.Version, a.State.Server, a.State.Agent, interval)

	go func() { // sampling never waits on the network
		for {
			a.Sample(ctx)
			select {
			case <-ctx.Done():
				return
			case <-time.After(interval):
			}
		}
	}()

	backoff := time.Duration(0)
	nextFlush, nextPoll := time.Now().Add(2*time.Second), time.Now().Add(3*time.Second)
	for {
		now := time.Now()
		if !now.Before(nextFlush) {
			if err := a.Flush(ctx); err != nil {
				backoff = next(backoff)
				if !client.IsAuth(err) {
					a.Log.Printf("send: %v (retry in %s)", err, backoff.Round(time.Second))
				}
				nextFlush = now.Add(backoff)
			} else {
				backoff = 0
				nextFlush = now.Add(interval)
			}
		}
		if !now.Before(nextPoll) {
			if err := a.Poll(ctx); err != nil && !client.IsAuth(err) {
				a.Log.Printf("commands: %v", err)
			}
			nextPoll = now.Add(poll)
		}
		wait := time.Until(nextFlush)
		if w := time.Until(nextPoll); w < wait {
			wait = w
		}
		select {
		case <-ctx.Done():
			return
		case <-a.pollNow:
			nextPoll = time.Now()
		case <-time.After(max(wait, 100*time.Millisecond)):
		}
	}
}

// next doubles the back-off up to 5 minutes, with jitter.
func next(d time.Duration) time.Duration {
	if d == 0 {
		d = 5 * time.Second
	} else {
		d *= 2
	}
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}
