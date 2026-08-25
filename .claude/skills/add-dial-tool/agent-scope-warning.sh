#!/bin/sh
# The consent text shown before the agent-scope question, in ONE place.
#
# Two skills ask that question: this one, standalone from a real terminal, and
# /add-dial, which hoists it because a nested step's stdout is a pipe and clack
# cannot echo into it. Both render this file through `nc:run capture:` so the
# wording cannot drift between them — edit it here and both change.
#
# $1 is the rendered agent-group list ("ag-… (Name), ag-… (Name)").
set -eu
printf 'Agents on this install: %s. Giving an agent Dial lets it text and call any number and buy numbers, billed to your Dial account. Agents you leave out are blocked at the gateway (reversible by running /add-dial-tool again). Agents created after this run have Dial until the next run.' "$1"
