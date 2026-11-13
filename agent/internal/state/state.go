// Package state is the agent's folder and its settings file.
//
//	macOS    ~/Library/Application Support/edge-agent   (LaunchAgent, runs as the user)
//	Windows  %ProgramData%\edge-agent                   (service account + Administrators only, see install.ps1)
//	other    ~/.local/state/edge-agent                  (Linux, as the user)
//
// EDGE_AGENT_HOME overrides the folder (tests, a second agent on one machine).
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Files inside the folder.
const (
	KeyFile    = "identity.key" // the Ed25519 private key (keys package)
	StateFile  = "agent.json"   // State below
	AccessFile = "access.secret"
	SpoolDir   = "spool"
	SeenFile   = "commands-seen.json"
)

// State is everything the agent remembers that is not a secret.
type State struct {
	Server      string `json:"server"`      // https://home.example.com: your dashboard
	Agent       string `json:"agent"`       // ag_gaming-pc
	Fingerprint string `json:"fingerprint"` // what an admin compared at approval
	// CommandKey is the Worker's Ed25519 public key (base64url, 32 bytes), pinned at enrolment.
	CommandKey string `json:"command_key"`
	EnrolledAt int64  `json:"enrolled_at"` // Unix ms

	// Settings (edit the file, then restart the agent).
	IntervalS    int               `json:"interval_s"`     // seconds between samples, default 60
	PollS        int               `json:"poll_s"`         // seconds between command polls, default 30
	HideProcs    bool              `json:"hide_processes"` // true: never send process names
	WolTargets   map[string]string `json:"wol_targets"`    // pc.wake targets on a hub agent: name -> MAC
	WolBroadcast string            `json:"wol_broadcast"`  // the home network's broadcast address; default: limited broadcast only
}

// Defaults fills unset settings.
func (s *State) Defaults() {
	if s.IntervalS <= 0 {
		s.IntervalS = 60
	}
	if s.IntervalS < 15 {
		s.IntervalS = 15
	}
	if s.PollS <= 0 {
		s.PollS = 30
	}
	if s.PollS < 10 {
		s.PollS = 10
	}
}

// Dir is the agent's folder, created 0700 if missing.
func Dir() (string, error) {
	d := os.Getenv("EDGE_AGENT_HOME")
	if d == "" {
		switch runtime.GOOS {
		case "windows":
			pd := os.Getenv("ProgramData")
			if pd == "" {
				pd = `C:\ProgramData`
			}
			d = filepath.Join(pd, "edge-agent")
		case "darwin":
			h, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			d = filepath.Join(h, "Library", "Application Support", "edge-agent")
		default:
			h, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			d = filepath.Join(h, ".local", "state", "edge-agent")
		}
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	return d, nil
}

// Path joins name onto the agent's folder.
func Path(name string) (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, name), nil
}

// ErrNotEnrolled means agent.json is missing.
var ErrNotEnrolled = errors.New("not enrolled yet: run `edge-agent enrol`")

// Load reads agent.json and applies defaults.
func Load() (*State, error) {
	p, err := Path(StateFile)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotEnrolled
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	s.Defaults()
	if err := s.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	return &s, nil
}

// Save writes agent.json atomically (0600).
func (s *State) Save() error {
	p, err := Path(StateFile)
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Validate refuses settings that would send data somewhere unexpected.
func (s *State) Validate() error {
	if !strings.HasPrefix(s.Server, "https://") && !strings.HasPrefix(s.Server, "http://127.0.0.1") && !strings.HasPrefix(s.Server, "http://localhost") {
		return fmt.Errorf("server must be https:// (got %q)", s.Server)
	}
	if strings.TrimRight(s.Server, "/") != s.Server || strings.Count(s.Server, "/") > 2 {
		return fmt.Errorf("server must be scheme://host[:port] with no path (got %q)", s.Server)
	}
	return nil
}
