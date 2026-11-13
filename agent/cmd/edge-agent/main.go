// edge-agent sends this computer's numbers (processor, memory, disk, temperature) to your home dashboard and runs
// the few commands compiled into it. It only ever calls out; nothing on this machine listens.
//
//	edge-agent enrol --server https://home.example.com --id ag_gaming-pc --code ABCD-EF23
//	edge-agent run        the loop (what the installed service runs)
//	edge-agent collect    print one sample and send nothing
//	edge-agent status     what this agent is, where it sends, what it may be asked to do
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"edge-agent/internal/agent"
	"edge-agent/internal/client"
	"edge-agent/internal/collect"
	"edge-agent/internal/commands"
	"edge-agent/internal/keys"
	"edge-agent/internal/proto"
	"edge-agent/internal/secret"
	"edge-agent/internal/service"
	"edge-agent/internal/state"
)

// version is set at build time: go build -ldflags "-X main.version=0.1.0"
var version = "dev"

const usage = `edge-agent ` + "%s" + `

  edge-agent enrol --server https://<your dashboard> --id ag_<name> --code <one-time code>
             [--wol name=MAC ...] [--broadcast <broadcast address>]
  edge-agent run
  edge-agent collect
  edge-agent status

The Access service token for this machine is read at enrolment from the environment variables
EDGE_AGENT_ACCESS_ID and EDGE_AGENT_ACCESS_SECRET, or asked for. It is stored in the agent's folder,
readable only by the agent.
`

func main() {
	logger := log.New(os.Stderr, "", log.LstdFlags)
	if service.IsService() {
		if err := service.Run("edge-agent", func(ctx context.Context) { runLoop(ctx, logger) }); err != nil {
			logger.Fatal(err)
		}
		return
	}
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "enrol", "enroll":
		err = enrol(os.Args[2:])
	case "run":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		err = runLoop(ctx, logger)
	case "collect":
		err = collectOnce()
	case "status":
		err = status()
	case "version", "--version":
		fmt.Println(version)
	default:
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "edge-agent:", err)
		os.Exit(1)
	}
}

func runLoop(ctx context.Context, logger *log.Logger) error {
	a, err := agent.Open(version, logger)
	if err != nil {
		return err
	}
	a.Run(ctx)
	return nil
}

type wolFlag map[string]string

func (w wolFlag) String() string { return "" }
func (w wolFlag) Set(v string) error {
	name, mac, ok := strings.Cut(v, "=")
	if !ok || name == "" {
		return errors.New("use --wol name=MAC")
	}
	if _, err := commands.MagicPacket(mac); err != nil {
		return err
	}
	w[name] = mac
	return nil
}

var agentID = regexp.MustCompile(`^ag_[a-z0-9-]{3,40}$`)

func ask(in *bufio.Reader, prompt string) string {
	fmt.Fprint(os.Stderr, prompt)
	line, _ := in.ReadString('\n')
	return strings.TrimSpace(line)
}

func enrol(args []string) error {
	fs := flag.NewFlagSet("enrol", flag.ExitOnError)
	server := fs.String("server", "", "your dashboard, https://host")
	id := fs.String("id", "", "this computer's id from the dashboard, ag_<name>")
	code := fs.String("code", "", "the one-time code from the dashboard")
	broadcast := fs.String("broadcast", "", "the home network's broadcast address, for pc.wake (optional)")
	wol := wolFlag{}
	fs.Var(wol, "wol", "a computer this one may wake: name=MAC (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	in := bufio.NewReader(os.Stdin)
	if *server == "" {
		*server = ask(in, "Dashboard address (https://…): ")
	}
	if *id == "" {
		*id = ask(in, "This computer's id (ag_…): ")
	}
	if *code == "" {
		*code = ask(in, "One-time code: ")
	}
	st := &state.State{Server: strings.TrimRight(*server, "/"), Agent: *id, WolTargets: wol, WolBroadcast: *broadcast}
	st.Defaults()
	if err := st.Validate(); err != nil {
		return err
	}
	if !agentID.MatchString(st.Agent) {
		return fmt.Errorf("the id looks like ag_gaming-pc (got %q)", st.Agent)
	}
	access := &client.Access{ID: os.Getenv("EDGE_AGENT_ACCESS_ID"), Secret: os.Getenv("EDGE_AGENT_ACCESS_SECRET")}
	if access.ID == "" {
		access.ID = ask(in, "Access service token, Client ID (empty if none): ")
		if access.ID != "" {
			access.Secret = ask(in, "Access service token, Client Secret: ")
		}
	}
	kp, err := state.Path(state.KeyFile)
	if err != nil {
		return err
	}
	key, err := keys.Create(kp)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	r, err := client.New(st.Server, st.Agent, key, access, version).Enrol(ctx, strings.ToUpper(strings.TrimSpace(*code)))
	if err != nil {
		os.Remove(kp) // nothing was enrolled: the next try makes a fresh key
		return fmt.Errorf("the dashboard did not accept the enrolment: %w", err)
	}
	ck, err := proto.B64.DecodeString(r.CommandKey.X)
	if err != nil || len(ck) != 32 || r.CommandKey.Alg != "ed25519" {
		os.Remove(kp)
		return errors.New("the dashboard's reply carried no usable command key")
	}
	st.Fingerprint, st.CommandKey, st.EnrolledAt = proto.Fingerprint(key.PublicRaw()), r.CommandKey.X, time.Now().UnixMilli()
	if r.Fingerprint != st.Fingerprint {
		os.Remove(kp)
		return errors.New("the dashboard stored a different key than this machine made: stop, and check the address")
	}
	if access.ID != "" {
		b, _ := json.Marshal(access)
		ap, _ := state.Path(state.AccessFile)
		if err := secret.WriteFile(ap, b); err != nil {
			return err
		}
	}
	if err := st.Save(); err != nil {
		return err
	}
	fmt.Printf("Enrolled as %s.\n\nFingerprint:  %s\n\nIn the dashboard, open Settings > Edge agents. Approve this computer only if the\nfingerprint shown there is exactly the one above. Until then the dashboard refuses it.\n", st.Agent, st.Fingerprint)
	return nil
}

func collectOnce() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := collect.New(collect.Options{})
	c.Collect(ctx) // the first sample only sets the counters the processor load is measured against
	time.Sleep(time.Second)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(c.Collect(ctx))
}

func status() error {
	st, err := state.Load()
	if err != nil {
		return err
	}
	kp, _ := state.Path(state.KeyFile)
	key, err := keys.Load(kp)
	if err != nil {
		return err
	}
	dir, _ := state.Dir()
	access, _ := agent.LoadAccess()
	fmt.Printf("edge-agent %s\n  agent        %s\n  sends to     %s\n  fingerprint  %s\n  key          %s\n  folder       %s\n  Access token %v\n  every        %d s\n  commands     %s\n",
		version, st.Agent, st.Server, proto.Fingerprint(key.PublicRaw()), key.Backend(), dir, access != nil,
		st.IntervalS, strings.Join(commands.Ops(commands.Env{Version: version, WolTargets: st.WolTargets}), ", "))
	return nil
}
