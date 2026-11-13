//go:build windows

// Package service lets the agent run as a Windows service (install.ps1 creates it as NT SERVICE\edge-agent).
package service

import (
	"context"

	"golang.org/x/sys/windows/svc"
)

// IsService reports whether the Windows service manager started this process.
func IsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

type handler struct{ run func(context.Context) }

func (h handler) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.run(ctx); close(done) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		case <-done:
			cancel()
			return false, 0
		}
	}
}

// Run serves the service until Windows stops it.
func Run(name string, run func(context.Context)) error { return svc.Run(name, handler{run: run}) }
