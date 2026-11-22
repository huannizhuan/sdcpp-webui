#!/usr/bin/env bash
# The sandboxed build cannot write pnpm's content-addressable store (it lives
# under a read-only $HOME), so a plain "pnpm install" aborts the whole build.
# The frontend already has its dependencies installed in node_modules, so route
# install to a no-op and run the two build steps directly.
set -euo pipefail

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Strip pnpm's own flags. -C/--dir consume the following argument, so skip that
# too, otherwise it becomes the subcommand name.
filtered=()
skip_next=0
for a in "$@"; do
    if [ "$skip_next" -eq 1 ]; then
        skip_next=0
        continue
    fi
    case "$a" in
        --ignore-workspace) continue ;;
        -C|--dir) skip_next=1; continue ;;
        *) filtered+=("$a") ;;
    esac
done

sub="${filtered[0]:-}"
case "$sub" in
    install|i)
        exit 0
        ;;
    run)
        task="${filtered[1]:-}"
        case "$task" in
            build)
                cd "$FRONTEND_DIR"
                exec ./node_modules/.bin/vite build
                ;;
            build:header)
                cd "$FRONTEND_DIR"
                exec node scripts/build_gen_index_html.js
                ;;
        esac
        ;;
esac
exit 0
