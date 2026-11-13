package commands

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// The allow-list (v1). Names and tiers are the same as in modules/edge-agents/ops.ts.
//
//	agent.ping          safe         any agent         version, OS, architecture
//	pc.shutdown         destructive  Windows           shutdown.exe /s /t <delay_s>   (delay_s 10..300, default 10)
//	pc.cancel_shutdown  safe         Windows           shutdown.exe /a
//	pc.wake             safe         an agent with wol_targets   Wake-on-LAN to a target named in this machine's agent.json
func init() {
	register(Op{Name: "agent.ping", Tier: "safe", Available: func(Env) bool { return true },
		Run: func(_ context.Context, env Env, args map[string]any) (any, error) {
			if err := onlyKeys(args); err != nil {
				return nil, err
			}
			return map[string]any{"version": env.Version, "os": runtime.GOOS, "arch": runtime.GOARCH,
				"time": time.Now().UnixMilli()}, nil
		}})

	register(Op{Name: "pc.shutdown", Tier: "destructive", Available: func(Env) bool { return runtime.GOOS == "windows" },
		Run: func(ctx context.Context, _ Env, args map[string]any) (any, error) {
			if err := onlyKeys(args, "delay_s"); err != nil {
				return nil, err
			}
			d, err := intArg(args, "delay_s", 10, 10, 300)
			if err != nil {
				return nil, err
			}
			if err := shutdown(ctx, d); err != nil {
				return nil, err
			}
			return map[string]any{"shutdown_in_s": d}, nil
		}})

	register(Op{Name: "pc.cancel_shutdown", Tier: "safe", Available: func(Env) bool { return runtime.GOOS == "windows" },
		Run: func(ctx context.Context, _ Env, args map[string]any) (any, error) {
			if err := onlyKeys(args); err != nil {
				return nil, err
			}
			if err := cancelShutdown(ctx); err != nil {
				return nil, err
			}
			return map[string]any{"cancelled": true}, nil
		}})

	register(Op{Name: "pc.wake", Tier: "safe", Available: func(e Env) bool { return len(e.WolTargets) > 0 },
		Run: func(_ context.Context, env Env, args map[string]any) (any, error) {
			if err := onlyKeys(args, "target"); err != nil {
				return nil, err
			}
			t, err := stringArg(args, "target")
			if err != nil {
				return nil, err
			}
			mac, ok := env.WolTargets[t]
			if !ok {
				return nil, refuse("unknown wake target %q", t)
			}
			sent, err := wake(mac, env.WolBroadcast)
			if err != nil {
				return nil, err
			}
			return map[string]any{"target": t, "packets": sent}, nil
		}})
}

var macRe = regexp.MustCompile(`^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$`)

// MagicPacket is 6 x 0xFF followed by the MAC 16 times (102 bytes).
func MagicPacket(mac string) ([]byte, error) {
	if !macRe.MatchString(mac) {
		return nil, fmt.Errorf("not a MAC address: %q", mac)
	}
	hw, err := net.ParseMAC(normMAC(mac))
	if err != nil {
		return nil, err
	}
	p := make([]byte, 0, 102)
	for i := 0; i < 6; i++ {
		p = append(p, 0xff)
	}
	for i := 0; i < 16; i++ {
		p = append(p, hw...)
	}
	return p, nil
}

func normMAC(m string) string {
	m = strings.NewReplacer(":", "", "-", "").Replace(m)
	var parts []string
	for i := 0; i < 12; i += 2 {
		parts = append(parts, m[i:i+2])
	}
	return strings.Join(parts, ":")
}

// wake sends the magic packet to the limited broadcast and, if set, the LAN's directed broadcast, on ports 9 and 7.
func wake(mac, broadcast string) (int, error) {
	pkt, err := MagicPacket(mac)
	if err != nil {
		return 0, err
	}
	targets := []string{"255.255.255.255"}
	if ip := net.ParseIP(broadcast); ip != nil && ip.To4() != nil {
		targets = append(targets, ip.String())
	}
	sent := 0
	var last error
	for _, t := range targets {
		for _, port := range []string{"9", "7"} {
			conn, err := net.Dial("udp4", net.JoinHostPort(t, port))
			if err != nil {
				last = err
				continue
			}
			if _, err := conn.Write(pkt); err == nil {
				sent++
			} else {
				last = err
			}
			conn.Close()
		}
	}
	if sent == 0 {
		return 0, fmt.Errorf("no packet sent: %v", last)
	}
	return sent, nil
}
