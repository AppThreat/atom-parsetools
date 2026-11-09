#!/bin/sh
# Placeholder: one-time setup of the npm packages that carry parsa (@appthreat/parsa-<os>-<cpu>), so
# that .github/workflows/parsa-release.yml can publish them through npm trusted publishing (OIDC,
# no token in the repository). Run it once, by a maintainer of the @appthreat npm organisation,
# before the first release that ships the packages. Review each step before running it; nothing
# here runs in CI.
#
#   sh parsa/scripts/setup-npm-trusted-publishing.sh            # show what would be done
#   sh parsa/scripts/setup-npm-trusted-publishing.sh --apply    # do it
#
# npm configures a trusted publisher only for a package that exists, so a package that is not on
# the registry yet gets a placeholder first: version 0.0.0-placeholder.<UTC timestamp>, a README and
# nothing else, published from your own login and deprecated at once. The version is new on every
# run because npm never accepts a version twice, not even one that was only staged or unpublished.
# When npm stages the publish for later approval instead of completing it, the script stops and
# names the `npm stage` commands to finish it; run the script again afterwards. npm points `latest`
# at the first version of a package, so `latest` names the placeholder until a final release
# replaces it; @appthreat/atom-parsetools depends on exact versions and never resolves it.
#
# Then each package gets a trusted publisher with these values, set with `npm trust github`
# (npm 11.10 and later) or on https://www.npmjs.com/package/<name>/access:
#   publisher:          GitHub Actions
#   organization/user:  AppThreat
#   repository:         atom-parsetools
#   workflow filename:  parsa-release.yml
#   environment:        (leave empty)
# Once a release has published through it, set "Require two-factor authentication and disallow
# tokens" under each package's publishing access.
#
# Requirements: npm 11.5.1 or later (11.10 or later for `npm trust`), and `npm login` as an owner
# of the @appthreat scope with two-factor authentication; npm asks for a one-time password.
set -eu

apply=false
[ "${1:-}" = "--apply" ] && apply=true

here=$(cd "$(dirname "$0")" && pwd)
repo=AppThreat/atom-parsetools
workflow=parsa-release.yml
placeholder="0.0.0-placeholder.$(date -u +%Y%m%d%H%M%S)"

run() {
  if $apply; then
    echo "+ $*"
    "$@"
  else
    echo "would run: $*"
  fi
}

npm_version=$(npm --version)
case "$npm_version" in
  1[2-9].*|11.[6-9]*|11.[1-9][0-9]*|11.5.[1-9]*) ;;
  *) echo "npm $npm_version is too old for trusted publishing; npm 11.5.1 or later is needed" >&2; exit 1 ;;
esac
if $apply; then
  who=$(npm whoami 2>/dev/null) || { echo "run npm login first" >&2; exit 1; }
  echo "logged in to npm as $who"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/parsa-npm-setup.XXXXXX")
trap 'rm -rf "$work"' EXIT

for name in $(node "$here/npm-packages.mjs" names); do
  echo ""
  echo "== $name"
  if npm view "$name" name >/dev/null 2>&1; then
    echo "already on the registry"
  else
    dir="$work/$(echo "$name" | tr '/@' '__')"
    mkdir -p "$dir"
    cat > "$dir/package.json" <<EOF
{
  "name": "$name",
  "version": "$placeholder",
  "description": "Placeholder for the parsa binary of @appthreat/atom-parsetools; real versions are published from GitHub Actions.",
  "repository": { "type": "git", "url": "git+https://github.com/$repo.git", "directory": "parsa" },
  "license": "MIT",
  "files": ["README.md"]
}
EOF
    printf '# %s\n\nReserved for the parsa binary of @appthreat/atom-parsetools. Install @appthreat/atom-parsetools instead.\n' "$name" > "$dir/README.md"
    run sh -c "cd '$dir' && npm publish --access public --tag placeholder"
    # the registry can take a few seconds to show a new version
    tries=0
    while $apply && ! npm view "$name@$placeholder" version >/dev/null 2>&1 && [ "$tries" -lt 5 ]; do
      tries=$((tries + 1))
      sleep 3
    done
    if $apply && ! npm view "$name@$placeholder" version >/dev/null 2>&1; then
      echo "$name@$placeholder is not on the registry yet; if npm staged it, finish with:" >&2
      echo "  npm stage list $name" >&2
      echo "  npm stage approve <stage-id>" >&2
      echo "then run this script again" >&2
      exit 1
    fi
    run npm deprecate "$name@$placeholder" "placeholder; install @appthreat/atom-parsetools"
  fi
  if npm trust --help >/dev/null 2>&1; then
    if npm trust list "$name" 2>/dev/null | grep -q "$workflow"; then
      echo "trusted publisher for $workflow already set"
    else
      run npm trust github "$name" --file "$workflow" --repo "$repo" --allow-publish --yes
    fi
  else
    echo "this npm has no 'npm trust'; configure the trusted publisher on https://www.npmjs.com/package/$name/access"
    echo "  GitHub Actions, AppThreat / atom-parsetools, workflow $workflow, no environment"
  fi
done

echo ""
$apply || echo "nothing was changed; rerun with --apply"
