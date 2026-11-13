//go:build !windows

package commands

import (
	"context"
	"errors"
)

// Only the Windows agent may power off its machine (the Mac agents run without root).
var errNotHere = errors.New("not available on this OS")

func shutdown(context.Context, int64) error { return errNotHere }
func cancelShutdown(context.Context) error  { return errNotHere }
