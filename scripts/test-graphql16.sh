#!/usr/bin/env bash
# Runs the tests that exercise graphql against graphql 16, the oldest major @stackables/bridge-graphql supports.
# The repo develops on graphql 17 (the `graphql` override in pnpm-workspace.yaml); this installs 16 for the run
# and puts the workspace file and the lock file back afterwards, also when a test fails.
set -euo pipefail

cd "$(dirname "$0")/.."
GRAPHQL_16="${GRAPHQL_16:-16.14.2}"

backup="$(mktemp -d)"
cp pnpm-workspace.yaml pnpm-lock.yaml "$backup"
restore() {
  cp "$backup/pnpm-workspace.yaml" "$backup/pnpm-lock.yaml" .
  rm -rf "$backup"
  pnpm install --frozen-lockfile
}
trap restore EXIT

sed -i.bak "s/^  graphql: .*/  graphql: $GRAPHQL_16/" pnpm-workspace.yaml
rm -f pnpm-workspace.yaml.bak
pnpm install --no-frozen-lockfile

version="$(node -p "require('./packages/bridge-graphql/node_modules/graphql/package.json').version")"
echo "Testing against graphql $version"
case "$version" in
  16.*) ;;
  *) echo "expected graphql 16, got $version" >&2; exit 1 ;;
esac

pnpm --filter @stackables/bridge-graphql --filter @stackables/bridge test
