//go:build !windows

// Package service: on macOS the agent runs as a LaunchAgent (launchd keeps it alive), so there is nothing to do.
package service

import (
	"context"
	"errors"
)

// IsService is always false outside Windows.
func IsService() bool { return false }

// Run is never called outside Windows.
func Run(string, func(context.Context)) error { return errors.New("not a Windows service") }
